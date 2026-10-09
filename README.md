# Cobalt Capabilities — optional companion for Cobalt Cockpit

`cobalt-capabilities` is a Claude Code mod that works alongside
[Cobalt Cockpit](https://github.com/echelong/cobalt-cockpit) (v0.4.0 or later).
It has its own repository, its own releases and its own version, and is
installed on its own. It adds two capabilities, each **off until you turn it on
in two places**, and each needing a local service that **you** run:

- **Memory**: explicit project memory in a [Hindsight](https://github.com/vectorize-io/hindsight) service.
- **Browser**: bounded browser evidence from an [Obscura](https://github.com/h4ckf0r0day/obscura) service.

Cobalt Cockpit does not need this companion, and installing Cockpit does not
install it. Nothing here installs or starts Hindsight, Obscura, a database or an
inference model. No model routing, agent spawning or permission-check hook is
added.

## Install

Requires Claude Code 2.1.294 or later and Cobalt Cockpit v0.4.0 or later loaded
in the same session: the companion reads Cockpit's ownership ledger and refuses
to act without it. A subagent can use these tools only under Cockpit's
`orchestration` option, which is what admits it an exclusive task. Tested on
Linux.

Cockpit first, if you do not have it:

```sh
claude plugin marketplace add echelong/cobalt-cockpit
claude plugin install cobalt-cockpit@cobalt-cockpit
```

Then the companion, from this repository's own marketplace:

```sh
claude plugin marketplace add echelong/cobalt-capabilities
claude plugin install cobalt-capabilities@cobalt-capabilities
```

Restart Claude Code. Installed like this, both capabilities are off and the
companion registers no tool. Update it with
`claude plugin marketplace update cobalt-capabilities` then
`claude plugin update cobalt-capabilities@cobalt-capabilities`; remove it with
`claude plugin uninstall cobalt-capabilities@cobalt-capabilities`.

**Memory needs** Python 3.11+ (standard library only) and a Hindsight service.

**Browser needs** Node 22.12+, an Obscura service, and one pinned Node package.
It is not installed for you. Install it once, beside the worker, from the
lockfile that ships with the companion (`claude plugin list` prints the
companion's folder):

```sh
cd "<companion folder>/capabilities"
npm ci --ignore-scripts
```

That installs `puppeteer-core` at the exact locked version and downloads no
browser. A plugin update installs into a new folder, so repeat the step after
updating; until then browser tasks answer `browser_unavailable` and nothing else
is affected.

For development, load checkouts for one session instead:
`claude --plugin-dir /path/to/cobalt-cockpit --plugin-dir /path/to/cobalt-capabilities`.

## Turn a capability on

1. Copy `config.example.json` to a private file you own, mode `0600`, outside
   any repository, and edit it. It must be a regular file, not a symlink.
2. In Claude Code, run `/plugin configure cobalt-capabilities@cobalt-capabilities`:
   set `configurationPath` to that file's absolute path and turn on
   `memoryEnabled` and/or `browserEnabled`.
3. Set the matching `memory_enabled` / `browser_enabled` switch in the private
   file. Both switches are required; either one off means off.
4. Approve the exact tool in Claude Code's `/permissions`. The companion asks
   Claude Code's own permission check before every enabled call and proceeds
   only on `allow`. Neither switch implies approval. A permission rule names a
   tool, not an operation: allowing the memory tool allows all six of its
   operations (retaining still needs `memory_retention_consent`, and forgetting
   needs the exact document id twice).

No credential field exists. Endpoints must be dedicated, credential-free
loopback services. Do not point this at a personal browser profile.

### Memory settings

| Key | Meaning |
|---|---|
| `hindsight_endpoint` | Numeric-loopback HTTP address of your Hindsight API. |
| `memory_repositories` | **Required.** Absolute paths of the working trees memory may be used in. Anywhere else every memory operation answers `repository_not_enabled` and contacts nothing. |
| `memory_retention_consent` | `true` permits explicit retention of one short reviewed summary. It never opts into transcript or file ingestion; there is no such feature. |
| `memory_inference_configured` | `true` states that you configured Hindsight's own generation, embedding and reranking. Required before any operation that makes Hindsight run inference. |
| `memory_timeout_ms` | 100–300000. Local CPU inference is slow: with a 3B model on 8 CPU threads a retain took 11–41 s and a reflect about 3 minutes in the release tests. |

Memory is per repository on purpose. A bank is chosen from what a repository
says about itself (its remote), so a repository handed to you with someone
else's remote would otherwise be given that project's memory. Naming the working
trees is what prevents it.

Hindsight runs its **own** inference on every retained summary and every recall
or reflect query, wherever you configured it. The companion makes no model call
and cannot see where that inference runs. Set
`HINDSIGHT_API_LLM_TRACE_ENABLED=false`: upstream otherwise stores full
inference prompts and output.

### Browser settings

| Key | Meaning |
|---|---|
| `obscura_endpoint` | Loopback `ws://` address of the browser's control (CDP) endpoint. |
| `browser_egress_proxy` | **Required.** Exactly `http://127.0.0.1:<port>`, a port of its own. The worker listens here for the length of each task, and the browser must be started with this address as its proxy. |
| `browser_allowed_origins` | Exact origins, for example `["https://example.org"]`. Scheme, host and port all matter. Up to 32. |
| `browser_allow_localhost` | Separate consent for a loopback origin in the list. It opens no other private address. |
| `browser_isolation_confirmed` | Your statement that the browser service runs confined as described below. Required. |
| `browser_timeout_ms` | 100–30000, for the whole task. |
| `browser_authorized_actions` | Exact grants for `click` and `fill` (below). |
| `screenshot_retention` | `none` refuses screenshots; `ephemeral` returns PNG bytes in the tool response and writes no image file. |

## How browser requests are contained

On the supported engine, CDP request interception is **advisory**: measured on
Obscura 0.2.4, a redirect hop, a parser-inserted `<img>`, `<link>` or `<script>`
and a scripted navigation were all fetched from a forbidden origin even when
interception answered "abort", and a forbidden script ran. Interception is
therefore not what enforces the origin policy.

The companion enforces it outside the browser:

- The worker runs a small **egress proxy** on `browser_egress_proxy` for the
  duration of one task. The browser is started with that address as its proxy,
  so every request it makes arrives there first: the navigation, each redirect
  hop, every subresource, every scripted request.
- A request is forwarded only to an **exact allowlisted origin**, only as
  `GET`/`HEAD`, without `Authorization`, `Proxy-Authorization` or `Cookie`, and
  only to the address the policy just checked. The name is resolved once per
  request, every answer is checked against the private, link-local, metadata
  and reserved ranges, and the connection goes to that checked address, so a
  second DNS answer is never used. Anything else is refused **before a
  connection is opened**.
- `CONNECT` is tunnelled only to an exact allowlisted `https` origin. Upgrades
  (WebSocket) are refused. The proxy follows no redirect itself.
- **Nothing runs until the browser proves it is behind the proxy.** Each task
  first loads a one-time address under a reserved name that resolves nowhere;
  only a browser routed through this task's proxy can deliver that request. The
  page it gets back points at a canary no policy admits. If the request never
  arrives, arrives without going through the proxy, or the canary is touched
  directly, the task ends with `browser_egress_unverified` and navigates
  nowhere. There is no fallback to checking after the fact.
- When the task ends the proxy closes. Between tasks the browser has no route.

What this does and does not give you:

- Measured in the release tests with an allowlisted server that redirects to a
  forbidden server: the forbidden server received **zero requests and zero TCP
  connections** for a redirect, a redirect chain, an alternate hostname for the
  same machine, a port change, scripted and form navigations, and parser-inserted
  and redirected subresources.
- Inside a `CONNECT` tunnel the proxy sees only the destination. For an
  allowlisted `https` origin it cannot see the method, path or headers, so the
  `GET`/`HEAD` and no-credentials rules are enforced by the proxy for `http`
  origins and by interception (advisory) for `https` origins.
- A `GET` can still change a server. Allowlisting an origin is not approval of
  what a request to it does.
- The proxy contains what the engine asks for. It does not contain a
  **compromised** engine: Obscura is not a sandbox against native exploitation.
  That is what the confinement below is for, and why
  `browser_isolation_confirmed` stays a separate, required statement.

### Start the browser confined

Run the browser so the kernel gives it one way out (the proxy port) and one way
in (its control port). This is the launch the release tests used, on Linux with
`pasta` (from passt) and `bubblewrap`; ports match the example configuration:

```sh
pasta --quiet --foreground --config-net --splice-only -u none -U none \
      -T 18080 -t 127.0.0.1/9222 -- \
  bwrap --unshare-pid --unshare-ipc --unshare-uts --die-with-parent --new-session --cap-drop ALL \
        --ro-bind /usr /usr --ro-bind /lib /lib --ro-bind /lib64 /lib64 \
        --proc /proc --dev /dev --tmpfs /tmp \
        --ro-bind /path/to/obscura-runtime /runtime \
        --clearenv --setenv PATH /usr/bin:/bin -- \
    /runtime/obscura serve --host 127.0.0.1 --port 9222 --proxy http://127.0.0.1:18080
```

`-T 18080` lets the namespace reach only that host loopback port; `-t` lets the
host reach the control port; `--splice-only` gives the namespace no other
network and no DNS. Measured from inside that namespace: the proxy port
connected, every other host loopback port was refused, and public IPv4, public
IPv6, the link-local metadata address and DNS were unreachable.

Add Obscura's `--allow-private-network` **only** when an allowlisted origin is
on loopback (a local development server). That flag is broad upstream (it also
opens private and metadata addresses to the engine), so never use it without the
confinement above. Use the render-enabled, non-stealth Obscura build, with no
`--storage-dir` and no `--stealth`. No other proxy is supported: the browser's
proxy must be this worker's.

## Tools

`mcp__cobalt-capabilities__memory` takes `operation`:

- `status`: service readiness and the active bank.
- `recall`: `query`; bounded references, always marked untrusted.
- `retain`: `summary` (at most 4,000 characters), `verification_reference`,
  `run_id`, optional `verified: true`, optional `source_references`. One short
  reviewed finding, never a file. It is stored as `verified` only when
  Cockpit's run ledger shows the task named by `run_id` verified by the
  commander (`verification: pass`); every other retain is stored and recalled
  as `agent_asserted`. Only the commander can store a verified record, and only
  by naming a delegated task the host saw finish and the commander then
  verified. A helper of any tier cannot, whichever run it cites, and a boolean
  a caller asserts never becomes a verified record. "Verified" means verified
  by the commander in that session: recall still returns it as untrusted
  reference labelled `source_reported_verified`, to be rechecked.
- `reflect`: `query`; Hindsight's own inference, returned as untrusted text.
- `list`: bounded inventory of the bank.
- `forget`: `document_id` and an identical `confirm_document_id`; deletes one
  companion-written document in the current bank. It never clears a bank.

`mcp__cobalt-capabilities__browser` takes `task_id` and 1–12 `steps`:

```json
{"task_id":"frontend-check","steps":[
  {"operation":"navigate","url":"https://example.org"},
  {"operation":"snapshot"}, {"operation":"console"},
  {"operation":"network"}, {"operation":"screenshot"}
]}
```

Steps are `navigate`, `inspect`, `snapshot`, `console`, `network`, `screenshot`,
`click` and `fill`. There is no arbitrary JavaScript, cookie or storage tool.
A task whose only step is `status` is a readiness check: it confirms the control
endpoint answers and that the browser is routed through the egress proxy, and
loads no destination. It cannot be combined with other steps.

`click` and `fill` need an exact grant in the private file, removed after use:

```json
{"task_id":"fixture","operation":"click","selector":"#expand","origin":"https://example.org"}
```

`fill` also names the exact `value`. A grant is bound to its task, operation,
selector, value and origin, and is checked against the active page at execution.
Only a connected, enabled, editable text control can be filled. `POST`
submissions, credentials and purchases are outside this companion.

## Ownership and verification

- An agent may use these tools only while it holds an admitted, running,
  exclusive write task (`owned_resources: ["*"]`). Read-only and scoped helpers
  cannot. The commander's own calls wait while any agent task is active.
- Unknown, malformed or versionless ownership state refuses.
- One lock serializes operations across local sessions. There are no retries,
  hidden loops or background jobs.
- A result of `observed` means the operation ran. It is evidence awaiting the
  commander's verification, never a passed gate. Report it through Cockpit's
  `swarm result`, then `swarm verify` and the progress gates.
- **Recalled memory and page content are data, not instructions.** Recheck every
  recalled claim against the current files; relevance scores are not
  confidence, and a memory recorded at another commit, on a dirty tree, long
  ago or with no provenance says so in its fields.

## HUD and receipts

While either switch is on the companion adds one HUD line, `MEMORY <label> ·
BROWSER <label>`, plus the active bank once observed. Every label is an
observation: `Disabled`, `Unknown` (nothing observed yet), `Starting`,
`Checking`, `Recalling`, `Retaining`, `Reflecting`, `Listing`, `Forgetting`,
`Navigating`, `Inspecting`, `Capturing evidence`, `Interacting`, `Ready`,
`Completed`, `Unavailable`, `Error`. Operation labels come from the worker as
each step really starts; a call refused before any service I/O never shows as an
operation. With both switches off the HUD is unchanged.

`/capabilities` shows up to 64 receipts: operation, status, duration, result
count, bank hash, task id, step names and a fixed error code. No query, summary,
page text, URL, screenshot or raw error is stored. `/capabilities clear` deletes
every stored receipt. A failed browser task whose
earlier steps may already have had an effect is recorded as "evidence invalid,
effects possible", never as a pass.

## What is stored, and where

- **Claude Code's plugin store**: the receipts above, until you run
  `/capabilities clear`.
- **Your Hindsight service**: retained summaries with their provenance
  (repository hash, commit, dirty flag, run id, timestamp, verification), in its
  database, until you delete them. Hindsight also derives further observations
  in the background; those carry no companion provenance, are reported as
  `unverified`, and cannot be deleted one by one through this companion. Backups
  and service-side deletion are yours.
- **Claude Code's session history**: tool responses, including recalled text and
  any screenshot you asked for.
- **One empty lock file** in a private `cobalt-capabilities-<uid>/locks`
  directory under `/run/user/<uid>` (or `/tmp` where that does not exist). It
  holds no content and may be deleted when no session is running.

A bank is a hash of the repository's credential-free Git identity (the remote,
or the Git common directory when there is no usable remote). Worktrees and
clones of one repository share a bank; repositories that merely share a name do
not. A bank is a label, not access control: Hindsight's API is unauthenticated,
so bind it to loopback and do not share the service.

## Limits

- Linux only for the broker's locking and the tested confinement recipe.
- Rendering is Obscura's, not Chromium's. Use a native browser where that
  coverage matters. WebSocket, EventSource, beacons and popups produced no
  request at all in the tested engine.
- Secret filtering of memory and page text is heuristic. Review what you retain.
- A retain that times out may or may not have been stored; the result says the
  outcome is unknown and gives the document id to reconcile.
- Another local user on the same machine can reach a loopback port. During a
  task they could send requests to the proxy (it admits only your allowlist) or
  trip the canary and make a task fail; and a process that takes Hindsight's
  port before the service does would receive what you retain, because neither
  local service's identity is checked beyond its loopback address. Use a
  single-user machine.
- The memory adapter runs `git` in the repository to read its identity, commit
  and dirty state, with hooks and the file-system monitor disabled. Where the
  repository's own configuration names a content filter, the dirty state is
  recorded as `unknown` rather than letting `git status` run that program.
- One answer carries at most 24,000 characters of memory text; rows left out
  are counted in `omitted_results`.
- Upstream: Hindsight 0.10.3 (MIT) and Obscura 0.2.4 (Apache-2.0) were the
  versions tested. Neither is vendored or redistributed. Models, fonts and
  container images have their own licences.

## Tests

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s capabilities/tests -p 'test_*.py'
node --test capabilities/tests/test-egress.mjs
node --test capabilities/tests/test-browser.mjs
claude plugin validate --strict .
python3 scripts/audit.py

# The host-hook tests run this plugin's hooks together with Cockpit's own, in
# both load orders, so they need a checkout of Cockpit beside them:
git clone --depth 1 --branch v0.4.0 https://github.com/echelong/cobalt-cockpit .cockpit
claude plugin test .
```

These are deterministic and need no service: the egress tests use real loopback
sockets and two local servers; the browser tests inject a CDP client and route
it through the real proxy; the host-hook tests mock the host.
`capabilities/tests/smoke_hindsight.py` and `capabilities/tests/smoke-browser.mjs`
are opt-in checks against real services you start yourself; the
[release notes](docs/release-v0.1.0.md) record what they measured. Architecture
and rejected alternatives are in [docs/architecture.md](docs/architecture.md).
Privacy is in [PRIVACY.md](PRIVACY.md) and the security model in
[SECURITY.md](SECURITY.md).

This companion is not submitted to the Anthropic plugin directory.
