"""Optional, bounded Hindsight REST client. No service startup or transcript access."""
from __future__ import annotations

import hashlib
import http.client
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import socket
import subprocess
import threading
import time
import unicodedata
from datetime import datetime, timezone
from urllib.parse import urlsplit, quote
import uuid


MAX_RESPONSE = 262144
MAX_MEMORY_TEXT = 24000


class _MissingBank(ValueError):
    """The service answered 404: the bank/document does not exist (yet)."""


class _NotEnabled(ValueError):
    """The operator has not named this repository for memory."""


# Invisible characters are removed by Unicode category, not from a list of
# ranges: every control (except tab and the two line ends), every format
# character (Cf: bidi controls, zero-width characters, the byte-order mark,
# soft hyphen, Arabic and other script-specific format marks, the tag block),
# private-use and surrogate code points, the line and paragraph separators,
# and both variation-selector ranges. A character left here is a character a
# secret can be hidden behind, so the category decides, and a code point a
# later Unicode version adds to Cf is covered when the runtime knows it.
_INVISIBLE_CATEGORIES = frozenset(("Cc", "Cf", "Co", "Cs", "Zl", "Zp"))
# Code points that render as nothing but sit in letter, mark or symbol
# categories: combining grapheme joiner, Hangul fillers, Khmer inherent vowels,
# Mongolian variation selectors and the blank Braille pattern.
_INVISIBLE_OTHERS = frozenset("\u034f\u115f\u1160\u17b4\u17b5\u180b\u180c\u180d\u180f\u2800\u3164\uffa0")


def _invisible(character):
    if character in "\t\n\r":
        return False
    # The last two ranges are default-ignorable code points, assigned or not:
    # the whole tag and variation-selector plane block, and the unassigned
    # specials beside the interlinear annotation characters.
    return (unicodedata.category(character) in _INVISIBLE_CATEGORIES or character in _INVISIBLE_OTHERS
            or "\ufe00" <= character <= "\ufe0f" or "\U000e0000" <= character <= "\U000e0fff"
            or character == "\u2065" or "\ufff0" <= character <= "\ufff8")


class _Controls:
    """`CONTROLS.sub("", text)`: the text without its invisible characters."""

    @staticmethod
    def sub(replacement, value):
        return "".join(replacement if _invisible(character) else character for character in value)


CONTROLS = _Controls()
SECRET = re.compile(
    r"-----BEGIN (?:[A-Z ]*PRIVATE KEY)|\b(?:sk-[A-Za-z0-9_-]{12,}|"
    r"sk_(?:live|test)_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{12,}|"
    r"gh[pousr]_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9_-]{8,}|AKIA[A-Z0-9]{16})\b|"
    r"\b(?:Bearer|Basic)\s+\S+|"
    r"(?:password|passwd|api[_ -]?key|access[_ -]?token|token|secret|authorization|cookie)"
    r"[\"']?\s*[:=]\s*[\"']?\S+|https?://[^\s/@:]+:[^\s/@]+@", re.I)


def contains_secret(value):
    """Reject obvious secrets throughout caller data; not a complete DLP detector.

    Invisible formatting is stripped first. A secret interrupted by zero-width
    characters must be recognized here as the secret it is, or the same slice
    that passed this scan is rejoined into a readable secret by the very
    CONTROLS.sub() that makes it safe to display.
    """
    if isinstance(value, dict):
        return any(contains_secret(k) or contains_secret(v) for k, v in value.items())
    if isinstance(value, (tuple, list)):
        return any(contains_secret(v) for v in value)
    return isinstance(value, str) and bool(SECRET.search(CONTROLS.sub("", value)))


def _git_env():
    # Scrubbed environment for observation only: no inherited proxies or
    # credential helpers, and GIT_OPTIONAL_LOCKS=0 keeps `git status` from
    # refreshing the index while a user commit may hold index.lock.
    return {k: v for k, v in os.environ.items() if k in ("PATH", "HOME", "LANG", "LC_ALL", "TMPDIR")} | {
        "GIT_TERMINAL_PROMPT": "0", "GIT_OPTIONAL_LOCKS": "0",
        # A partial clone would otherwise fetch what it is missing, through
        # whatever transport program the repository's configuration names.
        "GIT_NO_LAZY_FETCH": "1"}


# A repository's own configuration can name a program for Git to run during
# status; observation of an unreviewed repository must never execute it.
GIT = ("git", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null")


def _git(repo, *args):
    try:
        out = subprocess.run([*GIT, "-C", str(repo), *args], check=True,
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                             timeout=2, env=_git_env())
        if len(out.stdout) > 8192:
            return ""
        return out.stdout.decode("utf-8", errors="strict").strip()
    except (OSError, subprocess.SubprocessError, UnicodeError):
        return ""


def _repository_setting(repo, pattern):
    """Whether the repository's OWN configuration sets a key matching `pattern`.

    Answers "none", "set" or "unknown". Only the repository's files are read
    (its local configuration and whatever that includes): the operator's global
    and system configuration are theirs and are left out. Anything other than a
    clean "no such key" is never read as "none": a failure, a timeout or an
    answer too large to trust is "unknown", so a repository cannot hide a
    setting by making the question fail. `--local` makes "this is not a
    repository Git will read" a failure too, instead of an empty answer.
    """
    env = _git_env() | {"GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_SYSTEM": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}
    try:
        out = subprocess.run([*GIT, "-C", str(repo), "config", "--local", "--includes", "--name-only", "--get-regexp", pattern],
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=2, env=env)
    except (OSError, subprocess.SubprocessError):
        return "unknown"
    if out.returncode == 1 and not out.stdout:
        return "none"
    if out.returncode == 0 and out.stdout and len(out.stdout) <= 65536:
        return "set"
    return "unknown"


def repository_identity(repo):
    """Hash normalized remote (without userinfo), otherwise canonical Git common-dir."""
    repo = Path(repo).resolve()
    common = _git(repo, "rev-parse", "--git-common-dir")
    if not common:
        raise ValueError("repository_required")
    origin = _git(repo, "config", "--get", "remote.origin.url")
    identity = None
    if origin and not any(c.isspace() for c in origin):
        try:
            if "://" in origin:
                u = urlsplit(origin)
                if u.scheme in ("https", "http", "ssh", "git") and u.hostname and not u.query and not u.fragment:
                    host = u.hostname.lower()
                    # Transport/userinfo don't define repository identity; custom ports do.
                    port = u.port
                    default = {"https": 443, "http": 80, "ssh": 22, "git": 9418}[u.scheme]
                    host += f":{port}" if port and port != default else ""
                    path = u.path.strip("/")
                    identity = f"remote:{host}/{path.removesuffix('.git')}" if path else None
            else:
                m = re.fullmatch(r"(?:[^/@:]+@)?([A-Za-z0-9.-]+):([A-Za-z0-9_./-]+)", origin)
                if m:
                    identity = f"remote:{m[1].lower()}/{m[2].strip('/').removesuffix('.git')}"
        except ValueError:
            pass
    if not identity:
        identity = "local:" + str((repo / common).resolve())
    return "cobalt-" + hashlib.sha256(identity.encode()).hexdigest()


# Repository settings under which `git status` can start a program the
# repository chose: a content filter, an attributes file naming one, a partial
# clone (which fetches missing objects through a configured transport), a
# per-worktree configuration file this check does not read, and the transport
# programs themselves.
_RUNS_A_PROGRAM_ON_STATUS = (r"^(filter\.|core\.(attributesfile|sshcommand|gitproxy|alternaterefscommand)$"
                             r"|extensions\.(partialclone|worktreeconfig)$"
                             r"|remote\..*\.(promisor|partialclonefilter|uploadpack|receivepack)$)")


def _worktree_dirty(repo):
    # `git status` compares file contents, and a repository's own configuration
    # can name a clean/process filter program for that comparison to run. Where
    # the repository itself configures any filter (its local file, a file that
    # one includes, or a per-worktree file) the question is left unanswered
    # instead: reading configuration runs nothing. Filters from the operator's
    # own global configuration are theirs and stay in effect.
    if _repository_setting(repo, _RUNS_A_PROGRAM_ON_STATUS) != "none":
        return "unknown"
    try:
        # Submodules are not entered: their configuration was not inspected.
        out = subprocess.run([*GIT, "-C", str(repo), "status", "--porcelain", "--ignore-submodules=all"], check=True,
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=2,
                             env=_git_env())
        return "true" if out.stdout else "false"
    except (OSError, subprocess.SubprocessError):
        return "unknown"


class Hindsight:
    def __init__(self, config, repo, on_request=None):
        self.config = dict(config)
        self.repo = Path(repo)
        self._bank_id = None
        # Called once the request has passed validation and is about to reach
        # the service; progress telemetry only, it cannot alter the request.
        self._on_request = on_request
        # Set once a request has actually been written to the service.
        self._sent = False

    @property
    def bank_id(self):
        if self.config.get("memory_enabled") is not True:
            return None
        if self._bank_id is None:
            self._bank_id = repository_identity(self.repo)
        return self._bank_id

    def _require_enabled_repository(self):
        """Memory is used only in repositories the operator named.

        The bank is derived from what the repository says about itself (its
        remote, or its Git directory), so a repository delivered with someone
        else's remote would otherwise be handed that project's memory. The
        operator's private file lists the working trees memory may be used in,
        by absolute path; anything else is refused before the bank is derived
        or the service is contacted.
        """
        allowed = self.config.get("memory_repositories")
        if (not isinstance(allowed, list) or not allowed or len(allowed) > 64
                or not all(isinstance(entry, str) and os.path.isabs(entry) for entry in allowed)):
            raise _NotEnabled("repository_not_enabled")
        if not self.repo.is_absolute():
            raise ValueError("repository_required")
        top = _git(self.repo, "rev-parse", "--show-toplevel")
        if not top:
            raise ValueError("repository_required")
        # Git's answer about where the working tree is can be dictated by the
        # repository itself (`core.worktree`), so a repository that sets it, or
        # whose configuration cannot be read cleanly, is not accepted on its
        # own word; and the session must really be inside the named tree.
        if _repository_setting(self.repo, r"^(core\.worktree|extensions\.worktreeconfig)$") != "none":
            raise _NotEnabled("repository_not_enabled")
        top, here = os.path.realpath(top), os.path.realpath(self.repo)
        if top not in {os.path.realpath(entry) for entry in allowed}:
            raise _NotEnabled("repository_not_enabled")
        if os.path.commonpath([here, top]) != top:
            raise _NotEnabled("repository_not_enabled")

    def _request(self, method, path, body=None, timeout_ms=None):
        # HTTPConnection ignores HTTP(S)_PROXY; redirects are never followed.
        u = urlsplit(self.config.get("hindsight_endpoint", ""))
        if u.scheme != "http" or u.username or u.password or u.query or u.fragment or u.path not in ("", "/"):
            raise ValueError("invalid_endpoint")
        try:
            if not ipaddress.ip_address(u.hostname).is_loopback:
                raise ValueError("invalid_endpoint")
            port = u.port or 8888
        except (TypeError, ValueError):
            raise ValueError("invalid_endpoint") from None
        configured = self.config.get("memory_timeout_ms", 10000)
        if isinstance(configured, bool) or not isinstance(configured, int) or not 100 <= configured <= 300000:
            raise ValueError("invalid_timeout")
        # Non-inference observations carry an own short allowance so a hung
        # status/list/forget cannot hold the exclusive lock for the full
        # configured inference budget.
        timeout_ms = configured if timeout_ms is None else timeout_ms
        if isinstance(timeout_ms, bool) or not isinstance(timeout_ms, int) or not 100 <= timeout_ms <= 300000:
            raise ValueError("invalid_timeout")
        deadline = time.monotonic() + timeout_ms / 1000
        connection = http.client.HTTPConnection(u.hostname, port, timeout=timeout_ms / 1000)
        timer = None
        try:
            encoded = json.dumps(body, ensure_ascii=True).encode() if body is not None else None
            if self._on_request is not None:
                try:
                    self._on_request()
                except Exception:
                    pass
            connection.connect()
            transport_socket = connection.sock

            def close_at_deadline():
                try:
                    transport_socket.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass

            # One bounded deadline timer, canceled on completion. Also bounds slow headers.
            timer = threading.Timer(max(0, deadline - time.monotonic()), close_at_deadline)
            timer.daemon = True
            timer.start()
            self._sent = True
            connection.request(method, path, body=encoded, headers={"Content-Type": "application/json", "Accept": "application/json"})
            response = connection.getresponse()
            if response.status == 404:
                raise _MissingBank()
            if response.status < 200 or response.status >= 300:
                raise ValueError("service_error")
            length = response.getheader("Content-Length")
            if length is not None and (not length.isdigit() or int(length) > MAX_RESPONSE):
                raise ValueError("response_too_large")
            data = bytearray()
            # read1 plus changing socket deadline bounds a slow streaming service.
            while True:
                if response.fp is None:
                    break
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError()
                response.fp.raw._sock.settimeout(remaining)
                chunk = response.read1(min(8192, MAX_RESPONSE + 1 - len(data)))
                if not chunk:
                    break
                data.extend(chunk)
                if len(data) > MAX_RESPONSE:
                    raise ValueError("response_too_large")
            result = json.loads(data)
            if not isinstance(result, dict):
                raise ValueError("invalid_response")
            return result
        except (OSError, http.client.HTTPException, ValueError):
            if time.monotonic() >= deadline:
                raise TimeoutError() from None
            raise
        finally:
            if timer is not None:
                timer.cancel()
            connection.close()

    def _memories(self, rows):
        if not isinstance(rows, list):
            raise ValueError("invalid_response")
        now = datetime.now(timezone.utc)
        commit = _git(self.repo, "rev-parse", "HEAD")
        results = []
        # Twenty rows of 4,000 characters is more reference text than one call
        # should put in front of a model: the whole answer shares one budget,
        # and rows past it are left out and counted, never silently cut short.
        budget = MAX_MEMORY_TEXT
        for row in rows[:20]:
            if budget <= 0:
                break
            if not isinstance(row, dict):
                raise ValueError("invalid_response")
            text = row.get("text", row.get("content", ""))
            if not isinstance(text, str):
                raise ValueError("invalid_response")
            metadata = row.get("metadata")
            metadata = metadata if isinstance(metadata, dict) else {}
            owned = metadata.get("repository_id") == self.bank_id
            stamp = metadata.get("timestamp")
            age = None
            try:
                delta = (now - datetime.fromisoformat(stamp.replace("Z", "+00:00"))).total_seconds()
                age = int(delta / 86400) if delta >= 0 else None
            except (TypeError, ValueError, AttributeError):
                pass
            # Service results are never trusted as authority, even with matching
            # metadata. Scan the same bounded slice that is returned, never the
            # whole service-supplied string, so a hostile response cannot buy
            # CPU time beyond the output that is actually shown.
            provenance = {}
            for k in ("source_commit", "source_dirty", "run_id", "timestamp", "verification_reference", "source_references"):
                value = metadata.get(k)
                if isinstance(value, str):
                    sample = value[:256]
                    if not contains_secret(sample):
                        provenance[k] = CONTROLS.sub("", sample)
            identifier = row.get("id", "")
            document = row.get("document_id", "")
            identifier = identifier if isinstance(identifier, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", identifier) else ""
            document = document if isinstance(document, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", document) else ""
            scores = row.get("scores")
            scores = {k: v for k, v in scores.items() if k in ("semantic", "keyword", "reranker", "final")
                      and isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)
                      and abs(v) <= 1e12} if isinstance(scores, dict) else None
            reported = metadata.get("verification_status")
            authority = "source_reported_verified" if owned and reported == "verified" \
                else "source_reported_agent_asserted" if owned and reported == "agent_asserted" else "unverified"
            sample = text[:min(4000, budget)]
            budget -= len(sample)
            results.append({"id": "" if contains_secret(identifier) else identifier,
                            "document_id": "" if contains_secret(document) else document,
                            "text": "[excluded: possible secret]" if contains_secret(sample) else CONTROLS.sub("", sample),
                            "untrusted": True, "authoritative": False, "requires_verification": True,
                            "verification_status": authority,
                            "freshness": "stale" if age is not None and age > 30 else "unknown" if age is None else "recent_reference",
                            "age_days": age, "commit_matches": bool(commit and metadata.get("source_commit") == commit),
                            "confidence": "not_assessed", "relevance_scores": scores,
                            "provenance": provenance})
        return results

    @staticmethod
    def _note_omitted(result, rows):
        """Say how many service rows were left out of a bounded answer."""
        omitted = len(rows) - len(result["memories"]) if isinstance(rows, list) else 0
        if omitted > 0:
            result["omitted_results"] = omitted

    def execute(self, operation, arguments=None):
        started = time.monotonic()
        valid_operation = isinstance(operation, str) and operation in ("status", "recall", "retain", "reflect", "list", "forget")
        result = {"capability": "memory", "operation": operation if valid_operation else "invalid", "status": "disabled"}
        if self.config.get("memory_enabled") is not True:
            result["duration_ms"] = 0
            result["executed"] = False
            return result
        try:
            if not valid_operation:
                raise ValueError("unsupported_operation")
            args = arguments if arguments is not None else {}
            if not isinstance(args, dict) or contains_secret(args):
                raise ValueError("secret_or_invalid_input")
            self._require_enabled_repository()
            result["bank_id"] = self.bank_id
            prefix = "/v1/default/banks/" + quote(self.bank_id, safe="")
            document_prefix = "cobalt-" + self.bank_id[7:23] + "-"
            # Observations never inherit the inference budget: they are capped
            # at 30 s (or the operator's smaller value), while retain/reflect
            # keep the configured budget.
            timeout_ms = self.config.get("memory_timeout_ms", 10000)
            if isinstance(timeout_ms, bool) or not isinstance(timeout_ms, int) or not 100 <= timeout_ms <= 300000:
                raise ValueError("invalid_timeout")
            observation_timeout = min(timeout_ms, 30000) if operation not in ("retain", "reflect") else None
            if operation == "status":
                data = self._request("GET", "/health", timeout_ms=observation_timeout)
                if data.get("status") != "healthy" or data.get("database") != "connected":
                    raise ValueError("invalid_response")
                result["status"] = "ready"
            elif operation in ("recall", "reflect"):
                if self.config.get("memory_inference_configured") is not True:
                    raise ValueError("inference_not_configured")
                query = args.get("query")
                if not isinstance(query, str) or not query.strip() or len(query) > 2000:
                    raise ValueError("invalid_query")
                body = {"query": query, "budget": "low", "max_tokens": 1024}
                if operation == "recall":
                    body.update({"trace": False, "include": {"entities": None, "chunks": None, "source_facts": None}})
                    try:
                        data = self._request("POST", prefix + "/memories/recall", body, timeout_ms=observation_timeout)
                    except _MissingBank:
                        # A bank that has never been written has no memories; an
                        # empty, ready observation is the truthful answer.
                        data = {}
                    result["memories"] = self._memories(data.get("results", []))
                    result["result_count"] = len(result["memories"])
                    self._note_omitted(result, data.get("results", []))
                else:
                    data = self._request("POST", prefix + "/reflect", body)
                    text = data.get("text")
                    if not isinstance(text, str):
                        raise ValueError("invalid_response")
                    sample = text[:4000]
                    result["reflection"] = {"text": "[excluded: possible secret]" if contains_secret(sample) else CONTROLS.sub("", sample),
                                            "untrusted": True, "authoritative": False, "requires_verification": True}
                    result["result_count"] = 1
                result["status"] = "ready"
            elif operation == "list":
                try:
                    data = self._request("GET", prefix + "/memories/list?limit=20&offset=0", timeout_ms=observation_timeout)
                except _MissingBank:
                    data = {"items": []}
                result["memories"] = self._memories(data.get("items", []))
                result["result_count"] = len(result["memories"])
                self._note_omitted(result, data.get("items", []))
                result["status"] = "ready"
            elif operation == "retain":
                if self.config.get("memory_retention_consent") is not True:
                    raise ValueError("retention_consent_required")
                if self.config.get("memory_inference_configured") is not True:
                    raise ValueError("inference_not_configured")
                if set(args) - {"summary", "verified", "verification_reference", "run_id", "source_references"}:
                    raise ValueError("summary_only")
                summary = args.get("summary")
                # `verified` is never self-awarded: the caller may omit it, and
                # the host downgrades any asserted verification the commander
                # run ledger cannot corroborate. Only a corroborated retain is
                # stored as verified; every other retain is agent_asserted.
                asserted = args.get("verified") is True
                if not isinstance(summary, str) or not summary.strip() or len(summary) > 4000:
                    raise ValueError("invalid_summary")
                if any(not isinstance(args.get(k), str) or not args[k].strip() or len(args[k]) > 512
                       for k in ("verification_reference", "run_id")):
                    raise ValueError("provenance_required")
                references = args.get("source_references", "")
                if isinstance(references, list):
                    if len(references) > 10 or any(not isinstance(ref, str) or len(ref) > 512 for ref in references):
                        raise ValueError("invalid_references")
                    references = json.dumps(references, ensure_ascii=True)
                if not isinstance(references, str) or len(references) > 1000:
                    raise ValueError("invalid_references")
                commit = _git(self.repo, "rev-parse", "HEAD")
                if not re.fullmatch(r"[0-9a-f]{40,64}", commit):
                    raise ValueError("source_commit_required")
                stamp = datetime.now(timezone.utc).isoformat()
                document_id = document_prefix + uuid.uuid4().hex
                # Expose the scoped ID even if acknowledgment is lost, enabling reconciliation.
                result["document_id"] = document_id
                body = {"async": False, "items": [{"content": summary, "timestamp": stamp,
                        "context": "verified_cockpit_finding" if asserted else "agent_asserted_cockpit_finding",
                        "document_id": document_id,
                        "metadata": {"repository_id": self.bank_id, "source_commit": commit,
                                     "source_dirty": _worktree_dirty(self.repo), "run_id": args["run_id"],
                                     "timestamp": stamp,
                                     "verification_status": "verified" if asserted else "agent_asserted",
                                     "verification_reference": args["verification_reference"], "source_references": references},
                        "tags": ["cockpit_verified" if asserted else "cockpit_agent_asserted"], "update_mode": "replace"}]}
                data = self._request("POST", prefix + "/memories", body)
                if data.get("success") is not True or data.get("bank_id") != self.bank_id or data.get("async") is not False or data.get("items_count") != 1:
                    raise ValueError("invalid_response")
                result.update(status="ready", result_count=1, document_id=document_id,
                              verification_status="verified" if asserted else "agent_asserted")
            elif operation == "forget":
                document_id = args.get("document_id")
                if not isinstance(document_id, str) or not re.fullmatch(re.escape(document_prefix) + r"[0-9a-f]{32}", document_id):
                    raise ValueError("document_scope_refused")
                if args.get("confirm_document_id") != document_id:
                    raise ValueError("deletion_confirmation_required")
                try:
                    data = self._request("DELETE", prefix + "/documents/" + quote(document_id, safe=""), timeout_ms=observation_timeout)
                except _MissingBank:
                    # The service answered that no such document exists:
                    # nothing was deleted, so there is no effect to reconcile.
                    self._sent = False
                    raise
                if data.get("success") is not True or data.get("document_id") != document_id:
                    raise ValueError("invalid_response")
                result.update(status="ready", result_count=1, document_id=document_id)
            else:
                raise ValueError("unsupported_operation")
        except (TimeoutError, socket.timeout):
            result.update(status="unavailable", error="timeout", fallback=True)
        except (ConnectionError, OSError, http.client.HTTPException):
            result.update(status="unavailable", error="service_unavailable", fallback=True)
        except _NotEnabled:
            # One locally diagnosable code: nothing was derived, sent or read.
            result.update(status="error", error="repository_not_enabled", fallback=True)
        except (ValueError, TypeError, AttributeError, RecursionError, OverflowError):
            # Never surface raw server bodies, URLs, credentials or exception strings.
            result.update(status="error", error="operation_refused_or_invalid_response", fallback=True)
        if operation == "retain" and "document_id" in result:
            result["outcome"] = "confirmed" if result["status"] == "ready" else "unknown"
        # A write whose request reached the service and whose answer is missing
        # or unusable may have been applied: say so instead of reading as a
        # clean refusal. A request that was never sent changed nothing.
        if operation in ("retain", "forget") and result.get("status") != "ready" and self._sent:
            result["effects_possible"] = True
            result["outcome"] = "unknown"
        # Execution is only claimed when the service actually carried the
        # operation out. A ready status means a real round trip succeeded; a
        # refusal, fallback or timeout is never reported as executed.
        result["executed"] = result.get("status") == "ready"
        result["duration_ms"] = int((time.monotonic() - started) * 1000)
        return result
