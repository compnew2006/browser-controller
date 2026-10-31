---
description: "Task list for the form shape facts"
---

# Tasks: form shape facts

**Input**: Design documents from `specs/007-form-shape-facts/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Tests**: Requested. SC-001..SC-009 require deterministic tests, and `AGENTS.md` asks for regressions on protocol, tab ownership, timeouts and redaction. Write each test before or with its module, and observe it failing where practical.

**Organization**: The vocabulary, the store contract and the tab cache are foundational. The story phases wire the measurement, the counter, the privacy rule and the owner's controls in priority order.

**Gate**: the owner approves the proposed vocabulary ([contracts/interaction-vocabulary.json](contracts/interaction-vocabulary.json)) and decides OD-1 before T004 starts. Nothing before that line changes stored data.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an incomplete task).
- **[Story]**: the user story the task belongs to, for traceability.
- Paths are relative to the repository root.

---

## Phase 1: Setup

- [x] T001 [P] Add the synthetic page `scripts/pages/memory/form-shape.html`: one form inside `main` with a required field, a password field, a checkbox drawn with `opacity: 0`, and a second form outside `main`; plus the fixture builders in `tests/helpers/memory-fixtures.ts` for a read that carries the shape block and one that does not.
- [x] T002 [P] Extend `tests/helpers/fake-dom.ts` with opacity, visibility and client rects, so the visibility rules (D-03) can be exercised in node. The existing `hidden` flag and inline `display` must keep working.
- [x] T003 [P] Write `docs/adr/0006-the-counter-outside-the-anonymity-gate.md` (C6, R-02) and `docs/adr/0007-attributing-a-failed-action.md` (C7, R-07, D-08). Both have status `proposed`, and both record why the counter follows the visit rule while the shape fact follows the fact rule.

---

## Phase 2: Foundational (blocks every story)

- [x] T004 FR-008, SC-006: move the approved vocabulary into `specs/003-website-agent-memory/contracts/fact-allowlist.json` as version 3 — the new kind `ui.form.shape`, the field types (D-02), the commit modes, the failure codes and the fixed words — and mirror it in `mcp-server/src/memory/allowlist.ts`. Extend `tests/memory-allowlist.test.ts` so a list that changes without a version bump fails the build.
- [x] T005 FR-007: extend `specs/003-website-agent-memory/contracts/memory-store.schema.json` with the new kind, its identity pattern (`ui\.form\.shape:.+`), a bounded shape value and the hidden-control counter in `profileState`; `schemaVersion` stays 1 and the new fields are optional, so a store written before the change still validates. In `mcp-server/src/memory/site-record.ts`, widen the identity pattern, add the kind to the known kinds, and accept the counter key in the profile state — its `onlyKeys` check rejects any unknown key. Tests: `tests/memory-store.test.ts`.
- [x] T006 FR-001, FR-009: extend `specs/003-website-agent-memory/contracts/site-context.schema.json` with the optional shape block, and prove that a result without it still validates and that a result with it is accepted.
- [x] T007 [P] Implement `mcp-server/src/memory/tab-state.ts`: the per-tab cache the memory service needs for itself — the last observed origin, path and anonymity verdict per (connection, tab), the last snapshot's `ref → role` map, and the window (D-08: "≤ 64 entries", "≤ 120 s"). It is filled by the service's own successful reads, never persisted, and never leaves the daemon. Tests: `tests/memory-tab-state.test.ts`.
- [x] T008 Add the new capture op `hidden` to `mcp-server/src/memory/queue.ts` with its folding, and apply it in `mcp-server/src/memory/reconcile.ts` so the count lands in the profile's own state. The op travels through the same writer queue, so the exclusion list and the deletion tombstones drop it like the other operations. Tests: `tests/memory-queue.test.ts`.

**Checkpoint**: the vocabulary, the contracts, the validator, the cache and the op pass their suites.

---

## Phase 3: User Story 1 — know a site's form before filling it (P1) 🎯 MVP

**Goal**: the form's shape is measured, stored per path, and read back by the agent; the commit mode is learned from what a write did.

**Independent Test**: in the synthetic site, read the page once; a later lookup of the site returns one shape fact that names the field count, the required count, the password field and the hidden field, and no label or value.

- [x] T009 [US1] Measure the form inside the `main` landmark in `extension/lib/site-context.js`, inside the existing probe budget and **after** the anonymity verdict, so an overrun still costs the facts and not only the shape (R-09). Apply the rules as they stand: the fillable fields (D-01), the type mapping (D-02), the visibility rule (D-03), the required rule (D-04), the landmark rule (D-05) and the choice between several forms (D-07). The block carries no string from the page. Tests: the extension's site-context suite.
- [x] T010 [US1] FR-002, SC-001 Collect the shape fact in `mcp-server/src/memory/facts.ts` — the `FactSources` gains the shape block — with the reviewed path rule **plus the root path `/`** (D-06). A page with no measured form, an unallowlisted path, a scoped read and a truncated read each store nothing.
- [x] T011 [US1] FR-011, SC-009 Learn the commit mode in `mcp-server/src/memory/service.ts` from the write action and its own result: the result already reports when the address changed, so no new capability is needed. A `browser_type` that pressed Enter gives `enter`, a `browser_click` on a control the cached snapshot marked `button` gives `button`, a write that moved nothing leaves `unknown` (there is no `none`, C8). The candidate is held against the path it ran on and applied at the next observed read of that path, where the anonymity gate is evaluated as in 003; the mode is never inferred from the markup and never records the tool, target, tab, time or the address that proved it.
- [x] T012 [US1] FR-005, SC-005 Build the shape line in `mcp-server/src/memory/output.ts` from the fixed words, in the reminder and in `browser_memory`: it says the shape describes the form's structure and not its content, and it stays inside 003's bound of 8 lines and 600 characters.
- [x] T013 [US1] FR-006 Update `browser_memory`'s description in `mcp-server/src/tools/memory.ts` and the agent guidance text: the shape is a hint about a form's structure and never carries what was typed or what the page says. No tool's behaviour changes (C1).

**Checkpoint**: US1 works on its own — a read produces a fact, and a lookup returns it.

---

## Phase 4: User Story 2 — know that a control on this site cannot be seen (P1)

**Goal**: the failures that happen on invisible controls are counted per profile, so the next agent does not repeat the click.

**Independent Test**: in the synthetic site, click the hidden control (the call fails `ELEMENT_HIDDEN`), then read the site; a later lookup shows the counter in the acting profile's state.

- [x] T014 [US2] FR-003, SC-008 Raise the hidden-control counter in `mcp-server/src/memory/service.ts` from the outcome `afterCall` already has: the code comes from the failed call's error text, the origin from the tab cache (T007), and only `ELEMENT_HIDDEN` and `ELEMENT_COVERED` count. The counter lives in the acting profile's state and never in the shared facts, is **not** behind the anonymity gate (C6), is not raised for a tab that was never read (C7), and the target is never read.
- [x] T015 [US2] Build the hidden-control line in `mcp-server/src/memory/output.ts` from the fixed words, with one wording for both failure codes (D-10), and fix the drop order and the kind filter (D-09): the counter appears under `all` and under `visits`, and never under `facts`.

**Checkpoint**: US2 works on its own — a refusal raises a count that the next lookup shows.

---

## Phase 5: User Story 3 — never store what a form contains (P1)

**Goal**: the stored record holds counts and vocabulary words only.

**Independent Test**: a synthetic form with distinctive labels, values and placeholders is read; the stored record is compared byte for byte with a fixture that contains none of them.

- [x] T016 [US3] SC-002 Write the privacy tests in `tests/memory-privacy.test.ts`: the stored bytes of a measured form contain none of its labels, values, placeholders, help texts, ids or selectors; a type outside the list is counted as `other` and never guessed; a form that asks for a name, an address or a card number stores the count and infers no purpose. The same suite proves the counter holds a number and no part of the failed action.

**Checkpoint**: US3 works on its own — the record is provably free of page content.

---

## Phase 6: User Story 4 — the owner decides how far the facts reach (P2)

**Goal**: the owner's commands cover the new data completely, and the gate's reach is the owner's decision.

**Independent Test**: enable, inspect, export and delete a site that holds the new facts; the export lists them and the delete removes every trace.

- [x] T017 [US4] SC-004 Prove the owner's controls over the new facts in `tests/memory-admin.test.ts` and `tests/memory-policy.test.ts`: `delete <origin>` removes the shape fact and the counter of every profile of that origin; `delete --all` removes them; `exclude` stops the collection and removes the old ones; the tombstones do the same. `scripts/memory.mjs export` lists them and `inspect` counts them (FR-010).
- [x] T018 [US4] FR-004, SC-003 Apply the anonymity gate to the **shape fact** as OD-1 Option 1, and prove the hidden-control counter is counted on a site the gate excludes (C6). Add the Option 2 branch and its own privacy test behind the decision, so the chosen option is the one the tests cover. The scope gate's vault protection covers both: a profile under the vault's protection stores nothing.
- [x] T019 [US4] Prove the bounds and the compatibility in `tests/memory-boundaries.test.ts` and `tests/memory-store.test.ts`: at most 8 shape facts per site, the shape value within its byte bound, the counter's count within its cap, the site's 64-fact and 64 KiB bounds unchanged, and a store written before the change still valid. Record the downgrade consequence: an older daemon quarantines the **whole** record that holds the new fields as `MEMORY_CORRUPT` (R-15), and the owner's way out is `node scripts/memory.mjs delete --all`.

**Checkpoint**: US4 works on its own — the owner's commands and the gate's reach are settled.

---

## Phase 7: Polish and cross-cutting

- [x] T020 [P] Update the docs: the `README.md` website memory section, `SECURITY.md` (what is stored and what is not, and the gate's reach), and `CHANGELOG.md` (Unreleased) — including the downgrade line, the way 004's does.
- [x] T021 SC-007 Run the full local gate: `npm run lint`, `npm run typecheck`, `npm run build` and `npm test`; record the results, and note the failing environment-only suites separately from real failures. The baseline on `972de04` is 2,252 passing and 19 environment-failing; the failing count must not rise. **Measured**: lint clean, typecheck clean, build succeeded; 2,486 tests / 2,324 passed / 125 failed against the measured baseline's 2,414 / 2,247 / 127 — **no new failure** by name, and five environment-only failures no longer fail.
- [ ] T022 Measure the feature live, as quickstart.md sets out: the extension reloaded in the profile, one read of the synthetic form, one refused click, and the lookup that shows both. Record what the agent sees.
- [ ] T023 Independent review of the diff against the spec and the security (a fresh reviewer agent), recorded in `specs/007-form-shape-facts/review.md`. Fix the findings and rerun the affected checks. The 40 items of [checklists/form-shape-quality.md](checklists/form-shape-quality.md) are the reviewer's to mark — the implementation must not touch a marker.

---

## Dependencies & Execution Order

- Phase 1 has no dependencies.
- Phase 2: T001–T003 are parallel with each other; T004–T008 are parallel with each other and depend on the owner's gate. T005 depends on T004 for the kind's name.
- Phase 3 depends on Phase 2. T009 precedes T010; T010 precedes T011; T012 and T013 follow T010.
- Phase 4 depends on Phase 3, because both touch `mcp-server/src/memory/output.ts` and `mcp-server/src/memory/service.ts`.
- Phase 5 depends on Phase 3 — the privacy test reads the stored record the shape produces.
- Phase 6 depends on Phases 3 and 4, because the owner's commands and the gate cover both kinds.
- Phase 7 comes last.

## Parallel Example: Phase 2

```text
Task: T004 the vocabulary, version 3
Task: T005 the store contract and the validator
Task: T006 the site-context contract
Task: T007 tab-state.ts and its tests
Task: T008 the queue op and the reconcile
```

## Implementation Strategy

The MVP is Phases 1–3: the form is measured, stored and read back. Then add the counter (US2), the privacy proof (US3) and the owner's reach (US4). Each phase ends with its own suite and `npm run typecheck`. US1 and US2 are both P1 and can be delivered as one increment once Phase 2 is done; US3 and US4 close the feature.

## Notes

- No commit or push without the owner's authorization.
- Every test uses an isolated state directory.
- The 600-line module cap applies to every new module: `service.ts` is 478 lines and `queue.ts` is 476, so the new code goes into `mcp-server/src/memory/tab-state.ts`.
- A failing test is written and observed failing before the module that satisfies it.
- The owner's open gates (the vocabulary, OD-1, OD-2) are not the implementer's to close; record them as they stand rather than deciding them.

## Result and deviations (2026-10-31)

**Gate results (T021)**: `npm run lint` clean, `npm run typecheck` clean, `npm run build` succeeded, and the full suite is 2,486 tests / 2,324 passed / 125 failed. The measured baseline on `972de04` is 2,414 / 2,247 / 127. Compared by test name: **no new failure**, and five environment-only failures no longer fail. The environment-only failures are the Windows IPC named pipe (every suite that starts an isolated daemon) and the POSIX-only store branches.

**Deviations from this task list**, each with its reason:

1. **D-02 (T016)** — the daemon counted a field type outside the reviewed list by *dropping* it, while the specification (FR-001, US3 acceptance scenario 2) says such a type is counted as `other`. The extension already mapped an unknown type to `other`, so the end-to-end behaviour matched and the store's own rule did not. `boundedTypes` now counts it as `other`, and the two tests that asserted the drop were rewritten. The CHANGELOG already promised `other`; the code now keeps that promise.
2. **The per-site bound (T019)** — `formShapeLimits.shapeFactsPerSite` (8) was in the vocabulary and in the contract but was enforced nowhere, so FR-004's per-site bound was not a bound. `validateSiteRecord` now refuses a record holding more than eight shape facts, with `MEMORY_FULL`.
3. **The value bound (T019)** — the bound was measured in characters while the contract names it bytes. It is now measured with `Buffer.byteLength`.
4. **T016's file** — the privacy tests live in `tests/memory-shape-privacy.test.ts`, not in `tests/memory-privacy.test.ts`. That file's harness starts an isolated daemon for every test, and on Windows an isolated daemon cannot bind the IPC named pipe while the owner's daemon holds it, so the whole file fails there. The new file needs no daemon and runs everywhere; its header says why.
5. **T017's level** — the owner's controls are proved through the service's own `memory-admin` command rather than through `scripts/memory.mjs`, for the same reason: the CLI needs the running daemon. The CLI's own path over IPC stays covered by the pre-existing admin suite.
6. **T017's `exclude` wording** — this task list says `exclude` "removes the old ones". 003's FR-004 says excluding stops the collection and only `delete` removes records. The implementation follows 003, and the new test asserts that rule.
7. **T018's Option 2 branch** — implemented as `MemoryServiceDeps.shapeGate` (`'option1' | 'option2'`, default `'option1'`), with both branches tested and each with its own privacy assertion; [ADR-0008](../../docs/adr/0008-the-shape-gate-is-a-switch.md) records it. The owner's decision is still open; what ships is Option 1.
8. **The probe's budget (T009, R-09)** — the shape was measured with its own fixed 250 ms deadline inside a probe bounded by `PROBE_TIMEOUT_MS = 900`, so on a slow page the measurement could have made the whole probe time out and cost the anonymity verdict and every other fact. The shape's budget is now derived from what is left of the probe's own budget (`min(250, 900 − 120 − elapsed)`), and the measurement returns nothing when nothing is left. T009's wording "after the anonymity verdict" is met by that budget and by the try/catch rather than by ordering: the verdict is decided in Node from the names the probe returns, so ordering it strictly would need a second round-trip into the page. A test ("loses the shape, not the anonymity verdict, when the page is slow") holds that line.

**Findings for the owner (not fixed here; outside 007's scope)**:

- On Windows the daemon's IPC path is a fixed named pipe (`\\.\pipe\browser-controller`, `mcp-server/src/daemon-config.ts`), so no second daemon can run beside the owner's: every test that starts an isolated daemon fails while the owner's daemon runs. That is the source of the environment-only failures below. Making the path overridable by an environment variable would fix the suite on Windows and allow an isolated daemon to be measured live.
- The plan's baseline note (T021) said "2,252 passing and 19 environment-failing" on `972de04`. The measured baseline is 2,414 tests / 2,247 passed / 127 failed; the note was wrong, and the comparison uses the measured numbers.
- `npm run context:lint` passes (100/100). `npm run security:audit` reports one moderate advisory in `@hono/node-server` (a dependency, pre-existing and untouched by 007); the fix is `npm audit fix`, which changes the lockfile and is the owner's call.

