# Implementation Plan: form shape facts

**Branch**: `main` · **Date**: 2026-10-31 · **Spec**: [spec.md](spec.md) · **Input**: "form shape facts" (007)

**Status**: Draft for owner review. Three gates are open and none of them is the implementer's to close: the vocabulary in [contracts/interaction-vocabulary.json](contracts/interaction-vocabulary.json), OD-1 (the anonymity gate) and OD-2 (the extension dependency). Nothing is implemented before they close.

**Builds on**: [003 plan](../003-website-agent-memory/plan.md) and [004 plan](../004-site-navigation-map/plan.md) · **Research**: [research.md](research.md) · **Data model**: [data-model.md](data-model.md) · **Verification**: [quickstart.md](quickstart.md) · **Review checklist**: [checklists/form-shape-quality.md](checklists/form-shape-quality.md)

## Summary

Agents fill forms by guessing. The snapshot names the fields, so the agent picks a username field and a password field by name, and the site's own structure — how many controls the form has, how many are required, whether one of them is invisible — is in neither the tool nor the memory. When a form has a control the snapshot never shows, the fill is short one field and the submit fails. This feature measures the form's **shape** (counts, closed-vocabulary field types, whether a field is visually hidden) and remembers it per path, so a later agent reads it instead of guessing, and it counts the failures that happen on invisible controls, per profile, so a later agent knows before it clicks.

Two things carry no content from the page: the shape holds counts and vocabulary words, and the counter holds a number. Nothing about a form's labels, values or placeholders is ever stored.

**Technical Context**

**Language/Version**: TypeScript (ES modules) on Node.js ≥ 20 for the daemon and MCP server; JavaScript for the Chrome MV3 extension. No new language and no new dependency.

**Primary Dependencies**: Existing only: `@modelcontextprotocol/sdk`, `zod`, `ws` and Node built-ins.

**Storage**: 003's existing store, unchanged in layout — `policy.json` and `sites/<sha256(origin)>.json` under `<BC_STATE_DIR or ~/.browser-controller>/memory/`. Two additions: one fact kind (`ui.form.shape`) and one profile-state key (`hidden`). The daemon's tab cache is in memory only and never touches the disk.

**Testing**: Vitest, with the existing memory fixtures (`tests/helpers/memory-fixtures.ts`), the fake DOM (`tests/helpers/fake-dom.ts`) and the spawned-daemon harness. One new suite, `tests/memory-tab-state.test.ts`, covers the new module; the existing 003 suites carry the contracts, the privacy rules, the output bounds and the store, the way 004 added to them rather than replacing them.

**Target Platform**: A local daemon on macOS, Windows and Linux, with Chrome desktop and the Browser Controller extension, across several profiles.

**Project Type**: A local MCP server and daemon plus a browser extension.

**Performance Goals**:

- A read that measures a shape adds no measurable time: the measurement rides inside the extension's existing probe budget (1,300 ms), after the anonymity verdict.
- The counter and the commit candidate add no call to the agent's flow — both are read from an outcome the daemon already has.
- The reminder stays within 003's bound: 8 lines and 600 characters.

**Constraints**:

- No tool changes its behaviour (C1): the feature is read by the agent, not applied to a call.
- No string from the page is ever stored: no label, no name, no placeholder, no value, no selector, no id.
- The feature never changes a browser outcome, a timeout, a retry or a tab ownership.
- The 600-line module cap holds. `service.ts` is 478 lines and `queue.ts` is 476; the new code goes into a new module.
- No network I/O and no new dependency.
- The store's file layout, its atomic write and its quarantine rule do not change.

**Scale/Scope**: One owner, a few profiles, tens of agent sessions, up to thousands of origins. At most 8 shape facts per site.

**Constitution Check**

*GATE: Check applicable requirements before Phase 0 research and re-check after Phase 1 design.*

Source checked: the root `constitution.md`, SHA-256 `e25991c992aff49774b45b322c47e2500b211363a6ad3622508a4322cfa32d5e`, version 4.1.0, status **proposed** — not adopted, pending gates A–D and the token tests.

**The mirror's fingerprint no longer matches the root.** `.specify/memory/constitution.md` records the source fingerprint `2b2d4700e6364c1e898c90ddaff5923393bc977d605353286624c1d7b7f40b17`, which was correct when 004 recorded it on 2026-10-28. The root file changed afterwards (commit `efd3c93`), and it now states in its own header that the file under `.specify/memory/` is a Spec Kit template and not an adopted copy. `AGENTS.md` requires exactly this check ("Check the mirror's source fingerprint against the root file before relying on it"), and it fails today. This plan therefore cites the **root's** hash, and the mirror needs a refresh — a repository-hygiene item outside this feature's scope, recorded here so that it is not lost.

### Applicable now (`AGENTS.md`, owner instructions)

| Requirement | Pre-design | Post-design |
|---|---|---|
| Spec Kit pauses for spec and plan review | PASS: this plan is a draft for review | PASS |
| Schemas under `mcp-server/src/tools/`, registration in `tools/registry.ts`, browser behaviour in handlers | — | PASS: no new tool; the browser behaviour is the extension's probe, in `extension/lib/site-context.js` |
| Preserve timeouts and tab ownership | — | PASS: the feature reads outcomes; it changes no call, timeout, retry or owner |
| Vault data never leaks | — | PASS: the scope gate keeps a vault-protected profile empty, for the counter as well as for the shape (R-13) |
| No secrets or page data as instructions | — | PASS: fixed words only, labelled as structure, never an instruction (the wording item is CHK029, the owner's) |
| No installs, upgrades or external services without authorization | PASS | PASS: no new dependency |
| Regression tests for protocol, tab ownership, timeouts, redaction | — | PASS: [quickstart.md](quickstart.md) |
| 600-line module cap | — | PASS by design: a new `mcp-server/src/memory/tab-state.ts`, and small additions elsewhere (R-16) |
| Conventional Commits, scoped | — | PASS: `feat(memory):` for the feature, `docs(memory):` for the contracts |

### Proposed constitution checks (not binding until adopted)

| Article | Check | Status |
|---|---|---|
| 2 Risk tiers | `CRITICAL`: it persists the structure of a signed-in site's forms | Proposed; OD-1 decides the reach |
| 3 Authorization | Implementation, commits, pushes and real-Chrome runs each need explicit authorization | Recorded in the gates |
| 6 Spec and contract | Machine-readable contracts in `contracts/` | The vocabulary draft is in `contracts/`; the drift test is not available yet |
| 7 ADR | An ADR for the gate split (the counter outside the anonymity gate) and for the attribution rule | To be written with the tasks, status `proposed` |
| 16 Testing | Full regression plus contract, privacy, boundary and failure suites | Planned |
| 19/22 Merge and done | Independent review; owner approval; local checks reported apart from CI | Planned |
| 21 Security | No new dependency; untrusted data; local only; the downgrade quarantine goes into `SECURITY.md` | PASS |
| 24 Token budget | `CRITICAL` needs an owner-set budget | Open |

**Gate result**: PASS for planning, with the mirror's stale fingerprint recorded above. *Complexity Tracking* lists what this feature adds.

**Project Structure**

### Documentation structure

```text
specs/007-form-shape-facts/
├── spec.md                              # the specification (FR-001..FR-011, SC-001..SC-009)
├── plan.md                              # this file
├── research.md                          # Phase 0: the findings R-01..R-18 and the decisions D-01..D-10
├── data-model.md                        # Phase 1: the entities, the bounds, the lifecycle
├── quickstart.md                        # Phase 1: how to build, check and measure
├── tasks.md                             # Phase 2: T001..T014
├── checklists/
│   ├── requirements.md                  # the built-in specification checklist
│   └── form-shape-quality.md            # the custom review checklist (40 items)
└── contracts/
    └── interaction-vocabulary.json      # the proposed vocabulary, for owner review
```

### Source code structure

```text
mcp-server/src/memory/
├── allowlist.ts      # the vocabulary mirrored from the contract
├── facts.ts          # collectFacts gains the shape block
├── service.ts        # the capture path, the counter, the commit candidate
├── tab-state.ts      # NEW: the per-tab cache (origin, path, refs, the window)
├── queue.ts          # the new capture op and its folding
├── reconcile.ts      # the counter and the pending commit mode land on the record
├── site-record.ts    # the new kind, the new identity, the new profile key
└── output.ts         # the two new lines

extension/lib/site-context.js   # the shape measurement inside the existing probe
```

### Structure decision

The new code goes into **one new module** (`tab-state.ts`) rather than into `service.ts`, because `service.ts` is 478 lines against a 600-line cap and the tab cache is a self-contained concern with its own bounds and its own tests. The rest of the changes are small additions to modules that already own the thing being changed. No module is restructured, and no new dependency is added.

**Root causes, confirmed in source**

| Evidence | Cause in source | Fix |
|---|---|---|
| E1 | A control with `opacity: 0` is not in the snapshot, so `extractSnapshotFacts` (`mcp-server/src/memory/facts.ts`) never sees it, and the site map stores only controls a snapshot showed. Nothing in the record can say "this control is not visible". | FR-003: the daemon reads the failure code of the action it already observes in `MemoryService.afterCall` and raises one hidden-control counter in the **acting profile's own state** (C2, C6). No target is kept. |
| E2 | 003's anonymity gate is applied in the capture path before any fact is collected (`service.ts:288`), while a visit is enqueued before that check (`:285`), so a site whose probe reports `anonymous: false` has no facts at all — only visits. | OD-1: Option 1 keeps the gate for the shape fact; Option 2 lets it through for every in-scope site. FR-004 is written for Option 1. The counter is outside the gate either way (C6). |
| E3 | Two guesses about a form's fields are made from the markup. The credential vault's sign-in fill picks "the one username field of the same form" and gives the password alone when several fields look like a username. The agent's own `browser_fill` takes the targets it is given (`mcp-server/src/tools/fill.ts`: `fields: [{target, value}]`, no guessing in the tool) and picks them from the names the snapshot shows — so a field the snapshot never shows is not in its plan at all. | FR-001 and FR-002: the extension reports the shape of the form **inside the `main` landmark** (C3: counts and closed-vocabulary types), the daemon stores it per allowlisted path, and the agent reads it before filling. |
| E4 | A wrong guess costs a failed call plus a retry; in benchmark v2 a false `EXPECTATION_FAILED` cost 41 s. Nothing in the memory shortens the guess. | FR-005 and FR-006: the shape reaches the agent in the reminder and in `browser_memory`, in fixed words, inside 003's existing bounds. |
| E5 | `siteContext` reports `passwordField` as one page-level boolean; nothing else about forms is observed. `extractSnapshotFacts` parses `<role> "<name>"` lines and can only see roles and names. | FR-001: the extension's probe reports a bounded `formShape` block with counts and a closed vocabulary; no string from the page is reported. |

**Decisions per requirement**

- **FR-001**: The shape is measured in the extension's existing probe (`extension/lib/site-context.js`), inside its existing budget, and travels as an optional field of the `siteContext` block. The measured form is the one inside the `main` landmark (C3, D-05): the probe walks the page's forms, keeps the one whose nearest landmark ancestor is `main`, and reports nothing when there is none. When several forms sit inside `main`, the one with the most fillable fields wins and a tie goes to document order (D-07). The block carries no string from the page: a field contributes only a type from the reviewed list, a count, a boolean. A type outside the list is counted as `other` (D-02). The commit mode is **not** part of the block (C4, FR-011). The block is optional, so the contract's `additionalProperties: false` is extended and an older extension simply omits it (FR-009).
- **FR-002**: A shape fact's identity is `ui.form.shape:<path>`, and the path is kept only when every segment is on the reviewed `pathSegments` list — the same rule 003 uses for `ui.login`'s path, plus the root path `/`, which names no topic (D-06). The path is part of the identity, not the value, because the shape belongs to a page: a site-wide count would be wrong for every page but one. A page whose path is not allowlisted gets no shape fact at all (not a site-wide one).
- **FR-003**: The hidden-control counter is created in `MemoryService.afterCall` from the outcome the daemon already has, and it lives in the **acting profile's own state** (C2) next to the visit counter — not among the shared facts, because it counts activity. Only the two codes `ELEMENT_HIDDEN` and `ELEMENT_COVERED` raise it; the count of occurrences rises on each. The target is never read: the counter holds a number. A profile's counter is removed with that profile's state. The origin comes from the **last observed read of that tab** inside an attribution window (C7, D-08): a failed call carries no `siteContext` and no observation (`mcp-server/src/vault/daemon-routing.ts` returns an observation only for a successful call), so the daemon cannot ask the page which site was hit — the site map answers the same question with a tab cache of its own (`mcp-server/src/memory/map-capture.ts`, a 120-second window). The memory service needs the same kind of cache, filled by its own successful reads; a failed action on a tab that was never read raises nothing. The counter is **not** behind the anonymity gate (C6): it counts the profile's own failed actions, holds no page content, and 003 already stores a per-profile counter (the visits) on the very sites the gate excludes.
- **FR-004**: The shape fact goes through 003's scope gate, its normalisation and its store, and the anonymity gate decides whether it is kept at all (OD-1). The hidden-control counter goes through the scope gate, the exclusion and the deletion, and **not** through the anonymity gate (C6). At most 8 shape facts per site; the site's 64-fact bound and its 64 KiB bound apply unchanged. `delete <origin>`, `delete --all`, `exclude` and the tombstones remove them like any other fact (FR-010).
- **FR-005**: The reminder and `browser_memory` gain two lines, built from fixed words like the rest of 003's output: a shape line (indicative only: `form shape: 3 fields (1 required, password, hidden field), commits on Enter` — the words come from the approved vocabulary, and the punctuation from the implementer) and a hidden-control line (`some controls on this site are not visible: act on them with browser_evaluate`). The shape line says it describes the form's structure, not its content. Both lines count against 003's 8-line and 600-character bound, and the drop order is fixed (D-09): the shape line first, then the counter line, then the older facts — the header and the visit line are never dropped. The counter appears under `all` and under `visits`, and never under `facts` (D-09).
- **FR-006**: `browser_memory`'s description and the agent guidance text gain two sentences: the shape is a hint about a form's structure and never carries what was typed or what the page says; a hidden-control counter means the site's invisible controls are to be acted on with `browser_evaluate`. The text never urges the agent to act on the site because of a hint. Whether that last sentence reads as an instruction against 003's "hints, not instructions" rule is CHK029, and it is the owner's to settle.
- **FR-007**: `memory-store.schema.json` gains the new kind, its identity pattern and a bounded shape value, and the `profileState` gains the hidden-control counter; `schemaVersion` stays 1 and the new fields are optional, so every existing store file stays valid. The store's validator changes with it: the identity pattern, the known kinds and the strict profile-key check all live in `mcp-server/src/memory/site-record.ts` (R-06). An older daemon reading a newer file quarantines it as `MEMORY_CORRUPT` — the whole record, not only the new field (R-15) — which is the behaviour 004 and 005 already have for their own additions, and which needs an escape hatch in the CHANGELOG.
- **FR-008**: The vocabulary moves into 003's `fact-allowlist.json` as version 3, next to the existing phrase lists, and `mcp-server/src/memory/allowlist.ts` mirrors it as code. `tests/memory-allowlist.test.ts` gains the new lists and the version check, so a change without a bump fails the build.
- **FR-009**: The daemon treats a missing shape block as "no shape" and never as "an empty form". No error code is added for it.
- **FR-010**: Nothing new is stored outside the existing store, so the owner's existing commands already cover it. `scripts/memory.mjs export` lists the new facts because it exports the record; `inspect` gains a line counting them.
- **FR-011**: The commit mode is learned in `MemoryService.afterCall` from the write action and its outcome, never from the markup (C4). The observation needs no new capability: the extension's click and type handlers already report a navigation when the address changed inside their settle window (`extension/handlers/interaction.js` puts `navigated` in the tool result), and the daemon reads it from the result it already has. A write is a **commit candidate** when the address changed: `browser_type` that pressed Enter gives `enter`, a `browser_click` on a control the last snapshot marked `button` gives `button`. A candidate whose address did not change proves nothing — a rejected value, an inline error and a commit without a navigation look the same — so the mode stays `unknown` and `none` is not a value (C8). The candidate is held against the path the write ran on (from the same tab cache as FR-003) and applied at the **next observed read of that path**, where the anonymity gate is evaluated as in 003; a path never written to stays `unknown`. Which action was used is not recorded beyond the mode itself: no tool, no target, no tab, no time, and the address that proved it is not stored either.

**Files**

- `extension/lib/site-context.js`: the shape measurement, inside the existing probe and after the anonymity verdict.
- `mcp-server/src/memory/allowlist.ts`: the shape fact builder; the vocabulary mirrored from the contract.
- `mcp-server/src/memory/facts.ts`: the shape fact in `collectFacts` (the `FactSources` gains the shape block).
- `mcp-server/src/memory/service.ts`: the hidden-control counter (per profile), the commit candidate, and the anonymity decision (OD-1), all from the outcome `afterCall` already has.
- `mcp-server/src/memory/tab-state.ts` (new): the per-tab cache the memory service needs for itself — the last observed origin, path and anonymity verdict per (connection, tab), the `ref → role` map of the last snapshot, and the attribution window (D-08). It is the memory side's answer to what the site map already keeps for clicks, and it is needed because a failed call carries no `siteContext` (C7).
- `mcp-server/src/memory/queue.ts`: the new capture op for the counter, and its folding (the queue folds a visit op per profile and origin).
- `mcp-server/src/memory/reconcile.ts`: the counter and the pending commit mode applied to the record.
- `mcp-server/src/memory/site-record.ts`: the profile state accepts the counter key — its `onlyKeys` check is strict, so the key must be added there — and the new fact kind and identity are validated.
- `mcp-server/src/memory/output.ts`: the two new lines in the reminder and in `browser_memory`, and the drop order.
- `mcp-server/src/tools/memory.ts`: the tool description (FR-006).
- `scripts/memory.mjs`: the `inspect` line for the new facts.
- `specs/003-website-agent-memory/contracts/fact-allowlist.json`: version 3 — the new kind, the field types, the commit modes, the failure codes and the fixed words (the reviewed vocabulary).
- `specs/003-website-agent-memory/contracts/memory-store.schema.json`: the new kind, its identity pattern, the bounded shape value, and the hidden-control counter in `profileState`.
- `specs/003-website-agent-memory/contracts/site-context.schema.json`: the optional shape block.
- `specs/007-form-shape-facts/contracts/interaction-vocabulary.json`: the proposed vocabulary, for owner review (this is the draft that becomes version 3 above).
- Tests: `tests/memory-tab-state.test.ts` (new), plus additions in `tests/memory-allowlist.test.ts` (the vocabulary and the version), `tests/memory-store.test.ts` (the new identity, the kind, the profile key, and an old store still validating), `tests/memory-privacy.test.ts` (the gate split and the "no content" rule), `tests/memory-output.test.ts` (the two lines, the kind filter, the drop order and the bound), `tests/memory-boundaries.test.ts` (the per-site bound, the value's bytes and the counter's cap), `tests/memory-queue.test.ts` (the new op), `tests/memory-admin.test.ts` and `tests/memory-policy.test.ts` (the owner's commands), and `tests/helpers/fake-dom.ts` (the visibility rules need opacity, visibility and client rects).
- Docs: `README.md` (the website memory section), `CHANGELOG.md` (including the downgrade quarantine), `SECURITY.md` (what is stored and what is not).

**Risks**

- **A form shape is a hint that can go stale**: a site redesign changes the fields. The fact carries its observation times like every other 003 fact, and the owner can delete the site's facts. A stale shape costs one wrong attempt, not a wrong action, because the agent still sees the page. This feature adds no staleness marker (C5).
- **The count of fields can hint at a workflow** (OD-1, Option 2): on a signed-in site, "4 fields, one of them a password" says something about the site's business. Option 1 avoids it; Option 2 is an owner decision with its own privacy test.
- **Under Option 1 the whole feature is inert on the sites where forms live.** A site with a cookie or any storage reports `anonymous: false`, so it holds no shape fact — including every sign-in form on a site that has ever set a cookie. The counter survives (C6), and it is the part that reaches the measured site of E1/E2.
- **A commit mode learned from a write** is only as good as the observation: a write that the page swallowed (a rejected value) looks like a write that did not commit. The mode then reads `unknown` while the form needs a button. The cost is one wrong attempt, which is why the mode is observed and never guessed (C4). A commit without a navigation, or a navigation later than the extension's settle window, is not seen, and the mode stays `unknown`.
- **A navigating click is read as a button commit**: a click that moved the address is taken for a commit by a button, and the click's role comes from the last snapshot's `ref → role` map. A click on a link that navigates is therefore counted for the path it was made on. The cost is one wrong attempt on that path, and the mode is a hint the agent still verifies against the page.
- **The hidden-control counter grows with the agent's failures**: it is an activity count with no target, capped at 1,000,000, and it never falls. It is also per profile (C2), so an agent in another profile rediscovers the hidden control by itself — the accepted cost of not sharing activity between profiles.
- **The counter needs a prior read**: a refused action on a tab the daemon never observed has no known origin, so nothing is counted (C7). The attribution window is 120 seconds (D-08), so a long detour between the read and the refusal also loses the count.
- **A field type outside the list is counted as `other`**: the count stays right, the type does not. The agent is told `other`, never a guess.
- **The extension's probe budget**: the shape is one more reading inside the probe's existing budget; when the budget is spent, the probe answers `anonymous: null` as it does today, and no shape is stored.
- **A downgrade quarantines whole records** (R-15). The escape hatch is the owner's command, and the CHANGELOG must carry it before the first release.

**Tests**

- The shape of a synthetic three-field form (one required, one password, one visually hidden) is stored as one fact with the right counts and types, and its stored bytes contain none of the labels, values or placeholders (E3, E5).
- The measurement rules hold: the fields are the fillable controls (D-01); the type mapping is the reviewed one (D-02); an `opacity: 0` field is hidden (D-03); `required` and `aria-required` count (D-04); the landmark is `<main>` or `role="main"` (D-05); the root path gets a fact (D-06); the most-filled form wins (D-07).
- A page whose path holds a segment outside the reviewed path list gets no shape fact; a page with no form gets none; a scoped or truncated read gets none.
- An extension that sends no shape block produces no fact and no error (OD-2).
- An action refused with `ELEMENT_HIDDEN` raises the hidden-control counter in the acting profile's state; any other code raises none; the stored record holds no part of the target (E1). A refusal on a tab that was never read raises nothing, because no origin is known for it (C7).
- Under OD-1 Option 1, a site that looks signed-in holds no shape fact (its hidden-control counter is still counted, C6); under Option 2 it holds the shape fact and nothing else (E2). The test names the option it covers.
- A write that pressed Enter and moved the address gives `enter` at the next read of that path; a click on a control the last snapshot marked `button` that moved the address gives `button`; a write that moved nothing leaves the mode `unknown` (FR-011, C8).
- The reminder and `browser_memory` show the two lines within 8 lines and 600 characters, the counter appears under `all` and `visits` and not under `facts`, and the shape line says it describes the form's structure (E4, D-09).
- The vocabulary drift test fails when a list changes without a version bump.
- Every existing 003 test still passes unchanged, including the store, privacy, scope and boundary tests.

**Complexity Tracking**

| Addition | Why it is worth it | Where it lives |
|---|---|---|
| A new module, `tab-state.ts` | The attribution rule needs a per-tab cache, and `service.ts` is 478 lines against a 600-line cap | `mcp-server/src/memory/tab-state.ts` |
| A new capture op, `hidden` | The counter is profile activity, not a fact; keeping it out of the facts keeps the gate split honest | `mcp-server/src/memory/queue.ts`, `reconcile.ts` |
| A new kind and a new identity pattern | The store's validator is strict in three places, so a new kind is a validator change, not only a schema change | `mcp-server/src/memory/site-record.ts` |
| A new optional block in the extension's result | The shape must be measured in the DOM, and the probe is where the DOM is already read | `extension/lib/site-context.js` |
| A pending-commit-mode holding area | The mode may only be written where the anonymity gate is evaluated, which is a read | `mcp-server/src/memory/tab-state.ts` |

No constitution article is violated, and nothing here needs an exception.

**Owner review gates**

1. **The vocabulary** — [contracts/interaction-vocabulary.json](contracts/interaction-vocabulary.json) becomes 003's `fact-allowlist.json` version 3 only after the owner approves it. The field types (D-02), the commit modes and the two wording items (CHK029, D-10) are part of that approval.
2. **OD-1** — does the anonymity gate cover the shape fact? Option 1 is the default in this plan. The answer changes FR-004 and SC-003 and nothing else.
3. **OD-2** — does the specification cover the extension change? The counter works without it; the shape does not.
4. **The mirror's fingerprint** — `.specify/memory/constitution.md` no longer matches the root `constitution.md` (see the Constitution Check). Refreshing the mirror is a repository-hygiene task, not part of this feature.
5. **The review checklist** — [checklists/form-shape-quality.md](checklists/form-shape-quality.md) holds 40 items; the markers are the reviewer's, and the implementation must not touch them.
