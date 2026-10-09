> **Historical record.** This is the development delivery report written on 2026-10-09, when the companion lived in a `companions/` directory of the Cobalt Cockpit repository (commits `6700483` and `796171e` there). It is kept as written. Paths, versions and the statement that a redirect hop reached a forbidden origin describe that build; the released behaviour is in [architecture.md](architecture.md) and [release-v0.1.0.md](release-v0.1.0.md).

# Optional capability delivery — 2026-10-09

Development implementation for the next feature release. The public plugin
version remains v0.3.2; the separate companion is provisionally 0.1.0.
Both capabilities default OFF. This work is committed and pushed on `main`; no
release tag was created and no changed Anthropic directory submission was made.
No production installation or host settings change occurred.

## 1–2. Architecture and actual functionality

Hindsight uses a narrow stdlib Python REST client against an independently
operated numeric-loopback API. Implemented status, explicit recall, reviewed
verified-summary retain, reflect, bounded list and scoped forget. Provenance
includes repository hash, HEAD, dirty status, run, timestamp, verification and
source references. Recall is always untrusted/non-authoritative and includes
age/commit/relevance indicators, never claimed factual confidence. Service
failure falls back safely; ambiguous retention reports an unknown outcome and
document ID for reconciliation. A retain is stored as `verified` only when the
Cockpit run ledger shows the matching task commander-verified
(`verification: pass`); every other retain is stored and recalled as
`agent_asserted`. Reflection is implemented, mock-tested and exercised against
real local inference (175 s, real generated text).

Obscura uses its supported CDP interface through pinned puppeteer-core. Tasks
create/close a fresh context, apply request policy, navigate and inspect real
JS-rendered DOM, capture readable snapshots/console/network metadata and
optionally ephemeral PNGs. Click/fill need exact private operator grants bound
to the task, operation, selector/value and exact origin; fills are refused
unless the target is a connected, enabled, editable text control. A failed
task discloses its completed operation names and possible effects instead of
reporting a passed task.
No arbitrary agent JavaScript, cookie/storage tools, credential submissions,
POST forms, stealth or proxies. Execution returns structured untrusted evidence
pending commander verification, never an automatic pass.

Read-only completion is a first-class path. The native host control tools
`ToolSearch` (deferred-tool discovery) and `SubagentHandback` (a helper's report
to its native parent) carry no resource effects, so a bound read-only task, or a
bounded writer, may use them without acquiring write permission; every tool they
surface still passes its own ownership and native-permission guard, and
delegation stays commander-only. A helper's own `swarm result` is recorded as
`reported`, a native handback the host accepted as `host_accepted`, an ordinary
observed final answer as `answer_observed`, and a host completion with no answer
evidence as `unavailable`. That state is surfaced in `swarm status` and the Run
Ledger, so a lost report is visible rather than silently absent. This replaces a
defect where a read-only helper's guard refused both discovery and native
handback, so its findings never reached the commander.

The separate native Claude mod registers tools, calls a bounded broker by
argument vector/stdin, checks native permission (`allow` only), and fences
ownership/admission/effects independently of plugin load order. No orchestrator,
agent pool, model provider or routing layer is introduced. NobodyWho remains
the existing read-only local decision/pruning/control layer. Full analysis and
rejected alternatives: [architecture](architecture.md).

## 3. Files changed

Added companion manifest, native hooks/state contract, private config example,
README/license/notices, Python broker/memory adapter, Node browser worker,
pinned optional npm package/lockfile, deterministic Python/Node tests and two
opt-in real-service smoke scripts under `companions/`.

Added `tests/capabilities.test.ts`, this report, architecture/setup documentation
and bounded [real evidence metadata](development-evidence-2026-10-09.json). Updated README,
SECURITY and PRIVACY to distinguish base behavior from enabled capabilities.
CI gains an independent offline adapter job plus companion strict/type checks.
`.gitignore` and the public audit exclude only host-generated declarations and
Python bytecode; authored companion code remains audited.

Unchanged: base `.claude-plugin` manifests, all registered base hooks/types,
all six agent definitions, model hierarchy/effort, base HUD styling and core
Run Ledger/verification logic. The original submitted commit is preserved.

## 4–5. Dependencies and exact configuration

See the complete [setup/configuration instructions](../README.md)
and [tested disposable service recipes](smoke-setup.md). Required:
Claude Code 2.1.294 for this verification, Linux Python >=3.11, and browser-only
Node >=22.12 with optional puppeteer-core25.13.0. Hindsight0.10.3 independently
needs a database/embeddings/reranker/generation inference; Obscura0.2.4 needs
the render-enabled, nonstealth binary and OS/network isolation. Neither is a
base plugin dependency or automatic installer. Upstream license/runtime/model
conditions are documented and no full upstream repository is vendored.

Copy the companion into a separate `/mnt/mem2` development installation, use
its lockfile with `npm ci --ignore-scripts`, and load it explicitly alongside
the checkout. In supported plugin configuration set `configurationPath` to a
UID-owned regular 0600 JSON file and enable only the desired host switch.
Separately enable the same private JSON switch. Native `/permissions` approval
of the exact tool is also required; enable switches never imply permission.

Memory config: `memory_enabled`, numeric-loopback `hindsight_endpoint`,
`memory_retention_consent`, `memory_inference_configured`,
`memory_timeout_ms` (100–300000; local CPU reflection measured 175s in the
real smoke; non-inference observations carry their own 30 s cap). Browser
config: `browser_enabled`, loopback
`obscura_endpoint`, exact `browser_allowed_origins`, independent
`browser_allow_localhost`, `browser_isolation_confirmed`,
`browser_timeout_ms` (100–30000), origin-bound `browser_authorized_actions`,
`screenshot_retention` (`none` or `ephemeral`). No credential inputs or automatic
recall/transcript hooks. Explicit task-start recall is available to commander.
Fixed per-UID operation locks live under `/mnt/mem2`; configurations cannot
select different lock directories and bypass cross-session exclusivity.

## 6–8. Isolation, security/privacy, HUD and ledger

Bank ID hashes canonical credential-free Git repository identity, with verified
Git common-dir fallback; same repository worktrees/clones share a bank, unrelated
repository basenames do not. Remote changes may change bank selection. Logical
banks do not substitute for service tenant authorization.

Only reviewed short findings/provenance or explicit queries go to Hindsight;
no transcript/source-file read API. Generation/embedding/reranking/consolidation
are Hindsight's separate inference and must be explicitly configured. Tested
deployment used local CPU Qwen with tracing/audit storage disabled. Enabled
browser networking and untrusted JS are explicit: Obscura is not a native
exploit sandbox. External OS/egress isolation is required for DNS rebinding,
WebSockets, popup races and the broad upstream private-network flag. Contexts
never inherit personal cookies. Secret filtering is heuristic; GET can mutate
a server. Native permission deny/ask, missing ownership and resource conflicts
refuse before worker/config/service I/O.

The optional static HUD row displays observed tool activity/readiness and bank;
both switches off leave the HUD untouched. `/capabilities` displays/stores
64 projected metadata receipts: operation, result count, duration, bank/task,
browser operation names and fixed fallback/error codes. Queries/findings/page
contents/URLs/PNG bytes are not stored in receipts. Explicit ephemeral PNG/tool
responses can still enter Claude Code's own session history.

Base tool-call telemetry depends on hook order when the companion answers
first; the dedicated companion receipt is the complete capability record.
Commander structured `swarm result`/verification links evidence to the base
run. No automatic gate pass, simulated browser result or inference progress.

## 9–10. Verification and real end-to-end evidence

| Check | Observed result |
|---|---|
| Full final plugin suite | 1028 passed, 0 failed (includes lifecycle, retain-corroboration, read-only result-delivery and bookkeeping tests) |
| Read-only completion result-delivery regressions | 7 host-hook tests: discovery + native handback delivery, concurrent read-only reports with a failing sibling, no write consent from discovery, preserved native rejection, completion racing inside the handback tool, interrupted report retention, host completion with no answer evidence |
| Hindsight/bridge deterministic Python suite | 43 passed, 0 failed |
| Obscura deterministic Node suite | 39 passed, 0 failed; injected CDP client |
| Root and companion TypeScript | Passed against generated Claude declarations |
| Strict root/manifests/agents/companion validation | Passed on Claude 2.1.295 |
| Public audit | Passed, 0 portability/credential findings |
| Git whitespace | Passed |
| Real Hindsight 0.10.3/local CPU Ollama | Status/retain(verified,confirmed)/list/recall/reflect/forget/failure/recovery passed |
| Real Obscura 0.2.4 isolated namespace | JS/DOM/PNG/console/network/isolation/unauthorized+approved click/fill, readonly+hidden refusal, redirect-after-hop refusal, timeout/recovery passed |
| Real Claude Code task with both companions enabled | Opus commander plus Haiku scout and Sonnet worker: memory status/recall(reflect 213,717 ms)/retain(listed as agent_asserted)/list/forget, browser fill observed with the test gate exiting 0, commander swarm verify pass and a ledger-corroborated verified retain; 0 permission denials (`host-run-3.json`) |

The new source-guard tests run the actual two hook implementations in both
orders with a mocked host, including admission/effect races and native deny/ask.
They are deterministic tests, not an enabled Claude conversation smoke.

The final commit re-ran the offline suites, both TypeScript projects, strict
validation, the public audit and the Git whitespace check. The real
Hindsight/Obscura service evidence and the real Claude host-task evidence below
are from the runs recorded in this same working tree; they were not re-executed
for the final commit because those disposable services were intentionally
stopped and no companion service is started or installed without explicit
authorization. Their deterministic, mock-backed counterparts were re-run and are
green. No Claude model call was made for this commit.

Real Hindsight: dedicated Podman storage/pg0 and isolated CPU-only
Ollama qwen2.5:3b. First successful retain72,220ms; final retain30,478ms with
CPU prompt cache, recall3 extracted findings65ms, own document deletion11ms,
zero findings afterward. The fixed-adapter run retained in 46,040 ms
(verification_status verified, outcome confirmed), listed/recalled the stored
finding (real reranker/semantic/keyword scores), generated a real reflect
answer in 175,435 ms, deleted its own document in 16 ms, then listed zero
findings. A verified disposable stale-lock failure/recovery
fixture supplied the admitted summary. Missing endpoint reported unavailable
and real endpoint recovery ready. No paid/cloud inference or production data.

Real Obscura: pinned archive checksum matched upstream; bubblewrap fresh
network namespace, read-only runtime/worker mounts, tmpfs and cleared environment.
Real JS mutation and localStorage isolation, console.error, network200, blocked
foreign page request (server 0 hits), metadata refusal, unauthorized click
refusal/granted click, unauthorized fill refusal, fill-value mismatch refusal,
approved fill mutating the real DOM, deadline failure and fresh recovery all
passed. The hardened rerun added readonly and hidden fill refusal, refused a
navigation that redirected off the allowlist after landing, and recorded that
the redirect hop itself reached the non-allowlisted target once (documented
residual; egress isolation is the containment), with a 9,736-byte PNG. No
screenshot persisted.

All created services stopped. Hindsight container/image/model/db in the
dedicated store were removed; existing Ollama/Podman resources preserved.
Browser test binary/dependencies/cache and isolated host config were removed.
Only small Hindsight evidence/logs (~68KiB) remain under `/mnt/mem2`.
Replaying requires explicit setup again; smoke scripts never install services.

## 11–12. CI and Anthropic directory

The new independent Actions job uses Python stdlib and Node mocks without
installing puppeteer/browser/database/models or contacting an integration
service. Existing verify job keeps offline plugin tests and adds companion
strict/type checks. Its relevant test/type/validation/audit commands passed
locally. The CI run for the pushed commit is reported in the final delivery response.
The existing main workflow [run37767849204](https://github.com/echelong/cobalt-cockpit/actions/runs/37767849204)
was successful at baseline commit9fabc6692e85b507b96bfc9b618ca39ad667dea1.

Directory eligibility is unresolved, not certified by local strict validation.
Networking, memory persistence, independent inference, external processes/CDP
and browser JavaScript require explicit policy review. A repository-root
submission can include companion files even though runtime registration is
separate; future packaging must deliberately exclude them unless approved.
No scanner restrictions are concealed/bypassed, and the submitted version is
unchanged publicly. Do not request portal revalidation automatically.

## 13–15. Limitations, rollout and Git

Remaining limits: a navigation redirect hop can reach a non-allowlisted origin
before the policy refuses the landing, and WebSocket handshakes are outside
request interception; operator OS/egress isolation remains the containment.
Neither local listener's identity is verified beyond loopback binding, so a
multi-user host is not fully covered. General browser conformance and
public-network containment are not established; this is Linux-only broker
locking and loopback-only services without credential support. CPU retention
and reflection need the configured long timeout and workload-specific
validation. Companion receipts project observed/possible-effect state rather
than copying commander verification; receipt writes merge with the store, but
two concurrent sessions can still race between read and write.

Independent security/privacy/architecture review by Claude Sonnet 5.5 found no
critical or high-severity defect and four medium findings (quadratic
secret-scan backtracking on service-supplied text, self-asserted retain
verification, hidden effects after a failed browser task, and a completed
effect reported as refused), all fixed with focused tests; lower-severity and
hardening findings were fixed or documented. A second Sonnet re-review checks
the fixes for regressions. A real enabled Claude Code task with both
companions ran end-to-end (evidence/host-run-3): the Sonnet worker's
uncorroborated retain was stored as agent_asserted, its recall of an empty bank
returned a ready empty list, its browser fill mutated the real fixture DOM, the
commander's own test command exited 0, and the commander's retain was stored as
verified only after it recorded the verifying task in the run ledger.

Recommended rollout: private explicit companion install for one disposable
repository; memory manual recall/retention only; then local frontend evidence
inside actual OS/egress isolation. Leave both off globally. Obtain directory
review and owner publication approval before any public integration release.

Work stayed on `main`, starting from clean9fabc6692e85b507b96bfc9b618ca39ad667dea1.
Base manifests remain0.3.2. Changes are committed only after checks; the final
delivery response supplies the final commit hash, the CI run and the clean
working-tree state. No branch/history rewrite, force-push, release tag,
production installation or directory-submission change. This delivers real optional adapter capabilities with the
documented remaining feature-release acceptance limits above.
