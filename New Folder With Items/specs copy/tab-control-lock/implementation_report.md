# Implementation Report — Tab Control-Lock Shield

## Header

- **Edit primitive used:** native `Edit` (exact string replacement) + `Write` (for this report). Serena MCP was NOT used.
- **MCPs live this session:** `graphify` (LIVE, used as-is from `graphify-out/graph.json` per spec header; not re-run by the Builder — the Planner/Reviewer already ran all `graphify affected` traces and they are cited in `plan.md`/`review.md`).
- **MCPs NOT available:** `serena`, `codebase-memory-mcp`, `socraticode` (availability unknown this session). **Fallback used:** native `Read` / `Grep` / `Bash` (`grep`, `node --check`, `git diff --check`) against `extension/background.js`, `extension/lib/tab-concurrency.js`. Every load-bearing symbol (`showOverlay`/`hideOverlay`, `TabLockMap.owner`/`snapshot`/`releaseByOwner`/`unlockAll`, `handleTabs`, `handleScreenshot`, `releaseSession`, popup handlers, `initConnection`, `onRemoved` listener) was READ in source this session before editing, with verified exact strings.
- **Files changed:** exactly `extension/background.js` (+130 / -6; the -6 are the 4 inline `captureVisibleTab` lines replaced by T5's wrapped version plus 2 lines from the original `unlockAll`/`releaseSession` bodies that were expanded). No new files. No manifest, content.js, tab-concurrency.js, mcp-server, package.json, or test changes.
- **Worktree/baseline:** worked in the current working tree `/Users/noiemany/.zcode/workspace/default/real-browser-mcp` on branch `main`. NOTE: `run-manifest.md` was NOT present in the repo (searched root + all subdirs); proceeded on the explicit task instructions, which fix the worktree and baseline. Pre-existing unrelated modifications to `.gitignore`, `.zcode/plans/*`, `mcp-server/src/bridge.ts`, `mcp-server/src/daemon.ts`, `tests/bridge.test.ts`, `tests/daemon.test.ts`, and the pre-existing `extension/background.js` WebSocket-subprotocol diff were present at session start (`git status`) and were LEFT UNTOUCHED — not reset, staged, committed, or overwritten.

---

## Per-task status + evidence (line numbers AFTER my edits)

| Task | Status | Evidence (file:line) |
|---|---|---|
| **T1** Add `showLockShield`/`hideLockShield` helpers | DONE | `extension/background.js:311` (`async function showLockShield`), `:342` (`async function hideLockShield`). Both async, both `try{}catch{}` swallow, both target `__bc-lock-shield` (NOT `__bc-overlay` — verified `grep -c __bc-overlay` returns 0 inside both function bodies). `showLockShield` injected `func`: idempotent `getElementById` guard; `position:fixed;inset:0;z-index:2147483647;pointer-events:auto;background:transparent;box-shadow:inset 0 0 0 4px #2563eb;`; capture-phase listeners for `pointerdown, click, mousedown, mouseup, contextmenu, focus` (`{capture:true}`) and `wheel, keydown, keyup` (`{capture:true, passive:false}`) each calling `e.preventDefault(); e.stopImmediatePropagation();`; appended to `document.documentElement`. `hideLockShield` injected `func`: `document.getElementById('__bc-lock-shield')?.remove()`. |
| **T2** Wire `showLockShield` on lock acquisition | DONE | `handleTabs` case `'lock'`: `extension/background.js:1359` (`showLockShield(tabId);` after `tabLocks.lock`). Popup `lockTab`: `extension/background.js:1847` (`showLockShield(msg.tabId);` after `tabLocks.lock`). Existing `broadcastStatus(...)` calls preserved. |
| **T3** Wire `hideLockShield` on EVERY release path | DONE | `releaseSession`: `:429` (`for (const tabId of released) hideLockShield(tabId);` — loops the array returned by synchronous `releaseByOwner`). `handleTabs` case `'close'`: `:1344` (defensive; comment notes `onRemoved` also fires). `handleTabs` case `'unlock'`: `:1367`. Popup `unlockAll`: `:1832` (`for (const { tabId } of prev) hideLockShield(tabId);` — `prev = tabLocks.snapshot()` captured at `:1830` BEFORE `tabLocks.unlockAll()` at `:1831`, strict ordering per review NOTE 7b). Popup `unlockTab`: `:1860`. `onRemoved` listener: intentionally NOT given a `hideLockShield` (page already gone) — documented in a comment at `:1884`. |
| **T4** Module-level `chrome.tabs.onUpdated` re-injection listener | DONE | `extension/background.js:1904` (`chrome.tabs.onUpdated.addListener((tabId, changeInfo) => { if (changeInfo.status === 'complete' && tabLocks.owner(tabId)) showLockShield(tabId); });`). Placed as a sibling AFTER the `onRemoved` block (`:1883-1892`), BEFORE `initConnection()`. The per-call listener inside `handleNavigate` (`:717`) is UNMODIFIED (verified — still the closure-scoped short-lived listener). Comment cites `isHashOnlyChange` + review NOTE 7c. |
| **T5** Hide/restore shield around `handleScreenshot` capture | DONE | `extension/background.js:1281` (`const wasLocked = !!tabLocks.owner(tabId);`). If locked, `await hideLockShield(tabId)` (`:1283`) before the capture; `captureVisibleTab` is inside a `try { ... } finally { ... }` (`:1285-1296`) whose `finally` calls `showLockShield(tabId)` (`:1293`) wrapped in `try{}catch{}`. Return shape `{success, format, data}` unchanged. Existing `active:true` activation + 150ms settle intact. |
| **T6** Startup sweep in `initConnection` | DONE | `extension/background.js:131` (`const all = await chrome.tabs.query({});`) inside `initConnection`, AFTER `connect()`. Per-tab `if (!tabLocks.owner(t.id)) { try { await hideLockShield(t.id); } catch {} }`. Whole sweep wrapped in outer `try{}catch{}`. Comment cites the in-memory limitation + review NOTE 7d. |
| **T7** (OPTIONAL) Extract pure helper + unit test | **SKIPPED** | Rationale: T1–T6 produced only `chrome.scripting.executeScript` glue and lock-state reads against the already-tested `TabLockMap`. The only "logic" is (a) the idempotent `getElementById` guard — DOM-dependent, runs inside the injected page function, not unit-testable without a Chrome/DOM harness; (b) the `snapshot()`-before-`unlockAll()` ordering — already a method on the tested primitive (`tests/tab-concurrency.test.ts` covers `TabLockMap`), and the ordering is a two-line idiom, not an extractable pure function; (c) `releaseByOwner` returning the released list — already a method on the tested `TabLockMap`. No non-trivial set-diff/state arithmetic exists. Fabricating a `diffShieldSets` helper purely to justify a test would be cargo-cult, which the plan (`plan.md:20`, `:136`) and review (section 8) explicitly warn against. The safety-critical behavior is verifiable only via the manual smoke checklist (no automated Chrome harness exists for the extension). No file created. |
| **T8** Verification gate | DONE | See "Verification gate output tails" below. All three commands exit 0. |

---

## Verification gate output tails (build / typecheck / test)

### `npm run build` (→ `tsc -p mcp-server/tsconfig.json`)
```
BUILD EXIT CODE: 0

> browser-controller@2.0.0 build
> tsc -p mcp-server/tsconfig.json
```
(No TS errors. The extension is plain JS, so `tsc` does not type-check `extension/background.js`; no MCP-server/TS source was changed by this feature.)

### `npm run typecheck` (→ `tsc -p mcp-server/tsconfig.json --noEmit`)
```
TYPECHECK EXIT CODE: 0

> browser-controller@2.0.0 typecheck
> tsc -p mcp-server/tsconfig.json --noEmit
```

### `npm test` (→ `vitest run`)
```
TEST EXIT CODE: 0
 ✓ tests/bridge.test.ts (22 tests) 16881ms
 Test Files  8 passed (8)
      Tests  160 passed (160)
   Start at  02:30:58
   Duration  17.16s
```
**8 test files passed, 160 tests passed, 0 failures.**

### Additional structural checks
- `node --check extension/background.js` → `PARSE OK` (final pass before handoff).
- `git diff --check extension/background.js` → exit 0 (no whitespace/errors).
- `git diff --stat extension/background.js` → `1 file changed, 130 insertions(+), 6 deletions(-)`.
- Grep checklist (all pass):
  - `grep -n "function showLockShield\|function hideLockShield"` → both present (`:311`, `:342`).
  - `grep -n "showLockShield\|hideLockShield"` → 14 hits = 2 definitions + 12 call sites: handleTabs lock (`:1359`), handleTabs unlock (`:1367`), handleTabs close (`:1344`), popup lockTab (`:1847`), popup unlockTab (`:1860`), popup unlockAll (`:1832`), releaseSession (`:429`), handleScreenshot hide (`:1283`), handleScreenshot restore (`:1293`), onUpdated listener (`:1906`), initConnection sweep (`:134`).
  - `grep -n "chrome.tabs.onUpdated.addListener"` → module-level at `:1904` + per-call inside `handleNavigate` closure at `:717` (unmodified).
  - Shield helper bodies contain ZERO references to `__bc-overlay` (verified via `awk` scope + `grep -c`).

---

## Deviations from the plan

**NONE.** Every task (T1–T6, T8) was implemented verbatim per `tasks.md`. T7 was skipped per its own default ("Default: SKIP"), with rationale above. Reviewer's 2 NOTEs (7a `releaseByOwner` sync timing, 7b `snapshot()` before `unlockAll()`) were incorporated as written; NOTE 7c (dual `onUpdated` listeners) and NOTE 7d (startup-sweep race self-healing) were respected by keeping the listeners separate and not over-engineering the sweep. No public API, schema, config, CLI, event, manifest, permission, or wire-protocol contract was changed.

---

## Items for audit / follow-up

- **Documented limitation (spec #4):** the shield is injected top-frame only (`chrome.scripting.executeScript` default `target:{tabId}`). A determined user can still click inside a same-origin or cross-origin iframe. Accepted for v1; filed as a follow-up, not a blocker.
- **Documented limitation (spec #5):** `tabLocks` remains in-memory; a service-worker recycle wipes lock state. The T6 startup sweep is a best-effort mitigation for the visible symptom (stale shield), not a durability fix. Persisting locks to `chrome.storage.session` is intentionally out of scope.
- **Manual verification required:** the extension is plain JS with no automated Chrome harness, so the 9 success criteria in `spec.md` (criteria 1–8 are behavioral) cannot be automated. They MUST be confirmed by a human via the manual smoke checklist in `tasks.md` (lines 157–167) — see pointer below.

---

## How to manually verify

Follow the **Manual smoke checklist (post-T8, before handoff)** in `specs/tab-control-lock/tasks.md` (lines 157–167). The 7 steps there map 1:1 to success criteria 1–8 in `spec.md`:
1. Load unpacked extension; lock a tab via popup → blue inner border + input blocked on top frame.
2. While locked, run agent `browser_click`/`browser_type` → succeeds (synthetic events bypass the shield).
3. Unlock via popup → border gone; user can interact.
4. Lock, then `browser_navigate` to a new URL → border re-appears after the new document loads (T4).
5. Lock, then `browser_screenshot` → returned image has no blue border; border returns after (T5).
6. Reload the extension (worker recycle) → no stale shields on unlocked tabs (T6).
7. Lock two tabs, popup `unlockAll` → both shields gone (T3 snapshot-before-clear).

---

## Fix-loop 2 — keyboard/wheel/focus listener efficacy + cleanup symmetry

### Defect (confirmed by Judge reading source)

In the injected `showLockShield` `func`, the keyboard/wheel/focus listeners
were attached to `el` (the shield `div`). But `el` is appended as a SIBLING of
`<body>` under `<html>` (`document.documentElement.appendChild(el)`). Real
keyboard/wheel/focus events target elements INSIDE `<body>` (e.g.
`document.activeElement`), and a capture-phase listener only fires when the
listening node is an ANCESTOR of the target. Since `el` is not an ancestor of
anything in `<body>`, those listeners NEVER FIRED. Mouse/pointer listeners DID
fire because the overlay is the hit-target for pointer events. **Net effect:
keyboard input, scroll, and focus were NOT actually blocked** — violating spec
success criterion #1 ("pointer/**keyboard** input ... is blocked") and the
user's requirement ("prevent the user from controlling the tab").

### Fix applied (smallest set)

Only the listener-attachment site in the `showLockShield` injected `func` and
the cleanup site in the `hideLockShield` injected `func` were touched. No other
lines, no public API/schema/manifest/permission changes.

`extension/background.js:327-352` (`showLockShield` injected `func`):
- Mouse/pointer group (`pointerdown`, `click`, `mousedown`, `mouseup`,
  `contextmenu`) STAYS on `el` (`:329-331`) — these fire because `el` is the
  top-most hit-target.
- Keyboard/wheel/focus group (`keydown`, `keyup`, `focus`, `wheel`) MOVED to
  `document` (`:339-345`) with capture phase; `passive:false` for
  `wheel`/`keydown`/`keyup`, plain `{capture:true}` for `focus`. `document` is
  an ancestor of everything in `<body>`, so capture-phase listeners there fire
  site-wide.
- A multi-line comment (`:332-338`) explains WHY they differ.
- Handler reference stashed on the element: `el.__bcShieldDocListeners =
  { fn: block, types: docTypes }` (`:350`).

`extension/background.js:358-382` (`hideLockShield` injected `func`):
- Reads `el.__bcShieldDocListeners`, validates shape, and calls
  `document.removeEventListener(type, bound.fn, opts)` for each stored type
  BEFORE `el.remove()` (`:368-377`). No-op if `el` is absent or has no stored
  handlers (guards: `if (!el) return`, `typeof bound.fn === 'function'`,
  `Array.isArray(bound.types)`).

### Cleanup-symmetry approach chosen

Option (a) from the fix instructions: store the `block` handler + bound types
on a property of `el` (`el.__bcShieldDocListeners`), and have `hideLockShield`
read it and detach from `document` before `el.remove()`. This keeps cleanup
self-contained in the element lifecycle and works across `executeScript`
boundaries (the handler reference survives because it is stored on the shared
DOM node, not in a closure). Option (b) (reconstruct the listener reference)
was rejected as non-viable per the fix instructions.

### Verification gate (all run this session, output captured)

- `node --check extension/background.js` → `PARSE_OK`.
- `grep -n "document.addEventListener" extension/background.js` → `:344`
  (keyboard/wheel/focus attachment on `document`).
- `grep -n "removeEventListener" extension/background.js` → `:374`
  (cleanup in `hideLockShield`).
- `git diff --check extension/background.js` → exit 0 (no whitespace/errors).
- `npm run build` → exit 0 (`tsc -p mcp-server/tsconfig.json`, clean).
- `npm run typecheck` → exit 0 (`tsc ... --noEmit`, clean).
- `npm test` → exit 0. `Test Files 8 passed (8)`, `Tests 162 passed (162)`,
  0 failures. **Test count stayed at 162** (no tests added or removed — the
  shield behavior is DOM-dependent and not unit-testable without a Chrome
  harness the project does not have; the manual smoke checklist in
  `tasks.md:157-167` remains the behavioral gate).

### Scope confirmation

`git diff --name-only HEAD` shows exactly the same file set as the baseline:
`extension/background.js` (the only feature file) plus the pre-existing
unrelated modifications (`.gitignore`, `.zcode/plans/*`,
`SECURITY.md` [newly surfaced vs. audit baseline but pre-existing, not touched
by this fix-loop], `mcp-server/src/bridge.ts`, `mcp-server/src/daemon.ts`,
`tests/bridge.test.ts`, `tests/daemon.test.ts`). **Fix-loop 2 touched ONLY
`extension/background.js`.** `git diff --stat HEAD -- extension/background.js`
→ `1 file changed, 163 insertions(+), 6 deletions(-)` (was 130/-6 before this
fix-loop; the +33 net is the new document-listener attachment, the cleanup in
`hideLockShield`, and the explanatory comments).
