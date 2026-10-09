#!/bin/bash
# Tests for the optional development harness services.sh (stop and status).
# They run its real start_one/stop_one with the README's confinement recipe
# (pasta + bubblewrap) around a harmless `sleep`, in a scratch run directory.
# No browser, model server or site is started, and every process is found
# through recorded pids, never by name. Linux with pasta and bubblewrap only;
# elsewhere the file says SKIPPED and runs nothing.
# usage: bash capabilities/tests/test-services.sh
set -u
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SCRATCH=$(mktemp -d)
export COBALT_HARNESS_RUN="$SCRATCH/run"
mkdir -p "$COBALT_HARNESS_RUN"
# shellcheck source=services.sh
source "$HERE/services.sh"

pass=0 fail=0
ok() { pass=$((pass + 1)); echo "ok   - $1"; }
no() { fail=$((fail + 1)); echo "FAIL - $1"; }
check() { if eval "$2"; then ok "$1"; else no "$1"; fi; }

# The README recipe with a harmless leaf. $1 is the host port pasta forwards in.
recipe() {
  echo pasta --quiet --foreground --config-net --splice-only -u none -U none -T 18080 -t "127.0.0.1/$1" -- \
    bwrap --unshare-pid --unshare-ipc --unshare-uts --die-with-parent --new-session --cap-drop ALL \
      --ro-bind /usr /usr --ro-bind /lib /lib --ro-bind /lib64 /lib64 --proc /proc --dev /dev --tmpfs /tmp \
      --clearenv --setenv PATH /usr/bin:/bin -- /usr/bin/sleep 600
}
# pid and every descendant of it, as "pid:start" words.
lineage() {
  local pid=$1 child out
  out="$pid:$(proc_start "$pid") "
  for child in $(pgrep -P "$pid" 2>/dev/null); do out="$out$(lineage "$child")"; done
  echo "$out"
}
# Own copy of the identity check, so the tests do not trust the code under test.
proc_start() { local rest; rest=$(sed 's/.*) //' "/proc/$1/stat" 2>/dev/null) || return 0; set -- $rest; [ "${1:-Z}" = Z ] || echo "${20:-}"; }
count_live() { local row n=0; for row in $1; do [ "$(proc_start "${row%%:*}")" = "${row##*:}" ] && n=$((n + 1)); done; echo "$n"; }
until_count() { local i; for i in $(seq 50); do [ "$(lineage "$1" | wc -w)" -ge "$2" ] && return 0; sleep 0.1; done; return 1; }

# An unrelated tree of the same shape, started outside services.sh: it has no
# pid file and must survive everything below.
setsid nohup $(recipe 19556) >/dev/null 2>&1 </dev/null &
DECOY=$!
if ! until_count "$DECOY" 4; then
  # No pasta or bubblewrap, or a host that forbids unprivileged namespaces:
  # there is no confined tree to test against. Said plainly, and not a pass.
  kill -KILL "$DECOY" 2>/dev/null; rm -rf "$SCRATCH"
  echo "SKIPPED - the confinement recipe cannot start here (pasta and bubblewrap with unprivileged namespaces are required); 0 checks ran"
  exit 0
fi
DECOY_TREE=$(lineage "$DECOY")

cleanup() {
  local row
  for row in $DECOY_TREE ${TREE:-}; do [ "$(proc_start "${row%%:*}")" = "${row##*:}" ] && kill -KILL "${row%%:*}" 2>/dev/null; done
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

echo "# 1. stop ends the whole confined tree, not only the wrapper"
out=$(start_one fake $(recipe 19555) 2>&1)
LEADER=$(cut -d' ' -f1 "$COBALT_HARNESS_RUN/fake.pid")
check "start names the pid it recorded ($out)" '[ "$out" = "fake started (pid $LEADER)" ]'
until_count "$LEADER" 4; TREE=$(lineage "$LEADER")
check "tree has four processes before stop" '[ "$(count_live "$TREE")" -eq 4 ]'
check "status sees the service" 'alive fake'
out=$(stop_one fake 2>&1); rc=$?
check "stop returns success" '[ "$rc" -eq 0 ]'
check "no process of the tree is left" '[ "$(count_live "$TREE")" -eq 0 ]'
check "stop says stopped only after that ($out)" 'case "$out" in *stopped*) true;; *) false;; esac'
check "pid file removed" '[ ! -e "$COBALT_HARNESS_RUN/fake.pid" ]'
check "status no longer sees the service" '! alive fake'

echo "# 2. a tree orphaned by a dead wrapper is still found and stopped"
start_one fake $(recipe 19555) >/dev/null
LEADER=$(cut -d' ' -f1 "$COBALT_HARNESS_RUN/fake.pid")
until_count "$LEADER" 4; TREE=$(lineage "$LEADER")
kill -TERM "$LEADER"; for i in $(seq 30); do [ -z "$(proc_start "$LEADER")" ] && break; sleep 0.1; done
sleep 0.5
if [ "$(count_live "$TREE")" -eq 3 ]; then
  ok "precondition: the wrapper is gone and three processes outlive it (the reported bug)"
  check "status still reports the orphaned service as running" 'alive fake'
else
  echo "skip - on this host the tree died with its wrapper ($(count_live "$TREE") left); orphan path not exercised"
fi
out=$(stop_one fake 2>&1); rc=$?
check "stop returns success" '[ "$rc" -eq 0 ]'
check "no process of the orphaned tree is left" '[ "$(count_live "$TREE")" -eq 0 ]'

echo "# 3. a process that ignores TERM is killed, and stop still verifies exit"
start_one stubborn bash -c 'trap "" TERM; while :; do /usr/bin/sleep 1; done' >/dev/null
LEADER=$(cut -d' ' -f1 "$COBALT_HARNESS_RUN/stubborn.pid"); TREE="$LEADER:$(proc_start "$LEADER")"
out=$(stop_one stubborn 2>&1); rc=$?
check "stop returns success" '[ "$rc" -eq 0 ]'
check "the stubborn process is gone" '[ "$(count_live "$TREE")" -eq 0 ]'

echo "# 4. a survivor is reported as a failure, never as stopped"
start_one fake $(recipe 19555) >/dev/null
LEADER=$(cut -d' ' -f1 "$COBALT_HARNESS_RUN/fake.pid")
until_count "$LEADER" 4; TREE=$(lineage "$LEADER")
kill() { :; }            # every signal is lost: nothing can exit
out=$(stop_one fake 2>&1); rc=$?
unset -f kill
check "stop returns failure" '[ "$rc" -ne 0 ]'
check "it says FAILED and names the survivors ($out)" 'case "$out" in *"FAILED to stop"*"$LEADER"*) true;; *) false;; esac'
check "it never says stopped" 'case "$out" in *stopped*) false;; *) true;; esac'
check "the pid file is kept, so the service is still tracked" '[ -e "$COBALT_HARNESS_RUN/fake.pid" ] && alive fake'
out=$(stop_one fake 2>&1); rc=$?
check "a later stop, with signals working, ends it" '[ "$rc" -eq 0 ] && [ "$(count_live "$TREE")" -eq 0 ]'
GONE=$(echo "$TREE" | cut -d' ' -f1)

echo "# 5. a pid file that does not identify this script's own processes stops nothing"
echo "${GONE%%:*} ${GONE##*:} fake-0-0" >"$COBALT_HARNESS_RUN/fake.pid"
out=$(stop_one fake 2>&1); rc=$?
check "stale file for processes that have all exited: not running, file removed ($out)" '[ "$rc" -eq 0 ] && [ ! -e "$COBALT_HARNESS_RUN/fake.pid" ] && case "$out" in *"not running"*) true;; *) false;; esac'
# The decoy's wrapper pid with another start time: a reused pid. Its group holds
# one process that carries no token and, where the wrapper's environment cannot
# be read (pasta under SELinux), one the script cannot identify either way.
echo "$DECOY 1 fake-0-0" >"$COBALT_HARNESS_RUN/fake.pid"
out=$(stop_one fake 2>&1); rc=$?
if { : <"/proc/$DECOY/environ"; } 2>/dev/null; then
  check "reused pid, every environment readable: not running, nothing signalled ($out)" '[ "$rc" -eq 0 ] && case "$out" in *"not running"*) true;; *) false;; esac'
else
  check "reused pid, an unreadable environment: nothing signalled, said so, file kept ($out)" '[ "$rc" -ne 0 ] && [ -e "$COBALT_HARNESS_RUN/fake.pid" ] && case "$out" in *"nothing signalled"*) true;; *) false;; esac'
fi
check "it is not counted as running" '! alive fake'
for content in "$DECOY" "not a pid" "1 1 fake-0-0" "$DECOY $(proc_start "$DECOY")"; do
  echo "$content" >"$COBALT_HARNESS_RUN/fake.pid"
  out=$(stop_one fake 2>&1); rc=$?
  check "pid file '$content': refused, nothing signalled, file kept" '[ "$rc" -ne 0 ] && [ -e "$COBALT_HARNESS_RUN/fake.pid" ] && case "$out" in *"not one this script wrote"*) true;; *) false;; esac'
done
out=$(start_one fake /usr/bin/sleep 600 2>&1); rc=$?
check "start refuses to overwrite such a file ($out)" '[ "$rc" -ne 0 ] && [ "$(cat "$COBALT_HARNESS_RUN/fake.pid")" = "$DECOY $(proc_start "$DECOY")" ]'
rm -f "$COBALT_HARNESS_RUN/fake.pid"

echo "# 6. a service that does not come up is reported, and leaves no pid file"
out=$(start_one fake /usr/bin/false 2>&1); rc=$?
check "start returns failure ($(echo "$out" | head -1))" '[ "$rc" -ne 0 ] && case "$out" in *"failed to start"*) true;; *) false;; esac'
check "no pid file is left, so a later start or stop is not blocked" '[ ! -e "$COBALT_HARNESS_RUN/fake.pid" ]'
out=$(stop_one fake 2>&1); rc=$?
check "stop then says not running" '[ "$rc" -eq 0 ] && case "$out" in *"not running"*) true;; *) false;; esac'
out=$(COBALT_HARNESS_RUN=relative/run bash "$HERE/services.sh" status 2>&1); rc=$?
check "a relative run directory is refused ($out)" '[ "$rc" -eq 2 ]'

echo "# 7. the unrelated tree was never touched"
check "all four decoy processes are still running" '[ "$(count_live "$DECOY_TREE")" -eq 4 ]'

echo "# $pass passed, $fail failed"
[ "$fail" -eq 0 ]
