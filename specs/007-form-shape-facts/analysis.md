# Analysis: form shape facts

**Date**: 2026-10-31 · **Artifacts analysed**: `spec.md`, `plan.md`, `research.md`, `data-model.md`, `quickstart.md`, `tasks.md`, `contracts/interaction-vocabulary.json`, `checklists/requirements.md`, `checklists/form-shape-quality.md`
**Baseline**: `main` at `972de04` · **Verdict**: **READY WITH DEPENDENCIES** — the artifacts are internally consistent; what remains is the owner's.

## Method

Cross-artifact checks, each run against the files rather than against recollection:

1. **Requirement traceability** — every `FR-001..FR-011` and `SC-001..SC-009` counted in `plan.md` and in `tasks.md`.
2. **Clarification traceability** — every `C1..C8` counted in the spec, the plan and the tasks; every `D-01..D-10` counted in the research, the plan, the tasks and the data model.
3. **Contract parity** — the draft vocabulary against the measurement rules in the research, the bounds in the data model and the requirements in the spec.
4. **Path and structure checks** — every file path named in `tasks.md`; the task ids; the internal links; the JSON.
5. **Source parity** — the store's rules in the source against the rules the artifacts state.

## Findings

| # | Severity | Finding | Evidence | State |
|---|---|---|---|---|
| A-01 | High | The trace labels were incomplete: 6 of the 11 requirements and 7 of the 9 success criteria had no label in `tasks.md`. The work was present but untraceable, which makes the checklist gate unverifiable. | the traceability matrix below | **Fixed** |
| A-02 | High | The vocabulary carried a dead value: `fieldTypes` held `hidden`, while `D-01` makes a `type="hidden"` input **not a field** (it is not fillable) and `D-02` produces 14 types without it. An implementer reading the contract could count CSRF tokens as fields and inflate the count the agent sees. | the contract's `fieldTypes` against `research.md` D-01/D-02 | **Fixed** — `hidden` removed |
| A-03 | High | The root path `/` was allowed in the research and the data model but forbidden by the contract's identity text and by FR-002, which cites 003's rule literally — and 003's `matchPath` returns null for `/` because the root has no segment to verify, and 003's `pathSegments` holds no empty segment. Three artifacts disagreed about the same path. | `mcp-server/src/memory/allowlist.ts:140-145`; 003's `fact-allowlist.json` v2 `pathSegments` | **Fixed** — the exception is now in the contract and in FR-002 |
| A-04 | Medium | SC-009 promised "a click on **the form's** button", which no implementation can know: the daemon only learns that a control's role was `button` from the last snapshot. The criterion promised more than the observation supports. | SC-009 against the plan's FR-011 | **Fixed** — the wording is now "a control the last snapshot marked `button`" |
| A-05 | Medium | FR-005 said the reminder and `browser_memory` "MUST show the new facts", while the counter is deliberately hidden under `kind: facts`. The requirement and the filter rule read as contradictions. | FR-005 against `research.md` D-09 | **Fixed** — the kind filter is now stated in FR-005 |
| A-06 | Low | The plan's example line was not literally constructible from the fixed words ("hidden" against the word "hidden field"). An implementer could have copied it verbatim and produced a line outside the vocabulary. | the plan's FR-005 against the contract's `fixedWords` | **Fixed** — the example is marked indicative |
| A-07 | Low | FR-003 states no cap for the counter while the contract caps it at 1,000,000. | FR-003 against the contract's `bounds` | **Open** — CHK014, the owner's to settle |
| A-08 | Info | The constitution mirror's fingerprint no longer matches the root `constitution.md`, and 004's plan still cites the old fingerprint as current. | the two SHA-256 values, in the plan's Constitution Check | **Open** — repository hygiene, outside this feature |

## Traceability after the fixes

| Requirement | In `plan.md` | In `tasks.md` | | Criterion | In `tasks.md` |
|---|---|---|---|---|---|
| FR-001 | yes | T009, T006 | | SC-001 | T010, T014 |
| FR-002 | yes | T010 | | SC-002 | T016 |
| FR-003 | yes | T014 | | SC-003 | T018 |
| FR-004 | yes | T018 | | SC-004 | T017 |
| FR-005 | yes | T012 | | SC-005 | T012 |
| FR-006 | yes | T013 | | SC-006 | T004 |
| FR-007 | yes | T005 | | SC-007 | T021 |
| FR-008 | yes | T004 | | SC-008 | T014 |
| FR-009 | yes | T006 | | SC-009 | T011 |
| FR-010 | yes | T012, T015 | | | |
| FR-011 | yes | T011 | | | |

Every clarification `C1..C8` appears in the spec. The binding ones — C6, C7 and C8 — appear in the plan and in the tasks. Every rule `D-01..D-10` appears in the research and is referenced by the plan and by the tasks; `D-09` and `D-10` have no data-model reference, which is correct: they are output rules, not stored entities.

## Checks that passed

- **The contract is valid JSON**; 14 field types, 3 commit modes, 2 failure codes; the bounds agree across the contract, the spec (FR-004: at most 8 shape facts per site), the plan and the data model.
- **The identity agrees** across the contract, the data model and the tasks: `ui.form.shape:<path>`, with the root exception now in all three.
- **The task list is well formed**: T001–T023, sequential, no duplicates, 6 tasks marked `[P]`, 11 carrying a user-story label, and every path it names exists except the five it is meant to create (`mcp-server/src/memory/tab-state.ts`, `tests/memory-tab-state.test.ts`, `scripts/pages/memory/form-shape.html`, the two ADRs, and `review.md`).
- **Every internal link resolves** across the nine artifacts.
- **The gate's scope is stated the same way everywhere**: the shape fact passes the anonymity gate, the counter does not (spec FR-004, the plan's FR-003/FR-004, the research's C6, the contract's `notAllowed`).
- **The counter's reach is stated the same way everywhere**: per profile, per origin, no target, from the last observed read inside the window.
- **The commit mode's vocabulary is closed**: `unknown`, `enter`, `button`; `none` appears nowhere in the artifacts.

## What blocks the implementation

Not a defect in the artifacts — the owner's decisions:

1. **The vocabulary** — `contracts/interaction-vocabulary.json` is a permission change. It becomes 003's `fact-allowlist.json` version 3 only after the owner approves it, and T004 is the first task that touches stored data.
2. **OD-1** — whether the anonymity gate covers the shape fact. Option 1 is written; Option 2 changes FR-004 and SC-003 and nothing else.
3. **OD-2** — whether the extension change is in scope. The counter works without it; the shape does not.
4. **The review checklist** — the 40 items of `checklists/form-shape-quality.md` are the reviewer's to mark; the implementation must not touch a marker.
5. **CHK014** — the counter's cap, stated in the contract and not in FR-003.
6. **CHK029** — whether "act on them with browser_evaluate" reads as an instruction against 003's "hints, not instructions" rule.
