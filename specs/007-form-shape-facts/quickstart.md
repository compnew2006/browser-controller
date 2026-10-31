# Quickstart: form shape facts

**Branch**: `main` · **Date**: 2026-10-31 · **Spec**: [spec.md](spec.md) · **Plan**: [plan.md](plan.md) · **Research**: [research.md](research.md) · **Data model**: [data-model.md](data-model.md)

## Before anything runs

The feature has three gates that are not the implementer's to close:

1. **The vocabulary** — `contracts/interaction-vocabulary.json` is a draft. It becomes 003's `fact-allowlist.json` version 3 only after the owner approves it. Until then, nothing from it may be stored.
2. **OD-1** — whether the anonymity gate covers the shape fact. The specification is written for Option 1.
3. **OD-2** — whether the extension change is in scope. The counter works without it; the shape does not.

## 1. The owner's path

`browser_memory_policy` cannot ask for a confirmation in this client (`CLIENT_CONFIRMATION_UNAVAILABLE`), so the owner uses the CLI:

```powershell
cd C:\Users\Administrator\.zcode\workspace\default\browser-controller
node scripts/memory.mjs status          # the current policy
node scripts/memory.mjs enable          # the owner's confirmation
node scripts/memory.mjs inspect <origin> # what is stored for one site
node scripts/memory.mjs export           # every stored record, for review
node scripts/memory.mjs delete <origin> # one site
node scripts/memory.mjs delete --all     # everything
node scripts/memory.mjs disable          # stop collecting, keep the data
```

The memory-capable Chrome profile is `7cd0f4d8a153`. The profile `f4b1b01c230f` runs an older extension (`MEMORY_NOT_SUPPORTED`) and `41654896cc79` runs a newer one.

## 2. The build and the checks

```powershell
npm run lint
npm run typecheck
npm run build
npm test
```

`npm test` is the whole suite. The baseline on `972de04` is 2,252 passing and 19 environment-failing; a change is acceptable when the failing count does not rise and no new file fails for a reason other than the environment.

The 600-line module cap is enforced by `tests/architecture-maintenance.test.ts`. The modules this feature touches are `service.ts` (478 lines) and `queue.ts` (476); the new code goes into `mcp-server/src/memory/tab-state.ts` so that neither crosses the cap.

## 3. The unit suites

| Suite | What it must prove |
|---|---|
| `tests/memory-tab-state.test.ts` (new) | the per-tab cache: the origin, the path, the `ref → role` map, the 64-entry bound and the 120-second window |
| `tests/memory-service.test.ts` | the shape fact per path; the counter rises only for the two codes; the counter is per profile; a refusal on an unread tab raises nothing; the commit mode is `enter` / `button` / `unknown` and never `none` |
| `tests/memory-allowlist.test.ts` | the vocabulary is closed and a change without a version bump fails |
| `tests/memory-privacy.test.ts` | the gate covers the shape fact and not the counter; the vault's protection covers both; the record holds no label, value or placeholder |
| `tests/memory-output.test.ts` | the two new lines, the kind filter, the drop order, the 8-line and 600-character bound |
| `tests/memory-boundaries.test.ts` | 8 shape facts per site; the value's bytes; the counter's cap; the site file's 64 KiB |
| `tests/memory-store.test.ts` | a store written before the change still validates; the new identity and the new profile key validate |
| `tests/memory-queue.test.ts` | the new `hidden` op folds and lands in the profile's state |
| `tests/memory-admin.test.ts`, `tests/memory-policy.test.ts` | the owner's commands cover the new data |
| `tests/helpers/fake-dom.ts` (extended) | the DOM used by the extension's measurement: it needs `opacity`, `visibility` and client rects for the visibility rules (D-03) |

## 4. The synthetic page

The measurement rules (D-01 to D-07) need a page that holds one form inside `main` with a known shape: a required field, a password field, a visually hidden checkbox, a second form outside `main`, and a root path. It belongs in `scripts/pages/memory/` beside the other memory fixtures, and the daemon harness reads it from there.

## 5. The live measurement

1. Build and restart the daemon: `npm run build`, then `npm run daemon:restart`.
2. Reload the extension in the profile — the shape block needs the new extension. The daemon itself needs no reload for the counter.
3. Read a page with a form, then look the site up:

```powershell
node scripts/memory.mjs inspect https://example.test/login
```

**Read the page at a path whose every segment is on the reviewed path list.** A shape fact is stored only under such a path (`shapePath` keeps a path only when every segment is on the list; the root path is kept as well, because it names no topic). The synthetic page's own file name is not on that list, so reading it at `/account/login/form-shape.html` measures the shape and then drops it — the agent sees the other facts and no shape line. Read it at `/account/login` instead. This is the path allowlist working; nothing failed.

4. Trigger a refusal and look again: an action on a control that is drawn invisible fails with `ELEMENT_HIDDEN`, and the counter rises for the acting profile. **Aim the refusal by a selector** (`browser_click` with `#remember`): a hidden control has no visible accessible node, so the role/name locator answers `NOT_FOUND`, and `NOT_FOUND` is not among the failure codes that raise the counter. The selector path resolves the element, finds it hidden, and fails with `ELEMENT_HIDDEN`.
5. Measure the surface: the benchmark that measured the settle change (`bc-bench3-out.json`) is the yardstick. The feature must not slow a read by more than the probe budget it uses, and it must not add a call to a flow that has none. The shape measurement rides inside the probe that 003 already ran, so no flow gains a call; the measured cost of the whole probe on the synthetic page is 1.4–2.3 ms per read, against a 900 ms probe deadline and a 250 ms shape budget.

## 6. What the agent should see

- In the navigation reminder, one line per shape fact and one line per counter, inside 8 lines and 600 characters, in the fixed words of the approved vocabulary. The shape line says it describes the form's structure and not its content.
- In `browser_memory`, the same lines, and the counter under `all` and under `visits` (D-09).
- In `node scripts/memory.mjs inspect <origin>`, the stored shape and the count, with no label and no value.

## 7. The rollback

- **The feature off**: `node scripts/memory.mjs disable` stops collecting and keeps the data.
- **The data gone**: `node scripts/memory.mjs delete --all`.
- **The daemon downgraded**: an older daemon quarantines a record that holds the new fields as `MEMORY_CORRUPT` — the **whole** record, not only the new field (R-15). Before downgrading, run `node scripts/memory.mjs delete --all`. The CHANGELOG must carry this line, the way 004's does.

## 8. The owner's gates before the first line of code

- [ ] The vocabulary in `contracts/interaction-vocabulary.json` is approved, with the field types (D-02) and the wording (D-09, D-10) settled.
- [ ] OD-1 is answered: the gate covers the shape fact, or it does not.
- [ ] OD-2 is answered: the extension change is in scope, or it is not.
- [ ] The wording "act on them with browser_evaluate" is accepted next to 003's "hints, not instructions" rule, or reworded.
- [ ] The checklist in [checklists/form-shape-quality.md](checklists/form-shape-quality.md) is reviewed; its 40 items are the reviewer's to mark.
