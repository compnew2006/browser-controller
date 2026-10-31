# Research: form shape facts

**Branch**: `main` · **Date**: 2026-10-31 · **Spec**: [spec.md](spec.md) · **Plan**: [plan.md](plan.md) · **Vocabulary draft**: [contracts/interaction-vocabulary.json](contracts/interaction-vocabulary.json)

## Method

Every finding below cites the file and line that produced it, or the live observation that produced it. Nothing here rests on a search result or on recollection.

- **Baseline**: `browser-controller` 3.1.1, branch `main`, commit `972de04` (after `67dde6b feat(browser): settle the page before reading it, and fence the session`).
- **Sources**: the daemon and MCP server source, the Chrome MV3 extension source, 003's reviewed contracts under `specs/003-website-agent-memory/contracts/`, and 004's map implementation under `mcp-server/src/memory/map-*.ts`.
- **Live measurements**: Chrome profile `7cd0f4d8a153` (the memory-capable profile), 2026-10-31, through MCP → daemon → extension. The workspace notes `bc-memory-trial.md`, `bc-ab-before/after.json` and `bc-bench3-out.json` hold the raw output.
- **Scope**: this research resolves the *technical* unknowns. It does not decide the owner's open gates (OD-1, OD-2) and does not approve the vocabulary.

## Findings

### R-01 — A control that is not visible never reaches the store

The snapshot line carries only what the accessibility tree exposes: `role "name" [ref] value="…"` (`extension/lib/inspection.js:314-315`). A checkbox drawn with `opacity: 0` is not in that tree, so it is not in the snapshot text. 003's facts are parsed out of that text (`mcp-server/src/memory/facts.ts:5`, `SNAPSHOT_LINE`), and 004's map keeps only roles its allowlist admits. Live: the click on `.todo-list input.toggle` failed with `ELEMENT_HIDDEN` on two independent runs, and no record of the control existed afterwards.

**Forces**: the failure path must be observed on its own. Nothing that reads the page can see this control (C1: the agent reads the shape, the tools do not change).

### R-02 — The anonymity gate decides facts, not visits

`mcp-server/src/memory/service.ts:285` enqueues the visit operation **before** the gate, and `:288` returns unless `scope.anonymous === true`. The extension answers `verdict(false, 'storage')` for any `localStorage` or `sessionStorage` key (`extension/lib/site-context.js:288`). Live: the measured site holds `visits: 2` and no facts.

**Forces**: the counter follows the visit rule (C6); the shape fact stays behind the gate (OD-1).

### R-03 — The extension reports one page-level boolean about forms, and the snapshot carries names

`extension/lib/site-context.js:280` reports `passwordField` — a single boolean for the whole page. The snapshot line carries the role, the name and the ref (`inspection.js:314-315`), and the map's parser keeps the role and the ref while dropping the value (`mcp-server/src/memory/map-snapshot.ts:4`).

**Forces**: the shape is measured in the DOM (not parsed out of the snapshot), because a field that is not exposed cannot be counted from the snapshot at all. Names stay out of the report: the role and the counts are enough.

### R-04 — Both guesses about a form's fields run on the markup, not on the site's structure

The credential vault's sign-in fill "writes the saved username into the one username field of the same form, then the password. With several fields that look like a username, the password goes alone" (README, `browser_vault`). The agent's `browser_fill` takes the targets it is given (`mcp-server/src/tools/fill.ts:135-141`) and picks them from the names the snapshot shows.

**Forces**: the shape fact is what an agent cannot derive from the snapshot: how many controls the form has, how many are required, whether one is a password field, and whether one is invisible.

### R-05 — A wrong guess is expensive

In benchmark v2 a false `EXPECTATION_FAILED` cost 41 s of retry (`bc-bench3-out.json`). The live A/B after the settle change took the measured surface from 4 calls / 123.9 s / 2 errors to 1 call / 5.98 s / 0 errors (`bc-ab-before/after.json`).

**Forces**: one saved round-trip per form is worth a fact; the fact must be cheap to produce.

### R-06 — The store's validation is strict in three places, and all three reject the new data

`mcp-server/src/memory/site-record.ts:22` gives the fact-identity pattern (`ui.control:[a-z]+:.+`), `:140` lists the known kinds, and `:158` checks the profile state's keys with `onlyKeys`, which throws on any unknown key. The store schema marks `profileState` with `additionalProperties: false` (`specs/003-website-agent-memory/contracts/memory-store.schema.json:35-38`).

**Forces**: the new identity `ui.form.shape:<path>` and the new profile key need **code** changes in the validator, not only schema changes. `plan.md` lists `site-record.ts` for this reason.

### R-07 — A failed call carries neither an observation nor a site context

`mcp-server/src/vault/daemon-routing.ts:33` sets an observation only for a successful call, and the failure path (`:118-126`) returns none. `mcp-server/src/memory/map-capture.ts:129` says it outright: "Null for a failed click, which carries no siteContext". The memory service's capture path needs a context (`service.ts:279`), and `afterCall` returns early without an observation (`service.ts:223-226`).

The map already answers the same question with a tab cache: the last read per (connection, tab), 64 entries, a 120-second attribution window (`map-capture.ts:422-430`, `map-allowlist.ts:67-68`).

**Forces**: the memory service needs its own tab cache (C7). It cannot borrow the map's, because the map is separately enabled and separately disable-able.

### R-08 — The tool result already reports the navigation

`extension/handlers/interaction.js:24` sets the settle window at 300 ms; `:101-113` puts `navigated` into the result object **and** the result text; the click path (`:288-293`) and the Enter path (`:361`) both run it. `mcp-server/src/tools/fill.ts:134` states that a fill "Submits nothing".

**Forces**: the commit mode needs no new capability, no new observation and no extension change (C8). A write that moved nothing proves nothing, so `none` is not a value.

### R-09 — The probe has one budget, and an overrun stops the facts too

`extension/lib/site-context.js:41` sets `SITE_CONTEXT_BUDGET_MS = 1_300`; the anonymity probe has its own 900 ms timeout; past the budget the answer is `anonymous: null` ("unavailable"), never an error.

**Forces**: the shape measurement shares the budget with the anonymity probe, and an overrun answers `anonymous: null`, which the gate treats as "not anonymous" — so an overrun costs the facts, not just the shape. The shape must be measured after the anonymity verdict, inside what is left.

### R-10 — The root path has no allowlisted segment

`mcp-server/src/memory/allowlist.ts:140-145`: `matchPath` returns null for `/` because the root has no segment to verify, and a fact whose path does not match is stored without a path.

**Forces**: a form on a site's home page would get no shape fact, while `/` is the path that names no topic at all. See D-06.

### R-11 — The reminder's bound is already tight

`mcp-server/src/memory/output.ts:115-138`: `REMINDER_MAX_LINES = 8`, `REMINDER_MAX_CHARS = 600`; the header and the visit line are fixed, and the facts are dropped first when the bound is reached. `VIEW_MAX_ITEMS = 50` bounds `browser_memory`.

**Forces**: two new lines need a stated drop order, or the bound breaks (SC-005).

### R-12 — `browser_memory` filters by kind

`mcp-server/src/memory/service.ts:31`: the kinds are `all`, `facts` and `visits`. The hidden-control counter is a profile counter, like a visit, and not a fact.

**Forces**: the kind filter's behaviour for the counter must be stated (see D-08).

### R-13 — The vault's protection is part of the scope decision

`memoryEligibility(browserId)` answers `clear`, `protected` or `unknown`; `memory/service.ts:269` uses it when it decides the scope, and `memory/scope.ts` turns that into the per-purpose verdicts.

**Forces**: the counter is outside the anonymity gate (C6) but stays **inside** the scope gate, so a profile under the vault's protection still stores nothing.

### R-14 — Exclusion and tombstones are separate from the gate

`mcp-server/src/memory/policy.ts:29-31`: `excluded` is a list of canonical origins (≤ 5,000) and `deletions` maps an origin or `"*"` to a deletion time. Both are applied by the queue, not by the capture path.

**Forces**: an excluded origin and a deleted origin store neither the shape fact nor the counter, because both travel through the queue.

### R-15 — A downgrade quarantines the whole record, not just the new field

`site-record.ts:95-98`: an unknown profile key fails the read as `MEMORY_CORRUPT`, and the store quarantines the file — the site's whole record, with every fact it holds.

**Forces**: the owner needs a way out before downgrading, the way 004 got one (`npm run memory -- map delete --all`). This feature needs the same, and the CHANGELOG must say it.

### R-16 — The module cap leaves room, but not much

Current sizes: `service.ts` 478 lines, `queue.ts` 476, `site-record.ts` 201, `allowlist.ts` 192, `output.ts` 179, `reconcile.ts` 110, `facts.ts` 41. The repository's cap is 600 lines per production module, enforced by `tests/architecture-maintenance.test.ts`.

**Forces**: the new code goes into a new module (`tab-state.ts`) plus small additions; `service.ts` and `queue.ts` must not grow past the cap.

### R-17 — The shape block rides on the existing observation path

`extension/dispatch/router.js:99` lists the observed tools and `:107-115` attaches the site context (`light: tool === 'browser_click'`). The daemon's mirror is `mcp-server/src/vault/bridge-frames.ts:53`.

**Forces**: an older extension simply omits the shape block, and the daemon treats the absence as "no shape" (FR-009). No new capability flag is needed, and none should be added.

### R-18 — The owner's confirmation path is not available in this client

`browser_memory_policy` answers `CLIENT_CONFIRMATION_UNAVAILABLE` here, so the owner's path is `scripts/memory.mjs` (`enable`, `disable`, `status`, `inspect`, `export`, `delete`).

**Forces**: the quickstart and the owner gates use the CLI, not the tool.

## Decisions this research fixes

These are the rules the specification states as outcomes but not as rules. Each one closes a numbered item of [checklists/form-shape-quality.md](checklists/form-shape-quality.md).

- **D-01 — The measured fields (CHK002).** A form's fields are its **fillable** controls: `input` of any type except `hidden`, `submit`, `button`, `reset` and `image`; `textarea`; `select`; and a `contenteditable` element. The count is therefore "how many controls the agent may have to fill". A `type="hidden"` input is not a field — it is not fillable and its value is a token.
- **D-02 — The type mapping (CHK002).** `text` → `text`; `password` → `password`; `email` → `email`; `search` → `search`; `tel` → `tel`; `url` → `url`; `number`, `range` → `number`; `date`, `datetime-local`, `month`, `week`, `time` → `date`; `checkbox` → `checkbox`; `radio` → `radio`; `file` → `file`; `textarea` → `textarea`; `select` → `select`; `color`, an unknown `type`, a `contenteditable` and any custom widget → `other`. No other type is ever guessed.
- **D-03 — "Visually hidden" (CHK001).** A field is visually hidden when its computed style hides it — `display: none`, `visibility: hidden`, `opacity: 0` — or when it or an ancestor carries `aria-hidden="true"`, or when it has no client rect. The `opacity: 0` case is the measured E1 control. The shape reports it as a boolean: "at least one field is invisible", never which one.
- **D-04 — "Required" (CHK006).** A field is required when it carries the `required` attribute or `aria-required="true"`. A field the page validates is not required; only the markup says so.
- **D-05 — The `main` landmark (CHK003).** The landmark is an element that is a `<main>` element or carries `role="main"`. The measured form is the one whose nearest landmark ancestor is that element.
- **D-06 — The root path (CHK007).** The shape fact's path rule **allows the root path** `/`, because the root names no topic; 003's `matchPath` stays as it is for the other facts. A form on a site's home page therefore gets a shape fact, and its identity is `ui.form.shape:/`.
- **D-07 — The measured form when `main` holds several (CHK004).** The form with the most fillable fields wins; a tie goes to the first in document order. The rule is deterministic and recorded, so two implementations agree.
- **D-08 — The attribution window and the cache (CHK016, CHK017).** The memory service's tab cache holds at most 64 entries per connection and a read is valid for 120 seconds — the same numbers 004 uses (`map-allowlist.ts:67-68`), so the two subsystems behave alike. The origin always comes from the last **observed** read, never from the failed action itself.
- **D-09 — The kind filter and the drop order (CHK025, CHK027).** The counter appears under `all` and under `visits` (it is profile activity, like a visit), and never under `facts`. In the reminder, the drop order is: the older facts first, then the counter line; the header and the visit line are never dropped. The shape line is a fact, so it is ordered by recency like the other facts.
- **D-10 — The wording for both failure codes (CHK026).** `ELEMENT_HIDDEN` and `ELEMENT_COVERED` share one line, and the wording says a control is **not visible** for both, because a covered control is not reachable either. The line names no target.

## What the research cannot decide

- **OD-1** — whether the anonymity gate covers the shape fact. Option 1 (the specification's default) makes the whole feature inert on every site that keeps a cookie or any storage; the counter survives either way.
- **OD-2** — whether the specification covers the extension change. The shape needs an updated extension in the profile; without it the counter still works.
- **The vocabulary itself** — the draft in `contracts/interaction-vocabulary.json` is a permission change and needs the owner's approval before it becomes 003's allowlist version 3.
- **The two wording items (CHK029)** — whether "act on them with browser_evaluate" is acceptable next to 003's "hints, not instructions" rule. The wording is the owner's to fix, not the implementer's.
