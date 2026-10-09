> **Historical record.** Written on 2026-10-09 before the companion was moved to its own repository, which is the option it recommends. Kept as written; it is an assessment, not a certification, and the companion has not been submitted to any directory.

# Optional companion — Anthropic Plugin Directory readiness assessment

Date: 2026-10-09. Scope: the separately loaded `cobalt-capabilities` companion
(provisionally 0.1.0) described in [architecture.md](architecture.md).
This is an assessment of risk, not a certification. Listing approval is
Anthropic's decision; a passing local check does not predict it. Nothing was
submitted, resubmitted, pushed or revalidated in producing this document.

## Sources

Read on 2026-10-09:

- [Anthropic Software Directory Policy](https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy)
  (page shows "Last updated April 15, 2026"). Read through a summarizing fetch,
  so the clause wording quoted in the table below is as that fetch returned it
  and should be re-read at the source before it is relied on.
- [Submit your plugin](https://claude.com/docs/plugins/submit) and the
  [plugin pre-submission checklist](https://claude.com/docs/plugins/pre-submission-checklist).
  Read in full; quotations from these two pages are verbatim.

Not read: the Anthropic Software Directory Terms. No published rule was found
on these pages for browser automation, user consent flows, third-party
inference providers or loopback connections specifically; that is an absence
on the pages read, not proof that no rule exists.

## The finding that matters most: do not push this work to the tracked branch

The pending v0.3.2 submission names the **repository root** as its plugin
folder ([https://github.com/echelong/cobalt-cockpit/blob/main/docs/marketplace-submission.md](https://github.com/echelong/cobalt-cockpit/blob/main/docs/marketplace-submission.md)). The submit
guide says:

- "When you select Submit for review, the directory scans the newest commit on
  the tracked branch or tag." With the field left empty the directory follows
  "the repository's default branch".
- A scan runs "on each new commit that the directory picks up from the branch
  or tag that it follows", by schedule and, if configured, by push webhook.
- "People who install the plugin get only the plugin folder", and when a plugin
  path is given "the directory reads and scans only that folder". With the root
  as the plugin folder, **`companions/` is inside the scanned and installed
  plugin**.
- "A reviewer's decision rejects a submission, and so does a failed security
  scan on a plugin that has never been published." "A first submission that
  fails the security scan is rejected."
- "You can't change a submission's repository and folder after you submit," and
  "You can't change the branch or tag while the plugin is with a reviewer."

Consequence: if the local companion commits reach the tracked branch while
v0.3.2 is in review, the directory scans a new version of the *submitted*
plugin that now contains a browser worker, a memory client, local process
execution and a second manifest. That version would at minimum be held for a
reviewer, and a failed security scan on it would reject the never-published
submission. Which branch or tag the submission actually tracks is not recorded
in this repository and was not checked in the portal; treat `main` as tracked
until the owner confirms otherwise.

This is an operational constraint, not a code defect. Options, for the owner:

1. **Separate repository for the companion (recommended).** It becomes its own
   plugin folder and its own submission, and the v0.3.2 scan never sees it.
2. Keep the companion commits local and unpushed until v0.3.2 is published,
   then decide. This is the current state.
3. Point the submission at a tag on the v0.3.2 commit before pushing `main`.
   The portal refuses a tracked-ref change while the plugin is with a reviewer,
   so this may not be available.

## What the checklist says about a plugin shaped like this one

Assessed as if the companion were submitted as its own plugin folder.

| Checklist rule (verbatim where quoted) | Companion | Expected result |
|---|---|---|
| "Keep every file that a hook, an MCP server command, or a script uses inside the plugin folder" | The broker, adapter and browser worker are inside the folder. The **operator configuration file is outside it** by design (private, 0600, user-owned), and locks are written under the per-user runtime directory. | Unclear. The rule blocks a `plugin.json` path outside the folder; a runtime read of an operator file is not addressed. Reviewer question. |
| "`package.json` beside `package-lock.json` ... in the root of the plugin folder is held, because Claude Code installs the packages in that lockfile" | `package.json` and `package-lock.json` are in `capabilities/`, not the plugin root, and declare `puppeteer-core` as an optional dependency. | Not the stated trigger, so no automatic install is expected; the dependency is then **not installed for a user**, and the browser capability reports unavailable until the operator installs it. Needs a deliberate packaging decision. |
| A program "the validator can't read through, when the plugin folder is a subfolder of the repository" is held: "a non-shell file from the plugin" | The mod runs `python3 -I -B <plugin>/capabilities/bridge.py`, which runs `node <plugin>/capabilities/browser.mjs`. | **Held for a reviewer** if submitted as a subfolder. The page says to "keep the plugin at the root of its own repository" to avoid this hold. |
| "Describe in the README everything the plugin runs, sends, or fetches. A complete README doesn't make a behavior allowed." | `README.md` describes both local processes, both loopback services, the request policy, persistence and the HUD. | Disclosure exists; allowance is the Policy's and the reviewer's. |
| Security scan "looks for behavior that a plugin doesn't disclose, such as sending data elsewhere, running hidden code, or changing Claude's permission settings" | Sends reviewed summaries and queries to an operator-run loopback service; drives a browser to operator-allowlisted origins; **changes no permission setting** (it calls the native permission check and proceeds only on `allow`). No hidden or generated code. | Disclosed, but browsing to arbitrary operator-allowlisted origins is the capability most likely to be flagged. |
| "Commit readable source instead of compiled, packed, or minified code" | Python, JavaScript and TypeScript source only; `node_modules` is never committed. | Pass |
| README of at least 40 words; `LICENSE` or `license` | Both present. | Pass |
| `hooks/hooks.json` "a `modules` array for a mod" | `{"modules":["./register.tsx"]}` | Pass |
| Data handling step: "whether the plugin reads or stores personal data, whether it sends data to services other than its declared connectors, how long it keeps data" | Stores up to 64 metadata receipts in the plugin store; sends retained summaries and queries to the operator's Hindsight service, which keeps them until deleted and runs its own inference on them. | Must be answered **yes** to sending data to a service other than a declared connector. The answers need writing before any submission. |

`claude plugin validate --strict companions` passes locally, with one advisory:
the README has no marketplace install line. The portal's **Validate** "runs
more checks than the command does"; none of the portal checks were run.

## Policy mapping

Clause identifiers exist in the Policy. Sections 2 and 5 are titled for
Instructional Software and MCP servers; the companion registers host tools
through a mod and is not an MCP server, so whether those sections apply is a
reviewer's call.

| Clause | Policy text (as fetched) | Companion posture | Residual risk |
|---|---|---|---|
| 1.B | "must not evade or enable users to circumvent Claude's safety guardrails" | Adds no bypass. Refuses unless native permission is `allow`; fail-closed on unknown ownership. | None known. |
| 1.C, 1.D | "must only collect data from the user's context that is necessary"; "must not collect extraneous conversation data, even for logging purposes" | No transcript or file-read API, no automatic recall or retention. Retain takes one short summary the caller wrote. | **Highest exposure.** Nothing technical proves a retained summary is not conversation-derived. `verified` is self-corroborated by the commander's own ledger entry and is not bound to the summary's content. |
| 1.F | "must not query or extract data from Claude's memory, chat history, conversation summaries" | Does not touch Claude's memory or history. Hindsight is a separate operator-run store. | Low. A reviewer may still read "persistent memory" as adjacent to this clause. |
| 2.A, 2.B | Tool descriptions narrow and matching behaviour (paraphrase only; no verbatim text obtained) | Descriptions were corrected in this pass to state that Hindsight runs its own inference and that a single `status` step is a probe. | Keep descriptions in step with behaviour on every change. |
| 2.F | "must not direct Claude to dynamically pull behavioral instructions from external sources" | Memory and page text are returned as data flagged untrusted, never as instructions. | Prompt injection through recalled or page text remains a content risk; flags are metadata, the text is not neutralised. |
| 2.G | "must not contain hidden, obfuscated, or encoded instructions" | None. | None. |
| 3.A, 3.B | Privacy policy link; verified contact and support channel | Repository PRIVACY.md and SECURITY.md cover the base plugin and describe the companion. | A separate listing needs its own privacy presentation and contact. |
| 3.D, 3.E | Test account with sample data; three working examples | No developer-run service exists. Examples are in the README. | A reviewer cannot exercise the capabilities without running Hindsight and Obscura themselves. **Practical obstacle to review.** |
| 4.B | AI image/video/audio generation as a primary service | Not applicable. | — |
| 5.B, 5.E, 5.G | Token frugality; tool annotations; current dependencies (MCP servers) | Outputs are bounded; `puppeteer-core` pinned with a lockfile. Host tools carry no MCP annotations. | If treated as MCP-equivalent, missing read-only/destructive hints is a possible finding. |

Policy clauses not assessed here because their text was not obtained: 1.A,
1.E, 2.C, 2.D, 2.E, 3.C, 3.F, 3.G, 3.H, 4.A, 4.C, 5.A, 5.C, 5.D, 5.F.

## Risk areas

| Area | Behaviour | Disclosed | Open issue |
|---|---|---|---|
| Network connections | Loopback HTTP to Hindsight; loopback CDP to Obscura; the browser reaches only exact operator-allowlisted origins, GET/HEAD only. | README, SECURITY.md | A navigation redirect hop reaches a non-allowlisted origin once before refusal (measured). Egress containment is the operator's. |
| External processes | `python3 -I -B bridge.py`, which may run `node browser.mjs`; `git` for repository identity. By argument vector, never a shell. | README, architecture | Held-for-reviewer shape (see checklist table). |
| MCP servers | None. | README | — |
| Browser automation | Bounded steps in a fresh context; click/fill only with an exact operator grant. | README | No published rule found. Most likely reviewer concern. |
| Persistent project memory | Reviewed summaries and provenance in the operator's Hindsight database; Hindsight derives further observations in the background. | README, architecture | Derived observations carry no provenance and cannot be deleted individually through the adapter. |
| External inference | Hindsight's own generation, embedding and reranking, wherever the operator configured them. The plugin makes no model call. | README, SECURITY.md, tool description | `memory_inference_configured` is an operator attestation; the companion cannot see where inference runs. |
| User consent | Two independent switches per capability, a separate retention consent flag, and native tool permission. | README | No published rule found. |
| Filesystem access | Reads the private operator JSON; writes lock files under `/run/user/<uid>` (or `/tmp`); writes nothing else. | README | Reads a file outside the plugin folder (see checklist table). |
| Plugin permissions | Calls the native check; installs no permission hook; changes no setting. | README, SECURITY.md | — |
| Runtime downloads | None. No launcher, no install step, no remote code. | README | The browser dependency must be installed by the operator. |
| User-data disclosure | Up to 64 receipts of metadata in the plugin store: operation, status, duration, bank hash, task id, step names, fixed error code. | README | No command clears receipts; clearing is through Claude Code's own controls. |

## Unresolved issues, specifically

1. **Packaging.** With the submitted plugin at the repository root, the
   companion cannot share the tracked branch. Decide: separate repository, or
   wait for v0.3.2 to publish.
2. **Tracked ref unknown.** Confirm in the portal which branch or tag the
   v0.3.2 submission follows before anything is pushed.
3. **Conversation-derived retention (1.C/1.D).** No technical control; needs a
   reviewer narrative, or a design change that binds a retained summary to
   something the commander verified.
4. **Reviewer cannot test without the services (3.D).** No hosted test account
   is possible for operator-run local services.
5. **Dependency delivery.** `puppeteer-core` is not installed for a user by the
   current layout; either accept manual installation or move the manifest to
   the plugin root and accept the lockfile-install hold.
6. **Browser capability.** Operator-allowlisted browsing with a measured
   redirect-hop residual has no published rule to pass or fail against.
7. **Data handling answers** and a privacy presentation for a separate listing
   are not written.
8. **Policy text not fully obtained.** Fifteen clauses are unassessed, and the
   Software Directory Terms were not read.

## Assessment

The companion is disclosed, off by default and honest about what it does, and
it passes local strict validation. It is **not ready to be submitted as-is**,
and it **must not reach the branch the v0.3.2 submission tracks**. Even
packaged separately it should be expected to be held for a reviewer on the
process-execution and browsing checks.
