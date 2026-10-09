# Hindsight and Obscura integration architecture

Research date: 2026-10-09. `cobalt-capabilities` is released from its own
repository and works alongside Cobalt Cockpit v0.4.0 or later. What was measured
for the release is in [release-v0.1.0.md](release-v0.1.0.md). "Cockpit" and "the
base plugin" below mean [Cobalt Cockpit](https://github.com/echelong/cobalt-cockpit);
its hook modules are named for orientation and live in that repository.

## Existing architecture and integration boundary

`hooks/hooks.json` registers only `register.tsx`. That host module registers
progress/swarm tools, commands, native event guards, HUD and Run Ledger. The
other hooks reduce bounded observations: `model.ts` verification-gated task
progress; `swarm.ts` dependency/admission/ownership; `orchestra.ts` role and
review admission; `model-policy.ts`, `effort.ts` model/effort policy;
`ledger.ts` accounting; `replay.ts` sanitized bounded repository deltas;
`auth.ts`, `policy.ts`, `guard.ts`, `hygiene.ts` refusals; `nwho.ts` read-only
local decision receipts. View/field/progress/mascot modules render those
observations; sound/git/process helpers are existing bounded local effects.
Six agent definitions select the existing Sonnet/Haiku pools. The main loop's
effort remains operator-owned. Neither new service supplies models or agents.

Native tool permission decisions remain with Claude Code: no `tool.check`
hook is added. Bound helpers may call the two effect-free native control tools —
`ToolSearch` for deferred-tool discovery and `SubagentHandback` for a helper's
report to its native parent — without widening ownership; every tool discovery
surfaces still passes its own ownership and native-permission guard, delegation
stays commander-only, and a handback only records the helper's own report. A
helper's report delivery is tracked on its task (`reported`, `host_accepted`,
`answer_observed`, `unavailable`) so it is observable and is never treated as
verification. Since the custom handler answers before core execution, it
queries the supported native check explicitly and proceeds only on `allow`;
`ask`/`deny` refuse before config, worker or service I/O. Existing custom effects under orchestration require
exclusive wildcard writer ownership, and commander effects wait for active
agents. The companion checks this again, even if orchestration is disabled;
unbound agents are refused. A fixed per-UID local file lock serializes separate sessions. Companion
admission/forwarded-effect fences prevent load-order races with agent spawning
and concurrent main effects, independently of the base hook fence.
No agents are automatically spawned, no model requests rewritten, no gate
passed by memory or browser tools. The commander integrates untrusted evidence
and decides verification using the existing progress/swarm interfaces.

This repository is an independently loaded Claude mod.
The base manifest, hooks, types and agent definitions are unchanged. Companion
host tools call a small Python broker by argument vector and bounded stdin,
never a shell. Broker reads only private operator JSON and invokes either the
stdlib REST adapter or the optional Node CDP worker. Its own HUD and receipt
store form the complete capability record. Base tool-call telemetry is
load-order dependent when the companion answers first; structured results
through the existing swarm/progress interfaces link evidence to the base run. Disabled calls skip
the worker/config/service entirely. No mandatory dependency in the base plugin.

HUD operation labels are observations, not inferences from the request. The
broker and the browser worker write one fixed-shape line per started operation
(`{"cobalt_step":"<name>"}`, an enumerated name and nothing else) to standard
error: the memory adapter when a validated request is about to be issued to
the service, the browser worker when a step begins. The host starts the broker
with `$.process.spawn`, reads that stream and maps each known name to a label;
every other byte on the pipe is discarded unread, and nothing from it is
stored. A call refused before service I/O therefore shows `Starting` and then
its result, never an operation.
The same loop bounds the worker: at the host deadline or on the dispatch's
abort signal (a user interrupt) it leaves the stream, which ends the child,
and records `worker_unavailable_or_timeout` or `interrupted`. A worker that
may already have changed something (navigate, click, fill, retain, forget)
is then recorded with possible effects; a worker that never started is not.

The companion is its own repository, its own marketplace and its own plugin
folder: installing Cockpit brings none of its files, and Cockpit's repository
contains none of its code. It has not been submitted to the Anthropic directory.

## Hindsight

Reviewed release [0.10.3](https://github.com/vectorize-io/hindsight/releases/tag/v0.10.3).
The [supported OpenAPI](https://github.com/vectorize-io/hindsight/blob/v0.10.3/hindsight-docs/static/openapi.json)
defines retain/recall/reflect, memory list and document deletion under
`/v1/default/banks/{bank_id}`. Cockpit offers only these narrow operations and
health status, not bank configuration/directives, full bank deletion or broad
upstream tools. Requests have wall-clock deadlines and response limits; no
redirects/proxies/cloud endpoint or credential input is accepted in v1.

Bank identity is SHA-256 of canonical credential-free Git origin identity
(transport/userinfo stripped, host normalized, repository path preserved),
or canonical Git common-dir when no suitable remote exists. Thus identical
basenames remain isolated and worktrees share project knowledge. Two clones of
the same repository share a bank deliberately. A changed remote can select a
different bank. Hashes are logical identifiers, not tenant access control.

Memory is used only in the working trees the operator lists in
`memory_repositories`. The bank is derived from what a repository says about
itself, so without that list a repository delivered with another project's
remote would be handed that project's memory; an unnamed repository is refused
before the bank is derived or the service is contacted.

Retain accepts one <=4,000-character manually reviewed summary with explicit
verification reference and run ID; commit, dirty-tree indicator, timestamp,
repository hash, document UUID and optional source references accompany it.
Retention and independent inference require separate operator configuration.
No transcript, prompt, hidden reasoning or source-file read API exists.
Secret detection is heuristic: the operator must review admitted summaries.
Service output is bounded/sanitized and tagged untrusted/non-authoritative,
including purported verified findings. Freshness is a local timestamp/commit
indicator, not proof. Scores measure relevance, not factual confidence.
Deletion needs the exact companion document ID repeated, within current bank.
The adapter never clears a bank. Timeout during retention has an uncertain
remote outcome; no automatic retry or claim of successful retention follows.

A retain is stored as `verified` only when the commander itself makes it and
names a delegated task that the host observed to its end and the commander then
verified. A helper of any tier is always stored as `agent_asserted`, whichever
run it cites, and so is a task the commander only declared for itself. This
records the commander's act in one session; it is not external proof, and recall
returns the row as untrusted `source_reported_verified` reference. One answer
carries at most 24,000 characters of memory text and counts the rows it left
out. Git is run for identity, commit and dirty state with hooks and the
file-system monitor disabled; where the repository's own configuration names a
content filter the dirty state is recorded as `unknown` instead of letting
`git status` run that program.

Hindsight consolidates retained documents in the background into derived
observations. The real service returned these without a document ID or any of
the companion's provenance, so the adapter reports them as `unverified` with
unknown freshness and cannot delete them individually. In the real smoke they
disappeared once their source documents were deleted (the bank listed empty);
that is upstream behaviour, observed rather than guaranteed, so check the bank
inventory after a deletion that matters.

Hindsight requires Python >=3.11, PostgreSQL/pgvector or its development pg0,
embedding/reranking and separately configured generation inference. The full
image is large; API minimum documented RAM ~1.5 GiB, plus database and model
memory. The [local inference deployment](https://github.com/vectorize-io/hindsight/blob/v0.10.3/docker/docker-compose/local-llm/README.md)
supports local CPU/GPU models without paid accounts. Its database, models and
caches need several gigabytes on a volume of the operator's choosing. Do not
assume subscription auth.
Disable `HINDSIGHT_API_LLM_TRACE_ENABLED` explicitly; upstream defaults can
store full inference prompts/output. Model/cache downloads and provider traffic
are separate from Claude Code model routing. Service operator controls backups,
traces, deletion and authorization; banks alone do not protect a shared API.

Rejected: upstream [Claude integration](https://github.com/vectorize-io/hindsight/blob/v0.10.3/hindsight-integrations/claude-code/README.md)
defaults to auto recall, full transcript/tool retention and basename banks;
direct upstream MCP exposes broader tools and doesn't enforce Cockpit
ownership. Embedding its runtime in the public mod adds unnecessary size,
process/inference/storage privileges. No upstream source is vendored (MIT).

## Obscura

Reviewed [0.2.4](https://github.com/h4ckf0r0day/obscura/releases/tag/v0.2.4).
This is a Rust/V8 browser engine with real JS, DOM and CPU rendering, not
Chromium. Its documented [CDP client interface](https://github.com/h4ckf0r0day/obscura/blob/v0.2.4/docs/Connect-Puppeteer-or-Playwright.md)
and [request interception](https://github.com/h4ckf0r0day/obscura/blob/v0.2.4/docs/Intercept-and-modify-requests.md)
are used through pinned `puppeteer-core`, not a custom protocol. No browser
runtime is downloaded or spawned by normal tools. Operator provides a dedicated
isolated loopback CDP service, without personal cookies, persisted storage,
proxy or stealth. OS/network isolation is mandatory operator configuration;
Obscura's [security boundary](https://github.com/h4ckf0r0day/obscura/blob/v0.2.4/SECURITY.md)
does not contain native V8 exploitation.

Each bounded task creates a fresh browser context and closes it in finally;
cleanup failure invalidates evidence without hiding effects that may already
have happened. All planned URLs are preflighted before connecting.

### Egress: where the origin policy is enforced

Measured on Obscura 0.2.4, CDP request interception is advisory. With
interception answering "abort" for everything off the allowlist:

| Request | Reached the forbidden server |
|---|---|
| Navigation redirect hop, and a two-hop chain | yes |
| Parser-inserted `<link>`, `<img>`, `<script>` (direct) | yes, and the script executed |
| The same resources redirected from the allowlisted origin, plus `<iframe>`, `fetch`, XHR | yes |
| `location.href` and form `GET` navigation | yes |
| Direct `fetch`, XHR, `<iframe>`, `POST` | no (interception honoured) |
| WebSocket, EventSource, `sendBeacon`, `window.open` | no request issued by this engine |

A second CDP session with the raw Fetch domain received no pause events at
all, so neither a response-stage refusal nor request fulfilment is available.
Interception therefore cannot be the boundary, and detecting the landing after
the fact is not containment.

The engine does honour a configured proxy for every one of those requests, each
redirect hop included. So the policy is enforced outside the browser:

- The browser worker binds a policy proxy on `browser_egress_proxy` (numeric
  loopback, a port of its own) for the duration of one task; the browser
  service is started with that address as its proxy. The setting is mandatory.
- Per request, before any connection: absolute-form `http` only, `GET`/`HEAD`,
  no body, no userinfo, no `Authorization`/`Proxy-Authorization`/`Cookie`, exact
  allowlisted origin, no credential-shaped URL, and an address check on what
  the name resolves to for this request (loopback only with separate consent;
  private, link-local, metadata and reserved ranges refused; every answer must
  pass). The connection is made to that vetted address literal, so the name is
  not resolved a second time and a rebinding answer has nothing to change.
- `CONNECT` is tunnelled only to an exact allowlisted `https` origin at its
  vetted address; anything else, and every upgrade, is refused. The proxy
  follows no redirect: a redirect is simply the browser's next request.
- Attestation precedes everything. A throwaway page loads a one-time address
  under a reserved `.invalid` name, which only a browser routed through this
  task's proxy can deliver. The page returned references a canary listener by
  stylesheet, image, script, frame, `https` image (the tunnel path), `fetch`
  and XHR. The task is refused with `browser_egress_unverified` unless the proxy
  saw the proxied attestation request, saw no origin-form request, and the
  canary received no connection. The canary stays armed for the whole task and
  is checked before every step and before evidence is returned.
- Every answer the proxy writes itself (a refusal, an upstream failure) is a
  page whose title names the task. Before every step the worker checks the
  active document's title as well as its address, so a proxy-answered page is
  never returned as evidence of the site.
- The proxy closes when the task ends, taking every connection with it.
  Between tasks the browser has no route. Tasks take the port in turn.

Limits that remain, stated rather than worked around: inside a `CONNECT` tunnel
the proxy sees only the destination, so for `https` origins the method and
header rules rest on interception; a `GET` can change a server; attestation
proves the engine's fetch paths go through the proxy, not that a compromised
engine cannot open a socket. The last is why operating-system confinement is
still required and still a separate operator statement
(`browser_isolation_confirmed`): the tested launch gives the browser's network
namespace one forwarded port out (the proxy) and one in (the control endpoint),
with no other network and no DNS. The upstream global private-network switch
must never be described as localhost-only authorization, and is used only
inside that confinement when an allowlisted origin is on loopback.

A task whose only step is `status` is a readiness probe: it validates the whole
configuration, connects to the control endpoint, runs the attestation in a
throwaway context and loads no destination. It is the only way the browser HUD
shows `Ready`, and it is not ready if the browser is not behind the proxy.

Fixed DOM extraction, snapshot, console/network observation, PNG screenshot,
and exactly granted click/fill return untrusted structured evidence. No
user-supplied evaluate, cookie access, storage import or file access tool.
Screenshots require ephemeral consent; network metadata drops path/query.
Page/console text secret redaction is heuristic, not guaranteed DLP. A GET
may mutate a server; origin authorization isn't semantic effect approval.
POST submissions, credentials, purchases and unrestricted destructive actions
are outside this adapter's supported effects. Actual execution never passes a
verification gate automatically. Maximum 12 steps, 30-second browser deadline,
bounded text/images/aggregate output. Resource limits must also bound service
CPU/RAM: V8/CPU rendering can consume substantial resources; no reliable
general workload estimate was measured.

Rejected: direct [upstream MCP](https://github.com/h4ckf0r0day/obscura/blob/v0.2.4/docs/Use-the-MCP-server.md)
shares context/cookies across clients and exposes storage/evaluate tools without
the required per-request host policy; `browser_close` isn't context isolation.
Embedding Rust/V8 in Cockpit would enlarge privileges/runtime and couple plugin
availability to an immature engine. Obscura is Apache-2.0; manual external
runtime installation avoids binary redistribution. Rendering is incomplete
relative to Chromium, so use native browser verification when that coverage
is needed. No stealth/anti-detection capability is enabled by this integration.

## Policy and rollout

The [Anthropic Software Directory Policy](https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy)
limits history/user-file extraction, dynamically loaded behavioral instructions
and arbitrary remote connections. Curated technical findings, explicit
consent, untrusted recall and operator-controlled endpoints reduce risk but
do not establish eligibility. The [submission checklist](https://claude.com/docs/plugins/pre-submission-checklist)
also reviews external launchers/services and dynamic execution. This companion
requires independent review, especially memory persistence/inference and
generic browser networking. No scanner bypass or concealed capability.

Suggested adoption: one disposable repository first, memory recall and manual
retention only; review the bank, provenance and deletion; then bounded local
frontend browser evidence under the confined launch. Leave both off wherever
they are not needed. The companion is released publicly from its own
repository; it has not been submitted to the Anthropic directory. See
[release-v0.1.0.md](release-v0.1.0.md) for what was tested and what was not.
