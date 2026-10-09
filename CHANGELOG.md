# Changelog

## 0.1.0 — First release

The first release of `cobalt-capabilities` from its own repository. It works alongside Cobalt Cockpit v0.4.0 or later and is installed separately; both capabilities are off until configured. The code was developed inside the Cobalt Cockpit repository (commits `6700483` and `796171e` there) and moved here before release, so that Cockpit's own plugin folder holds only Cockpit.

### What it adds

- Memory: explicit `status`, `recall`, `retain`, `reflect`, `list` and `forget` against a Hindsight service you run on loopback, with provenance (repository, commit, dirty state, run, timestamp, verification) on what is retained and freshness and commit match on what is recalled. No transcript or file ingestion exists.
- Browser: bounded tasks (navigate, inspect, snapshot, console, network, screenshot, and exactly granted click and fill) in a fresh context of an Obscura service you run, returning untrusted evidence that awaits the commander's verification.
- A HUD line and a `/capabilities` pane with up to 64 content-free receipts; `/capabilities clear` deletes them.
- Each capability needs a switch in the plugin's settings, the same switch in a private operator file, and approval of its tool in `/permissions`. Nothing installs or starts a service, a model, a database or a browser; the browser's one Node dependency is installed by you from a pinned lockfile.

### Security, compared with the development build

- **Browser requests are contained before they leave.** On Obscura 0.2.4, request interception turned out to be advisory: with interception answering "abort", a redirect hop, a parser-inserted image, stylesheet and script, and scripted and form navigations all still reached a forbidden origin, and a forbidden script executed. The development build detected only the first of these, after the fact. The origin policy is now enforced by an egress proxy that the browser worker runs for the length of each task and that the browser must be started behind. Every request is judged there before any connection is opened: exact allowlisted origin, `GET`/`HEAD`, no credentials, at the address resolved and vetted for that same request, which also closes DNS rebinding. `CONNECT` is tunnelled only to an allowlisted `https` origin; upgrades are refused.
- **No unverified browser, and no fallback.** Before anything else loads, each task makes the browser prove it is routed through the proxy and has no route around it. A browser that cannot is refused with `browser_egress_unverified` and navigates nowhere. `browser_egress_proxy` is a required setting.
- Measured against real Obscura with an allowlisted server that redirects to a forbidden one: zero requests and zero TCP connections at the forbidden server for a redirect, a redirect chain, an alternate hostname, a port change, scripted and form navigations, and direct and redirected subresources; a browser started without the proxy was refused. A launch that confines the browser at the kernel level to the proxy port alone is documented and was tested.
- A page the proxy answered (a refusal, a refused or failed tunnel, an unreachable server) is never returned as evidence of the site, whatever address the page reports, and a navigation that commits nothing is not an observed page.
- A helper cannot store a verified memory by citing someone else's verified run. Only the commander can, and only by naming a delegated task the host saw finish and the commander then verified.
- Memory works only in the working trees the operator lists (`memory_repositories`). A repository that claims another project's remote, or that dictates its own working-tree location through `core.worktree`, is not handed that project's bank.
- The memory adapter does not let `git status` run a content filter that the repository itself configures, does not enter submodules, and treats a configuration it cannot read cleanly as unknown rather than as clean.
- Invisible characters are stripped by Unicode category in memory and page text alike, closing format characters a secret could hide behind; one answer carries at most 24,000 characters of memory text.
- Two independent review passes found no critical or high-severity defect; the medium findings above were fixed and re-reviewed. Remaining limits are listed in the README and SECURITY.md.

### Not claimed

- No model provider, router or agent pool is added. Hindsight's inference is its own and is configured in that service.
- Linux-tested. Not submitted to the Anthropic plugin directory. Not a general-purpose or stealth browser.
