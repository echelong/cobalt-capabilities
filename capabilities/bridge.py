"""One bounded operator invocation; no daemon, installer, inference or transcript access."""
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys

MAX_INPUT = 24000
MAX_OUTPUT = 2000000
# Fixed lock location, never operator- or environment-selected: the per-user
# runtime directory, or the shared temporary directory under the same
# ownership checks where no runtime directory exists. LOCK_ROOT is a test seam.
LOCK_ROOT = None


def lock_roots():
    return (LOCK_ROOT,) if LOCK_ROOT else (f"/run/user/{os.getuid()}", "/tmp")


def load_adapter():
    """Load the sibling memory adapter by its own path, not by module search."""
    spec = importlib.util.spec_from_file_location("cobalt_hindsight", Path(__file__).with_name("hindsight.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
MEMORY_OPERATIONS = ("status", "recall", "retain", "reflect", "list", "forget")


def report_step(name):
    """One fixed-shape progress line on stderr when an operation really starts.

    Names only, never arguments or content. The result stays alone on stdout,
    and a closed or missing stderr never changes the operation's outcome.
    """
    try:
        sys.stderr.write(json.dumps({"cobalt_step": name}) + "\n")
        sys.stderr.flush()
    except (OSError, ValueError):
        pass


def load_config(path):
    p = Path(path)
    if not p.is_absolute():
        raise ValueError("configuration_required")
    fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd) as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError("private_operator_configuration_required")
        raw = stream.read(MAX_INPUT + 1)
    if len(raw) > MAX_INPUT:
        raise ValueError("configuration_too_large")
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError("invalid_configuration")
    return value


def dispatch(request):
    capability = request.get("capability")
    if capability not in ("memory", "browser"):
        raise ValueError("invalid_capability")
    # The host's switch is independent of the private file's switch. A disabled
    # call does not even open that file, inspect Git or start the browser worker.
    if request.get("enabled") is not True:
        return {"capability": capability, "status": "disabled", "duration_ms": 0}
    config = load_config(request.get("configuration_path", ""))
    if config.get(capability + "_enabled") is not True:
        return {"capability": capability, "status": "disabled", "duration_ms": 0}
    arguments = request.get("arguments", {})
    if not isinstance(arguments, dict):
        raise ValueError("invalid_arguments")
    # Cross-session exclusive effects. Locks release on process termination.
    # Never put endpoint strings, contents or credentials on disk.
    if 'lock_directory' in config:
        raise ValueError('lock_directory_not_configurable')
    base = None
    for candidate in lock_roots():
        try:
            resolved = Path(candidate).resolve(strict=True)
        except OSError:
            continue
        if resolved.is_dir():
            base = resolved
            break
    if base is None:
        # No usable location is a distinct, diagnosable condition rather than
        # a generic malformed request.
        raise ValueError("lock_storage_unavailable")
    root = base / f"cobalt-capabilities-{os.getuid()}"
    directory = root / "locks"
    if not directory.is_absolute() or '..' in directory.parts or not directory.resolve().is_relative_to(base):
        raise ValueError("lock_directory_outside_fixed_root")
    if any(p.is_symlink() for p in [directory, *directory.parents] if p != base and p.is_relative_to(base)):
        raise ValueError("symlink_lock_directory")
    # Every level is created and verified private: parents=True would give an
    # implicit intermediate directory the invoking umask instead of 0700. A
    # directory an earlier version created wider is tightened, not trusted.
    for level in (root, directory):
        level.mkdir(mode=0o700, exist_ok=True)
        if level.is_symlink():
            raise ValueError("private_lock_directory_required")
        info = level.stat()
        if info.st_uid != os.getuid():
            raise ValueError("private_lock_directory_required")
        if info.st_mode & 0o077:
            try:
                os.chmod(level, 0o700)
            except OSError:
                raise ValueError("private_lock_directory_required") from None
            if level.stat().st_mode & 0o077:
                raise ValueError("private_lock_directory_required")
    # One lock across all endpoints/capabilities prevents independently configured
    # clients from widening the host's conservative ownership policy.
    digest = hashlib.sha256(b"cobalt-capabilities-exclusive").hexdigest()
    fd = os.open(directory / (digest + ".lock"), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    with os.fdopen(fd, "w") as lock:
        info = os.fstat(lock.fileno())
        if info.st_uid != os.getuid() or not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
            raise ValueError("invalid_lock_owner")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {"capability": capability, "status": "error", "error": "resource_busy"}
        if capability == "memory":
            Hindsight = load_adapter().Hindsight
            operation = request.get("operation", "status")
            # Reported only when the service request is actually issued: a
            # refusal before any service I/O never shows as an operation.
            started = (lambda: report_step(operation)) if operation in MEMORY_OPERATIONS else None
            return Hindsight(config, request.get("repo", ""), on_request=started).execute(operation, arguments)
        worker = Path(__file__).with_name("browser.mjs")
        # A scrubbed child environment prevents implicit proxies/CDP credentials.
        env = {k: v for k, v in os.environ.items() if k in ("PATH", "LANG", "LC_ALL", "TMPDIR")}
        try:
            # The worker inherits stderr for its fixed-shape step lines; the
            # host parses them strictly and discards everything else unread.
            result = subprocess.run(["node", "--max-old-space-size=256", str(worker)], input=json.dumps({"config": config, "arguments": arguments}),
                                    stdout=subprocess.PIPE, stderr=None, text=True, timeout=40, env=env, check=False)
        except OSError:
            # The worker never started, so nothing can have been clicked.
            return {"capability": capability, "status": "unavailable", "error": "worker_unavailable_or_timeout", "executed": False}
        except subprocess.TimeoutExpired:
            # A worker that outlived its budget did start: a navigation, click or
            # fill may already have landed and only the report is missing, so
            # this is failure with possible effects, not a clean refusal.
            return {"capability": capability, "status": "unavailable", "error": "worker_unavailable_or_timeout",
                    "executed": False, "effects_possible": True}
        if result.returncode or len(result.stdout) > MAX_OUTPUT:
            # Same reasoning: the process ran and its report is unusable.
            return {"capability": capability, "status": "error", "error": "worker_failed",
                    "executed": False, "effects_possible": True}
        try:
            report = json.loads(result.stdout)
        except ValueError:
            report = None
        if not isinstance(report, dict):
            # The worker ran to a clean exit and its report is unusable: the
            # same failure with possible effects, never a clean refusal.
            return {"capability": capability, "status": "error", "error": "worker_failed",
                    "executed": False, "effects_possible": True}
        return report


def main():
    try:
        raw = sys.stdin.read(MAX_INPUT + 1)
        if len(raw) > MAX_INPUT:
            raise ValueError("request_too_large")
        request = json.loads(raw)
        if not isinstance(request, dict):
            raise ValueError("invalid_request")
        result = dispatch(request)
    except ValueError as error:
        # Never disclose exception strings, endpoints or raw service bodies:
        # only one locally diagnosable code is exported by name.
        code = "lock_storage_unavailable" if str(error) == "lock_storage_unavailable" else "invalid_configuration_or_request"
        result = {"status": "error", "error": code, "executed": False}
    except Exception:
        result = {"status": "error", "error": "invalid_configuration_or_request", "executed": False}
    print(json.dumps(result, ensure_ascii=True))


if __name__ == "__main__":
    main()
