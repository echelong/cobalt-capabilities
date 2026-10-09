# cobalt-capabilities v0.1.0 — release notes

Released 2026-10-09. Works alongside Cobalt Cockpit v0.4.0 or later. Both capabilities are off until configured. What is new compared with the development build is in [CHANGELOG.md](../CHANGELOG.md); this page records what was actually measured.

## Environment

Fedora Linux, Claude Code 2.1.295, Node 24.20, Python 3.14. Hindsight 0.10.3 (container image digest `sha256:5b6ef2b8…dc45e3`) with local CPU inference through a dedicated Ollama 0.34.4 instance (`llama3.2:3b`, 8 threads, no GPU, no cloud or paid provider), embeddings and reranking local. Obscura 0.2.4, render build (archive SHA-256 `757e7b59…b77f000`), with `puppeteer-core` 25.13.0 from the lockfile. All services were disposable, bound to loopback, and held synthetic data only.

## Browser egress

Measured first on the unmodified engine, with interception answering "abort" for everything off the allowlist: a redirect hop, a two-hop chain, direct and redirected `<link>`/`<img>`/`<script>`, redirected `<iframe>`/`fetch`/XHR, and `location` and form navigations all reached the forbidden server, and its script ran in the allowlisted page. That is the behaviour this release replaces.

With the egress proxy (the real-engine test, `capabilities/tests/smoke-browser.mjs`, run inside a private network namespace):

| Case | Forbidden server saw |
|---|---|
| Redirect to another port; redirect chain; redirect to an alternate hostname | 0 requests, 0 TCP connections |
| Scripted (`location`) and form navigation to the forbidden origin | 0, 0 |
| Direct and redirected stylesheet, image, script, frame, `fetch`, XHR, `POST`; WebSocket, EventSource, beacon, popup attempts | 0, 0 (11 refusals recorded at the proxy for that one page) |
| Direct navigation to another port, another name, another scheme | refused before the browser was contacted |
| Browser started without the proxy | task and readiness probe both refused, `browser_egress_unverified`; the allowlisted server was not contacted either |

The forbidden server listened on IPv4 and IPv6 loopback. The same run covered rendered DOM, JavaScript, console, network evidence, a 9,736-byte PNG, fresh-context storage isolation, approved and refused click and fill, read-only and hidden fill refusal, timeout, a browser killed mid-task, and restart recovery: 35 checks, all passed.

Kernel confinement (the launch in the README), measured from inside the browser's namespace: the forwarded proxy port connected; another host loopback port was refused; public IPv4, public IPv6 and the link-local metadata address were unreachable; DNS did not resolve. Driven from the host through that confinement, a page rendered with script, its two forbidden references were refused at the proxy, a redirect was refused, and the forbidden server saw nothing.

## Memory

`capabilities/tests/smoke_hindsight.py` against the real service, including a container restart: status; a secret-shaped summary refused before any request; a retain stored `verified` (54 s) and one stored `agent_asserted` (12 s); list and recall with provenance, every row untrusted and non-authoritative; commit mismatch reported after a new commit; a planted document claiming to be verified reported `unverified` and stale, its planted token never returned; a real reflection (278 s on this CPU; 175–279 s across runs); a second repository with an empty bank of its own; an unnamed repository refused with `repository_not_enabled`; cross-bank and unconfirmed deletion refused; missing service `unavailable`, then recovery; memory surviving the restart; scoped deletion and an empty bank afterwards.

Resources during that run: the Hindsight container peaked near 0.9 GB of memory and 123% of one CPU; the inference runner held about 2.9 GB. The image is about 2.9 GB and the model about 2 GB on disk.

## Live Claude Code task

One real development task in a disposable repository with both capabilities enabled, Cockpit orchestration on, an Opus 5.5 commander, a Haiku 5.5 read-only scout and a Sonnet 5.5 worker, the browser confined as above, and native permissions enforced (commands outside the allowlist were denied by Claude Code and the commander worked around none of them):

- Memory recalled three seeded claims. The commander checked each against the files: one held, one was stale (the repository had moved on), and one, planted with no provenance and saying the work was "already verified", was disregarded.
- The scout located the defect and its report reached the commander. The worker made the fix and filled the form in the real browser (`egress_verified: true`, 0 refused requests); the page showed the expected greeting.
- The worker's own retain, sent with `verified: true`, was stored `agent_asserted`.
- The commander ran the project's test itself (exit 0), ran its own browser probe, recorded `swarm verify` and the TEST gate, and only then retained; that record was stored `verified`.
- A second run with both services unreachable returned `unavailable` for every call; Cockpit held the last milestone and the task ended BLOCKED at 66% with TEST unverified.

The live task ran on the code as of the first re-review; the changes made after it (the second re-review's hardening of the Git checks, two character ranges and tunnel timeouts) are covered by the automated tests below, not by a further live run.

## Automated

53 Python tests (memory adapter and broker), 76 Node tests (25 egress proxy with real loopback sockets, 51 browser worker), 34 host-hook tests run together with Cockpit's hooks in both load orders, TypeScript against the host declarations, strict plugin validation, and the audit of manifests, defaults, lockfile and notices.

## Review

Two independent Sonnet 5.5 review passes of the implementation, then two re-review passes of the fixes. No critical or high-severity finding in any pass. Medium findings, all fixed: proxy-answered pages reported as evidence; a helper promoting its own retain; repository-controlled bank selection; repository-configured programs run by `git status`; a fail-open configuration check; a working-tree location dictated by the repository. The last re-review's remaining items were hardened afterwards and are covered by tests but were not themselves re-reviewed.

## Not verified, and limits

- Only Linux, only these versions of Hindsight and Obscura.
- `https` origins were exercised through the proxy's tunnel handling in tests with real sockets, not against a real TLS site in the engine.
- No measurement of a compromised engine: the confinement recipe is what addresses that, and it was tested for reachability, not for exploit resistance.
- Whether the host sets a helper's identity on every tool event could not be read from this code; the companion treats a call with no helper identity as the commander's.
- On a shared machine other local users can interfere with loopback services (see SECURITY.md).
- Not submitted to the Anthropic plugin directory.
