#!/bin/bash
# Optional development harness: start, stop and inspect the disposable loopback
# services a live test of this companion needs. The plugin never runs this file
# and nothing starts by itself; you run it, for a test, with the paths you choose.
#
# usage: services.sh start|stop|status
#
# COBALT_HARNESS_RUN       absolute directory for pid files and logs (required, created)
# A service is managed only when its own variable is set:
#   OBSCURA_RUNTIME        directory holding the `obscura` binary -> "browser",
#                          launched with the README's confinement recipe
#                          (pasta and bubblewrap required)
#   COBALT_HARNESS_SITE    directory to serve as a static site -> "web"
#   COBALT_HARNESS_MODELS  Ollama model directory -> "inference", a CPU-only,
#                          no-cloud model server for a local Hindsight service
# Ports (loopback): COBALT_HARNESS_CDP 9222, COBALT_HARNESS_PROXY 18080,
#   COBALT_HARNESS_WEB 18181, COBALT_HARNESS_LLM 11437.
# COBALT_HARNESS_PRIVATE_NETWORK=1 adds Obscura's --allow-private-network, for
#   an allowlisted origin on loopback only (see the README before using it).
#
# `stop` ends exactly the processes `start` recorded and reports success only
# after every one of them has been seen to exit. It never selects a process by
# name or command line, so a browser someone else started is never touched.
set -u
RUN="${COBALT_HARNESS_RUN:-}"
CDP="${COBALT_HARNESS_CDP:-9222}" PROXY="${COBALT_HARNESS_PROXY:-18080}"
WEB="${COBALT_HARNESS_WEB:-18181}" LLM="${COBALT_HARNESS_LLM:-11437}"

# Kernel start time of a live process, empty for a missing or zombie one. With
# the pid it names one process for good, so a reused pid is never mistaken.
started() {
  local rest
  rest=$(sed 's/.*) //' "/proc/$1/stat" 2>/dev/null) || return 0
  set -- $rest
  [ "${1:-Z}" = Z ] || echo "${20:-}"
}

# Read a service's pid file into LEADER, BEGUN and TOKEN. Returns 1 when there
# is none, and 2 when it is not one this script wrote ("pid start token"): an
# older or hand-made file names processes this script cannot identify, so it is
# never acted on and never deleted.
record() {
  LEADER="" BEGUN="" TOKEN=""
  [ -f "$RUN/$1.pid" ] || return 1
  read -r LEADER BEGUN TOKEN <"$RUN/$1.pid" || true
  case "$LEADER$BEGUN" in ''|*[!0-9]*) return 2 ;; esac
  [ -n "$BEGUN" ] && [ -n "$TOKEN" ] && [ "$LEADER" -gt 1 ] || return 2
}

# Every live process of a service as "pid:start" words, deepest first.
# A process belongs to the service only by what start_one recorded: the leader
# by its pid and start time, a member of the leader's process group by the token
# start_one put in its environment, and anything descended from those. Nothing
# is ever matched by name or command line, so another browser is never touched.
# The group walk matters once the leader is gone: pasta exits on TERM without
# ending the namespace it made, and what it leaves behind keeps its group.
members() {
  local pid begun out="" seen=" "
  local -a queue=()
  record "$1" || return 0
  [ "$(started "$LEADER")" = "$BEGUN" ] && queue+=("$LEADER")
  for pid in $(pgrep -g "$LEADER" 2>/dev/null); do
    # The wrapper's own environment is unreadable; it is held by its start time above.
    { tr '\0' '\n' <"/proc/$pid/environ" | grep -qxF "COBALT_HARNESS_SERVICE=$TOKEN"; } 2>/dev/null && queue+=("$pid")
  done
  while [ "${#queue[@]}" -gt 0 ]; do
    pid=${queue[0]}; queue=("${queue[@]:1}")
    case "$seen" in *" $pid "*) continue ;; esac
    seen="$seen$pid "
    begun=$(started "$pid")
    [ -n "$begun" ] || continue
    out="$pid:$begun $out"
    queue+=($(pgrep -P "$pid" 2>/dev/null))
  done
  echo "$out"
}

# With the leader gone, the processes still in its group whose environment
# cannot be read: they may be this service's or someone else's, and this script
# will not guess. Empty while the leader lives, since its descendants are known.
opaque() {
  local pid out=""
  record "$1" || return 0
  [ "$(started "$LEADER")" = "$BEGUN" ] && return 0
  for pid in $(pgrep -g "$LEADER" 2>/dev/null); do
    { : <"/proc/$pid/environ"; } 2>/dev/null || out="$out$pid "
  done
  echo "$out"
}

alive() { [ -n "$(members "$1")" ]; }

# The "pid:start" words of $1 that still name a live process.
surviving() {
  local row out=""
  for row in $1; do [ "$(started "${row%%:*}")" = "${row##*:}" ] && out="$out$row "; done
  echo "$out"
}

# Send signal $1 to the process a "pid:start" word names, only while that pid is
# still that process.
signal() { [ "$(started "${2%%:*}")" = "${2##*:}" ] && kill "-$1" "${2%%:*}" 2>/dev/null; }

# Wait up to five seconds for the given processes and the service's current
# members to exit; print whatever is still running.
settle() {
  local name=$1 known=$2 left="" tick
  for tick in $(seq 50); do
    left=$(printf '%s\n' $(surviving "$known") $(members "$name") | sort -u | tr '\n' ' ')
    [ -z "${left// /}" ] && return 0
    sleep 0.1
  done
  echo "$left"
}

start_one() {
  local name=$1 token state pid; shift
  record "$name"; state=$?
  if [ "$state" -eq 2 ]; then echo "$name: pid file is not one this script wrote; not started, file kept" >&2; return 1; fi
  if alive "$name"; then echo "$name already running (pid $LEADER)"; return; fi
  token="$name-$$-$RANDOM$RANDOM"
  COBALT_HARNESS_SERVICE="$token" setsid nohup "$@" >"$RUN/$name.log" 2>&1 </dev/null &
  pid=$!
  echo "$pid $(started "$pid") $token" >"$RUN/$name.pid"
  # A command that is missing, or whose port is taken, exits at once. Say so
  # and leave no pid file behind, instead of reporting a start that did not last.
  sleep 0.3
  if ! alive "$name"; then
    rm -f "$RUN/$name.pid"
    echo "$name failed to start; last lines of $RUN/$name.log:" >&2
    tail -n 5 "$RUN/$name.log" >&2
    return 1
  fi
  echo "$name started (pid $pid)"
}

# Stop a service and say "stopped" only once every one of its processes has
# been seen to exit. TERM goes to the whole tree, deepest first: the browser's
# outer bwrap is PID 1 of the namespace pasta creates and has no TERM handler,
# so the kernel discards a TERM sent to it from here, and its inner processes
# sit in their own session where a group signal never arrives. Ending the leaf
# unwinds the wrappers in order. KILL follows for anything left: it is the one
# signal a namespace's PID 1 cannot refuse, and it takes the namespace with it.
stop_one() {
  local name=$1 known left row count=0 state unsure
  record "$name"; state=$?
  if [ "$state" -eq 1 ]; then echo "$name not running"; return 0; fi
  if [ "$state" -eq 2 ]; then echo "$name: pid file is not one this script wrote; nothing signalled, file kept" >&2; return 1; fi
  known=$(members "$name")
  if [ -z "${known// /}" ]; then
    unsure=$(opaque "$name")
    if [ -n "${unsure// /}" ]; then
      echo "$name: cannot tell whether ${unsure}belongs to it; nothing signalled, pid file kept" >&2
      return 1
    fi
    echo "$name not running"; rm -f "$RUN/$name.pid"; return 0
  fi
  for row in $known; do signal TERM "$row"; count=$((count + 1)); done
  left=$(settle "$name" "$known")
  if [ -n "${left// /}" ]; then
    known="$known $left"
    for row in $left; do signal KILL "$row"; done
    left=$(settle "$name" "$known")
  fi
  if [ -n "${left// /}" ]; then
    echo "$name FAILED to stop; still running: $(for row in $left; do printf '%s ' "${row%%:*}"; done)" >&2
    return 1
  fi
  echo "$name stopped (pid $LEADER, $count processes, all exited)"
  rm -f "$RUN/$name.pid"
}

# The services this run was asked to manage, in start order.
configured() {
  [ -n "${COBALT_HARNESS_MODELS:-}" ] && echo inference
  [ -n "${COBALT_HARNESS_SITE:-}" ] && echo web
  [ -n "${OBSCURA_RUNTIME:-}" ] && echo browser
  return 0
}

launch() {
  local -a private=()
  case "$1" in
    inference)
      start_one inference env OLLAMA_HOST="127.0.0.1:$LLM" OLLAMA_MODELS="$COBALT_HARNESS_MODELS" OLLAMA_NO_CLOUD=1 OLLAMA_VULKAN=0 \
          CUDA_VISIBLE_DEVICES=-1 ROCR_VISIBLE_DEVICES=-1 GGML_VK_VISIBLE_DEVICES=-1 \
          OLLAMA_NUM_PARALLEL=1 OLLAMA_KEEP_ALIVE=5m ollama serve ;;
    web)
      start_one web python3 -m http.server "$WEB" --bind 127.0.0.1 --directory "$COBALT_HARNESS_SITE" ;;
    browser)
      [ "${COBALT_HARNESS_PRIVATE_NETWORK:-}" = 1 ] && private=(--allow-private-network)
      start_one browser pasta --quiet --foreground --config-net --splice-only -u none -U none \
          -T "$PROXY" -t "127.0.0.1/$CDP" -- \
        bwrap --unshare-pid --unshare-ipc --unshare-uts --die-with-parent --new-session --cap-drop ALL \
          --ro-bind /usr /usr --ro-bind /lib /lib --ro-bind /lib64 /lib64 \
          --proc /proc --dev /dev --tmpfs /tmp \
          --ro-bind "$OBSCURA_RUNTIME" /runtime \
          --clearenv --setenv PATH /usr/bin:/bin -- \
        /runtime/obscura serve --host 127.0.0.1 --port "$CDP" --proxy "http://127.0.0.1:$PROXY" "${private[@]}" ;;
  esac
}

main() {
  local name failed=0 state names
  case "${1:-}" in start|stop|status) ;; *) echo "usage: $0 start|stop|status" >&2; return 2 ;; esac
  # Absolute, so that `stop` and `status` find the same pid files from any directory.
  case "$RUN" in /*) ;; *) echo "COBALT_HARNESS_RUN must be an absolute directory for pid files and logs" >&2; return 2 ;; esac
  mkdir -p "$RUN" || return 2
  case "$1" in
    start)
      names=$(configured)
      if [ -z "$names" ]; then echo "nothing to start: set OBSCURA_RUNTIME, COBALT_HARNESS_SITE or COBALT_HARNESS_MODELS" >&2; return 2; fi
      for name in $names; do launch "$name" || failed=1; done
      return "$failed"
      ;;
    stop)
      # Whatever a pid file records is stopped, whether or not its variable is set now.
      for name in browser web inference; do stop_one "$name" || failed=1; done
      return "$failed"
      ;;
    status)
      for name in inference web browser; do
        record "$name"; state=$?
        if [ "$state" -eq 2 ]; then echo "$name unknown (pid file is not one this script wrote)"
        elif alive "$name"; then echo "$name running (pid $LEADER, $(members "$name" | wc -w) processes)"
        elif [ -n "$(opaque "$name")" ]; then echo "$name unknown (cannot tell whether $(opaque "$name")belongs to it)"
        else echo "$name not running"; fi
      done
      ;;
  esac
}

# Sourced by test-services.sh for its functions; run directly otherwise.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
