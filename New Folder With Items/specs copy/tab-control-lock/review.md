# Review — Tab Control-Lock Shield

## MCP availability
- **graphify**: LIVE. Used for all 8 `graphify affected` runs below. Results match plan claims exactly.
- **serena / codebase-memory-mcp / socraticode**: NOT AVAILABLE this session. Native `Read` / `Grep` / `Bash` used as fallback. All load-bearing symbols were read directly from source with line numbers.

## 1. Reuse-first — PASS
Evidence: `showLockShield`/`hideLockShield` explicitly mirror `showOverlay`/`hideOverlay` (`background.js:256-289`) -- same `chrome.scripting.executeScript` primitive, same `__bc-*` id guard, same `try{}catch{}` swallow. `TabLockMap.owner`/`snapshot`/`releaseByOwner`/`unlockAll` all reused as-is from `extension/lib/tab-concurrency.js:57-139`. `isHashOnlyChange` already imported at `:41`. No new abstraction duplicates existing capability.

## 2. Spec-driven — PASS
Evidence: T1-T6 cover all 6 critical correctness issues: T4 = nav re-injection (#1); T1 = idempotent guard (#2); T5 = screenshot fidelity (#3); T1 z-index/box-shadow (#4); T6 = worker recycle (#5); T1+T3 = removal robustness (#6). All 9 success criteria in spec.md are addressed. The manual smoke checklist (tasks.md:157-167) maps 1:1 to criteria 1-8. Criterion 9 (verification gate) is T8.

## 3. Best-practice — PASS
Evidence: `chrome.scripting.executeScript` used (not deprecated `chrome.tabs.executeScript`). `showLockShield` uses `passive:false` for `wheel`/`keydown` (T1 spec). The existing `handleMessage` `onMessage` listener does NOT use `return true` (it is a WS handler, not a chrome.runtime.onMessage listener, so this is N/A). Idempotent guard via `getElementById` matches existing `showOverlay:261-274` pattern. The injected capture-phase listeners use `{capture:true}`.

## 4. Stack-correctness — PASS
Evidence: Read `extension/manifest.json` -- `scripting` permission at line 14, `tabs` at line 12. Both already present. No new permission needed. No TS changes claimed; plan explicitly says MCP server/daemon are UNTouched. Extension is plain JS. No manifest.json changes in file-impact order. Version stays `2.0.0`.

## 5. Blast-radius honesty — PASS
Evidence: Ran `graphify affected` independently for all 5 named symbols plus 3 APIs:

| Symbol | graphify result | Plan claim | Match? |
|--------|----------------|------------|--------|
| `handleTabs` | `dispatch():483`, `handleMessage():406` | Same | YES |
| `TabLockMap` | 13 dependents listed | Same 13 | YES |
| `showOverlay` | `handleMessage():428`, `connect():210` | Same | YES |
| `hideOverlay` | `handleMessage():437`, `connect():210` | Same | YES |
| `handleScreenshot` | `dispatch():480`, `handleMessage():406` | Same | YES |
| `initConnection` | No affected nodes | Same (plan says "not surfaced") | YES |
| `chrome.tabs.onRemoved` | No unique node match | Same | YES |
| `chrome.tabs.onUpdated` | No unique node match | Same | YES |

**No unlisted dependent surfaced.** Blast radius section is accurate and complete.

## 6. Core safety invariant — PASS
Evidence: Read `handleClick` (`background.js:702-760`) -- it uses `safeExec(tabId, func)` at line 708, which calls `chrome.scripting.executeScript` (`:572-587`) to run the function IN THE PAGE. The injected code dispatches events directly via `el.dispatchEvent(new MouseEvent(...))` (`:747-751`) and `el.dispatchEvent(new KeyboardEvent(...))` (`:812-816`). These are synthetic events targeted at a specific DOM element, NOT hit-tested through the viewport. A DOM overlay with `pointer-events:auto` blocks real user clicks (which go through hit-testing) but does NOT block `el.dispatchEvent()` (which bypasses hit-testing entirely). Similarly, `handleType` (`:779-818`) dispatches directly on `el`. The plan's claim is correct.

Confirmed: `handleDrag` (`:1586-1637`) uses CDP `Input.dispatchMouseEvent` which operates at browser level, not DOM event level -- a DOM shield does not block it. Plan does NOT claim the shield blocks drag (correct). `handleUploadFile` and `handleRunAction` also use `safeExec` / CDP, not hit-tested events.

**The invariant holds: agent's synthetic clicks/types bypass the shield.**

## 7. Edge cases

### 7a. `releaseByOwner` return timing — PASS
Read `TabLockMap.releaseByOwner()` (`tab-concurrency.js:95-103`): it is synchronous -- iterates the map, deletes entries, and returns `released[]` in one synchronous pass. `background.js:366` calls it and immediately gets the array. The plan's F3 says to loop the returned array -- this works because `releaseByOwner` is sync and returns before `hideLockShield` is called on each tabId.

### 7b. `unlockAll` snapshot-before-clear — PASS
Plan T3 is explicit: "BEFORE `tabLocks.unlockAll()`, capture `const prev = tabLocks.snapshot()`". `TabLockMap.unlockAll()` (`tab-concurrency.js:112-114`) calls `this.locks.clear()`. `TabLockMap.snapshot()` (`:107-109`) reads entries synchronously. Since both are sync and `snapshot()` is called before `unlockAll()`, the ordering is unambiguous and correct.

### 7c. Dual `onUpdated` listeners — NOTE (safe, no shared mutable state)
The existing listener inside `handleNavigate` (`:646-663`) is a closure-scoped per-call listener that filters by `tId !== tab.id`, removes itself on `complete`, and is added/removed entirely within the scope of a single `handleNavigate` invocation. The proposed module-level listener (`:1799`) filters by `tabLocks.owner(tabId)`. They share no mutable state. Chrome supports multiple `onUpdated` listeners. No conflict. NOTE rather than FAIL because the plan correctly identifies this and keeps them separate.

### 7d. Startup sweep race — NOTE (acceptable)
The plan's T6 sweep calls `chrome.tabs.query({})` then iterates per-tab, checking `tabLocks.owner(t.id)`. Since `tabLocks` is empty at startup (worker just recycled), every tab will have `!tabLocks.owner(t.id)` and the sweep will `hideLockShield` on all tabs. A race where a new lock is taken during the sweep is theoretically possible but extremely unlikely (the daemon needs to connect, authenticate, and send a lock message during the sweep's ~100ms window). Even if it races, the worst case is the shield is briefly hidden then re-appearing via the next `onUpdated` complete event. The plan acknowledges this as a "best-effort" mitigation with low likelihood. Acceptable for v1.

### 7e. z-index match — PASS
Existing overlay uses `z-index:2147483647` (`:267`). Plan specifies `z-index:2147483647`. Match confirmed.

## 8. Proportionality — PASS
Evidence: This is the simplest change that satisfies the requirement. The plan adds two injection helper functions and wires them into existing lock/unlock paths. It correctly gates T7 (pure helper extraction) on real testable logic emerging -- and correctly notes that if no pure logic exists, fabricating Chrome API mocks is unwarranted. The existing codebase only unit-tests `tab-concurrency.js` (genuinely pure); the shield wiring is `chrome.scripting` glue with no testable logic beyond the idempotent guard, which is inherently DOM-dependent. The gate is sound.

The optional T7 does NOT risk shipping untested safety-critical code because the safety-critical paths (lock/unlock wiring, re-injection, screenshot hide/restore) are all integration-level concerns that can only be verified by the manual smoke checklist (no Chrome harness exists for automated testing). The guard logic is a one-liner `getElementById` check. No complex set arithmetic is planned.

---

## Hard reject criteria check
- **Unlisted graphify dependent**: NONE found. All 8 `graphify affected` runs match plan claims.
- **Manifest/TS/tab-concurrency.js API/wire protocol modification**: NONE. Plan explicitly excludes all four.
- **Core safety invariant wrong**: The invariant is correct. `handleClick`/`handleType` use `safeExec` -> `chrome.scripting.executeScript` -> `el.dispatchEvent()`, which bypasses hit-testing.
- **Missed release path**: All 5 release paths are covered (unlock, close, unlockTab, unlockAll, releaseSession). `onRemoved` correctly excluded (tab gone).
- **Silent new manifest permission**: NONE. `scripting` and `tabs` already present.

## Verdict

**VERDICT: APPROVE**
