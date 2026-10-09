# Cobalt Capabilities v0.1.1

A stabilization release after the live acceptance test of v0.1.0 with Cobalt
Cockpit v0.4.0. It changes no setting, grant format or stored memory, and it
needs no change to Cobalt Cockpit, which stays at v0.4.0.

## What changed

- `inspect` honours its `selector`. In v0.1.0 it was an alias of `snapshot` and
  ignored the selector the tool schema accepts. With a selector the evidence
  keeps the page-level fields and adds `selector` and `element`.
- A refused call also names the rule that refused it, in `refusal_reason`. The
  general `error` code is unchanged.
- The README says how to stop the confined browser and confirm it has exited.
- `capabilities/tests/services.sh`, an optional development harness for the
  disposable services a live test needs, with its own tests.

## Compatibility with v0.1.0

- The unchanged v0.1.0 test files were run against this release's code: 53
  adapter and broker tests, 25 egress tests, 51 browser worker tests and 34
  host-hook tests, all passing.
- Every result field v0.1.0 returned is still returned with the same meaning.
  `selector`, `element` and `refusal_reason` are additions.
- `inspect` without a selector, with an empty one, and `snapshot` return exactly
  what they did. `inspect` with a selector accepts any string, as before, and no
  string selector fails a task: one the engine cannot evaluate reports
  `found: null`. A selector that is not a string, which the tool schema never
  allowed, is refused.
- Stored receipts from v0.1.0 are read unchanged; a receipt gains a `reason`
  field only when a worker named one.

## Measured

This release's browser worker, run against real Obscura behind the confinement
recipe, with a local test page:

- `inspect` of a heading, a paragraph and a text input returned their tag and
  text, with no text for the input; a missing element returned `found: false`;
  a `script` and the `head` returned no text.
- Twenty-nine selector forms were tried, each followed by a `snapshot` step.
  Every task was observed, kept its page-level fields and ran the following
  step. Thirteen malformed selectors (`a[`, `:::`, `p:has(` and others) and a
  300-character one returned `found: false`. The query prefixes `xpath/`,
  `pierce/`, `>>>` and `::-p-xpath()` found the heading. `aria/…` and
  `::-p-getById()` are not implemented by the engine and returned `found: null`.
- An ungranted click returned `grant_missing`, a refused fill value
  `fill_value_refused`, and a navigation outside the allowlist
  `navigation_refused_by_policy`, each with nothing executed.

The installed v0.1.0, against a real Hindsight service with a local CPU model.
The code on these paths is the same in this release:

- A retain citing a delegated task was stored `agent_asserted` while that task
  was completed but unverified, and `verified` once the commander had verified
  it. A helper citing the same verified task was stored `agent_asserted`.
- While a helper held a task, the commander's memory, browser and shell effects
  were refused.

The harness: `stop` ended every recorded process of the real services on each
of four runs (browser and site in all four, the model server in two), and an
unrelated Obscura started earlier on the same machine was untouched.

## Upgrading from v0.1.0

Nothing changes in settings, the private operator file or stored memory. Claude
Code installs an update into a new folder, so if you use the browser, run
`npm ci --ignore-scripts` again in the updated plugin's `capabilities` folder;
until then browser tasks answer `browser_unavailable`.

## Limits

- Linux-tested, on Fedora 44 with SELinux enforcing. The stop behaviour of the
  confinement recipe on a host without SELinux was not measured.
- `test-services.sh` is not part of CI: it needs pasta, bubblewrap and
  unprivileged namespaces, which the CI runner does not guarantee.
- The selector is handed to the engine's element lookup, which also accepts
  the client library's query prefixes (`xpath/`, `pierce/`, `>>>`). These only
  select elements; no caller-supplied code runs in the page.
- For an element that contains script, style or template parts (`body` always
  does), `text` is read from a copy with those parts removed, so it can include
  text the page hides, which `snapshot` leaves out.
- Not submitted to the Anthropic plugin directory.
