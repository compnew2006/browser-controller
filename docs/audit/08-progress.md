# Execution record

`00`–`07` are the audit as delivered. This file is the log of what was actually executed, with the
numbers measured after each phase and every place where the plan changed while being applied.

Rule for this file: it records what happened, not what was intended. A step that was skipped or
reshaped says so, with the reason and what that costs.

---

## P1 — Mechanical dedup — done

Branch `agent/p1-mechanical-dedup`, five commits on `1d33123`.

| # | Plan step | Commit | Result |
|---|---|---|---|
| 1 | `isRecord` from `service-common` | `d426365` | private copy deleted |
| 2 | `extension/lib/timing.js` | `6067e47` | 3 duplicate timeout/sleep bodies → 1 module, 9 files |
| 3 | `daemon-config` secret reader | `4363055` | 4 functions → 2 helpers + 4 wrappers |
| 4 | dead export `clearInspectionState` | `a0b4e40` | deleted, zero references |
| 5 | smoke daemon starters | **not done** | see deviation 1 |

### Measured after P1

```
files 194 · symbols 2403 · parseFailures 0
exactGroups   45 -> 44   (members 119 -> 115)
shapeGroups   22 -> 19   (members  68 ->  60)
unusedExports 35 -> 35
testOnlyExports 53
edges 334 · unresolved 0 · cycles 2
```

`npm test` 89 files / 1138 tests (baseline 1133 + 5 added in F13).

### Deviation 1 — step 5 was a false positive in `04`

`restartManagedDaemon` and `startManagedDaemon` in `scripts/smoke-real-chrome.mjs` are an identical
body pair, but both are called: `startManagedDaemon` at :166 (only when the unit is not running) and
`restartManagedDaemon` at :179. They issue different `systemctl` verbs. Deleting either breaks the
smoke script, so both stay. The extractor will keep listing them as an identical group; that
expectation in `04` should be read as "reviewed, keep".

### Deviation 2 — the Phase 1 acceptance number was wrong

`06` predicted `exactGroups` would drop by at least 2. It dropped by 1. The second group is the smoke
pair above, which cannot be merged. The shape groups dropped by 3 as expected.

### Deviation 3 — F13 needed new codes, not a reused one

`05` F13 proposed reporting an unsupported origin as `VAULT_ORIGIN_MISMATCH`. That code's message is
"The active page does not match the exact site origin saved for this account", which is also untrue
for a `chrome://` page. Added `VAULT_ORIGIN_UNSUPPORTED` and `VAULT_PAGE_UNRESPONSIVE` instead, each
with its own sentence in `extension/lib/vault.js`, `mcp-server/src/vault/service-common.ts` and the
`VAULT_CODE_VALUES` set in `redaction.ts`. `bridge-transport.ts` no longer reports an inspect timeout
as `VAULT_TARGET_UNSAFE`.

Cost: two more values on the wire. Both are additive; nothing switches on the code set exhaustively.

### Incident — the 600-line gate

F13 alone took `extension/lib/vault.js` to 629 lines and failed
`tests/architecture-maintenance.test.ts` (600-line boundary for production modules). It was not
raised. Step 4 (dead export) was committed first, 599 → 593, and the catch was written in 3 lines:
598 now.

**`extension/lib/vault.js` must not grow.** It has 2 lines of headroom and no more; any further work
in it is P3's job (splitting it), not an addition.

### Note on test quality

Five assertions were added and each was verified to fail against the old code, not just pass against
the new one. One draft test (for the redaction allowlist) was found to pass with and without the
change and was deleted rather than shipped as a tautology. Consequence worth knowing: a code missing
from `VAULT_CODE_VALUES` is scrubbed as an ordinary string and survives, so that set is vocabulary
documentation, not validation.

---

## P2 — Boundaries, cycles, names — in progress

### Step 1 — break the cycles (F5) — done

Two commits: `b8a98cf` (validation → `tools/params.ts`), `85f87d7` (list+map → `tools/registry.ts`).

```
cycles 2 -> 0 · modules 196 · edges 340 · unresolved 0
```

`npm test` 89 files / 1138 tests.

Where the plan was incomplete: `06` says `registry.ts` "builds and exports `toolMap` from a tool
list, and `batch.ts` imports `toolMap` from `registry.js`". That is still a cycle — `registry` imports
`batchTool`, `batch` imports `toolMap`. The map is a runtime lookup, so it needs late binding:
`batch.ts` exposes `useToolRegistry()` and `registry.ts` installs the map at load. No tool name, no
test and no `ToolHost` contract changed.

`register-tools.ts` keeps a re-export of `parseToolParams` because `tests/register-tools.test.ts`
drives validation through the bootstrap. Removing that re-export is a `tests/` edit — which is the
open question below.

### Step 2 — move `router.js` (ADR-05) — done, `106e721`

`extension/lib/router.js` → `extension/dispatch/router.js`. Only import specifiers moved: `background.js`,
the router's own `lib/` imports (one level down, so `../lib/*`), 4 comments naming the old path, and 5
test files whose dynamic `import('../extension/lib/router.js')` had to follow.

### Step 3 — rename the vault modules (F10) — done, `f212b7d`

`extension/lib/vault.js` → `vault-actions.js`; `extension/vault/vault.js` → `vault-page.js`. Five
importers in `extension/`, two test import paths, and `vault.html`'s `script src`. Git sees both as
renames with a zero-line diff inside the files, which is what makes this reviewable as a pure rename.

### Measured after P2

```
cycles 2 -> 0 · modules 196 · edges 340 · unresolved 0 · parseFailures 0
npm test: 89 files / 1138 tests
```

### The `tests/` question — resolved by doing the narrow thing

Steps 2 and 3 needed test **import paths** updated (5 files and 2 files). That is the minimum edit that
makes a rename possible, and it changes no assertion and no fixture. Two rules held:

- a rename commit may touch test import specifiers and nothing else in `tests/`;
- no test may be deleted, skipped or relaxed to make a refactor pass.

The relaxation `register-tools.ts` still needs (`parseToolParams` stays re-exported) is a real
exception, not a hole: the function moved, the bootstrap keeps a one-line re-export so the existing
test can keep importing it from where it was. Deleting that line is P5's job (export narrowing), with
the test updated then.

