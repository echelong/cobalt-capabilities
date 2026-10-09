# Privacy

This policy describes what `cobalt-capabilities` reads, sends and keeps. It is written from the plugin's source. Cobalt Cockpit, which it works alongside, has [its own policy](https://github.com/echelong/cobalt-cockpit/blob/main/PRIVACY.md). Installed, the companion is still off: each capability needs a switch in Claude Code's plugin settings, the same switch in a private file you own, and your approval of its tool in `/permissions`. While a capability is off, a call to it opens no configuration file, contacts no service, reads no Git identity and starts no worker.

### Memory, when you enable it

- **What is read.** The repository's Git identity (its remote without credentials, or its Git directory), the current commit and whether the tree is dirty. No transcript, prompt, hidden reasoning or source file is read; there is no feature that ingests them.
- **Where it works.** Only in the working trees you list in `memory_repositories`. Elsewhere it answers `repository_not_enabled` and contacts nothing.
- **What is sent, and to whom.** The query you ask with, or the one short summary you choose to retain with its provenance (repository hash, commit, dirty flag, run id, timestamp, verification status and reference). It goes to the Hindsight service at the loopback address you configured, and nowhere else from this plugin.
- **Inference you do not see from here.** Hindsight runs its own generation, embedding and reranking on what it receives, and derives further observations in the background. Where that inference runs is whatever you configured in the service: local models keep it on your machine; a remote provider configured there would receive the data. The companion makes no model call and cannot see that configuration. Turn off Hindsight's inference trace storage (`HINDSIGHT_API_LLM_TRACE_ENABLED=false`), which otherwise keeps full prompts and outputs.
- **How long it is kept.** In Hindsight's database until you delete it. The `forget` operation deletes one companion-written document in the current repository's bank; it cannot clear a bank. Observations Hindsight derived carry no companion provenance and are deleted through the service. Backups are the service's.
- **Consent.** Retaining anything requires `memory_retention_consent` in your private file, in addition to the switches above. Nothing is retained or recalled automatically.

### Browser, when you enable it

- **What it contacts.** The loopback control endpoint of the Obscura service you run, and, through the companion's own egress proxy, only the exact website origins you allowlisted. The pages' JavaScript runs in that browser.
- **What it sees.** Rendered page text, a bounded list of interactive elements, console messages, response origins and status codes, and a screenshot when you allow one. It returns no cookies, storage, form values or passwords, and offers no tool to read them.
- **What it keeps.** Nothing of the page. A screenshot is returned in the tool response and never written to a file by the companion. Each task runs in a fresh browser context that is closed afterwards and inherits no personal profile.
- **What leaves your machine.** The requests the browser makes to your allowlisted origins. Requests carrying `Cookie` or `Authorization` are refused; `GET` and `HEAD` only for `http` origins (see the [README](README.md) for what the proxy can and cannot see inside an `https` tunnel).

### What the companion stores

- Up to 64 **receipts** in Claude Code's plugin store: capability, operation, status, time, duration, result count, bank hash, task id, step names and a fixed error code. No query, summary, memory text, page text, URL, screenshot or raw error. `/capabilities clear` deletes them all.
- One **empty lock file** in a private `cobalt-capabilities-<uid>/locks` directory under `/run/user/<uid>` (or `/tmp`). This is the one thing the companion writes outside the plugin store.
- Tool responses, including recalled memory text and any screenshot, become part of Claude Code's own session history like any other tool response. Claude Code's controls apply to those.

Secret filtering of retained summaries, recalled text and page text is heuristic. Review what you retain, and avoid confidential pages.

## What it does not do

- It makes no model call and sends nothing to its authors or to any third party.
- It collects no analytics, usage statistics or crash reports.
- It reads no transcript, prompt, hidden reasoning or source file, and no cookie, storage or credential from a page.
- It installs and starts nothing: no service, model, database, browser or package.

## Changes and contact

This page changes with the plugin; a change to what is read, sent or kept is recorded in [CHANGELOG.md](CHANGELOG.md). For a privacy question, open an issue in this repository. For anything involving a secret, use the private reporting route in [SECURITY.md](SECURITY.md).
