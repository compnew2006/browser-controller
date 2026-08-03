# Tasks — Tab Control-Lock Shield

Ordered, atomic, checkable. Each task states: ID, files owned, dependency, parallel-safe, change intent, acceptance evidence, focused verification command, rollback/recovery, security relevance.

Convention: "shield" = the `__bc-lock-shield` element (full-viewport transparent input-capture layer + blue inner frame). "badge" = the existing transient `__bc-overlay` corner indicator (UNCHANGED).

---

## T1 — Add `showLockShield` / `hideLockShield` helpers
- **Files owned:** `extension/background.js` (insert sibling to `showOverlay`/`hideOverlay` around `:289`).
- **Depends on:** nothing.
- **parallel-safe:** no (single-file edit region; do alongside T2/T3 by the same author).
- **Change intent:** Add two async functions:
  - `showLockShield(tabId)`: `chrome.scripting.executeScript({target:{tabId}, func, args})`. The injected `func`:
    - Guard: `let el = document.getElementById('__bc-lock-shield'); if (el) return;`
    - Create div, `el.id='__bc-lock-shield'`, `el.style.cssText='position:fixed;inset:0;z-index:2147483647;pointer-events:auto;background:transparent;box-shadow:inset 0 0 0 4px #2563eb;'`.
    - Attach capture-phase listeners on `el` for `pointerdown, click, mousedown, mouseup, wheel, keydown, keyup, contextmenu, focus` (use `el.addEventListener(type, e=>{e.preventDefault(); e.stopImmediatePropagation();}, {capture:true})`). For `wheel`/`keydown` set `passive:false` so `preventDefault` works.
    - Append to `document.documentElement`.
    - Wrap whole function body in the existing `try {} catch {}` swallow pattern (mirror `showOverlay:257-279`).
  - `hideLockShield(tabId)`: `chrome.scripting.executeScript({target:{tabId}, func: () => document.getElementById('__bc-lock-shield')?.remove()})` wrapped in `try {} catch {}` (mirror `hideOverlay:282-289`).
- **Acceptance evidence:** `grep -n "function showLockShield\|function hideLockShield" extension/background.js` returns both. Functions do NOT reference `__bc-overlay`.
- **Verification command:** `grep -n "function showLockShield\|function hideLockShield" extension/background.js`
- **Rollback:** delete the two functions.
- **Security relevance:** the shield blocks REAL user input only; synthetic events dispatched by the agent (`handleClick`/`handleType`) bypass hit-testing by construction (verified `background.js:747-758`, `:812-818`) — no privilege change.

---

## T2 — Wire `showLockShield` on lock acquisition
- **Files owned:** `extension/background.js` — `handleTabs` case `'lock'` (`:1275-1284`) and popup `lockTab` handler (`:1754-1767`).
- **Depends on:** T1.
- **parallel-safe:** no.
- **Change intent:** After `tabLocks.lock(tabId, owner)` in BOTH the tool path and the popup path, `await showLockShield(tabId)` (or `showLockShield(msg.tabId)`). Keep the existing `broadcastStatus(...)` calls.
- **Acceptance evidence:** locking a tab via either path injects `__bc-lock-shield` (manual: load unpacked extension, lock a tab, inspect DOM). Source: `grep -n "showLockShield" extension/background.js` shows 1+ call in `handleTabs` and 1 in the `lockTab` branch.
- **Verification command:** `grep -n "showLockShield" extension/background.js`
- **Rollback:** remove the two added calls.
- **Security relevance:** ensures the block is active for the entire duration of the lock (the user's safety guarantee).

---

## T3 — Wire `hideLockShield` on EVERY release path
- **Files owned:** `extension/background.js` — `handleTabs` cases `'unlock'` (`:1285-1291`) and `'close'` (`:1264-1269`); popup `unlockTab` (`:1768-1779`); popup `unlockAll` (`:1748-1753`); `releaseSession` control message (`:359-371`).
- **Depends on:** T1.
- **parallel-safe:** no.
- **Change intent:**
  - `handleTabs` case `'unlock'`: after `tabLocks.release(tabId)`, `await hideLockShield(tabId)`.
  - `handleTabs` case `'close'`: after `tabLocks.release(tabId)`, `hideLockShield(tabId)` (fire-and-forget; tab may already be tearing down).
  - popup `unlockTab`: after `tabLocks.release(msg.tabId)`, `hideLockShield(msg.tabId)`.
  - popup `unlockAll`: BEFORE `tabLocks.unlockAll()`, capture `const prev = tabLocks.snapshot();` so we know which tabIds were locked; then `tabLocks.unlockAll()`; then loop `for (const {tabId} of prev) hideLockShield(tabId);`. (Critical: `unlockAll` clears the map, so reading AFTER loses the list.)
  - `releaseSession`: `releaseByOwner(owner)` already returns the released tabIds (`:366`) — loop them and call `hideLockShield(tabId)`.
  - Do NOT add `hideLockShield` to `chrome.tabs.onRemoved` (`:1799`) — the page no longer exists.
- **Acceptance evidence:** every release path removes the shield. `grep -n "hideLockShield" extension/background.js` shows calls in: `handleTabs 'unlock'`, `handleTabs 'close'`, `unlockTab`, `unlockAll`, `releaseSession`, plus T1's definition and T5's screenshot use.
- **Verification command:** `grep -n "hideLockShield" extension/background.js`
- **Rollback:** remove the added calls.
- **Security relevance:** correctness of the user-control-restored guarantee — a missed release path leaves the user permanently blocked.

---

## T4 — Navigation re-injection via `chrome.tabs.onUpdated`
- **Files owned:** `extension/background.js` — add a module-level persistent listener near the existing `chrome.tabs.onRemoved.addListener` block (`:1799`).
- **Depends on:** T1.
- **parallel-safe:** no.
- **Change intent:**
  ```js
  // Re-inject the lock shield after a FULL navigation on a locked tab.
  // A hash-only / SPA navigation does not reload the document, so the shield
  // survives and this listener does not fire 'complete' for it (see
  // isHashOnlyChange in utils/navigation.js + handleNavigate :615-700).
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'complete' && tabLocks.owner(tabId)) {
      showLockShield(tabId); // idempotent — see __bc-lock-shield guard
    }
  });
  ```
  Do NOT modify the short-lived per-call listener inside `handleNavigate` (`:646-663`).
- **Acceptance evidence:** locking a tab, then navigating to a new URL, results in the shield re-appearing after the new document loads. `grep -n "chrome.tabs.onUpdated.addListener" extension/background.js` shows TWO listeners (the new module-level one + the existing one inside `handleNavigate` is added dynamically per call, so a static grep shows the module-level one plus the one registered inside `handleNavigate`'s closure).
- **Verification command:** `grep -n "chrome.tabs.onUpdated.addListener" extension/background.js`
- **Rollback:** remove the listener.
- **Security relevance:** without this, a navigation on a locked tab silently re-enables user control — the core safety hole this feature exists to close.

---

## T5 — Hide/restore shield around `handleScreenshot` capture
- **Files owned:** `extension/background.js` — `handleScreenshot` (`:1206-1220`).
- **Depends on:** T1.
- **parallel-safe:** no.
- **Change intent:** Wrap the `chrome.tabs.captureVisibleTab(...)` call so that IF `tabLocks.owner(tabId)` is set, `await hideLockShield(tabId)` runs first and `showLockShield(tabId)` runs in a `finally`. Keep the existing `active:true` activation + 150ms settle intact. The return shape `{success, format, data}` is unchanged.
  ```js
  const wasLocked = !!tabLocks.owner(tabId);
  if (wasLocked) { try { await hideLockShield(tabId); } catch {} }
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {format, quality: format==='jpeg'?quality:undefined});
    return { success:true, format, data: dataUrl.split(',')[1] };
  } finally {
    if (wasLocked) { try { showLockShield(tabId); } catch {} }
  }
  ```
- **Acceptance evidence:** a screenshot of a locked tab returns an image WITHOUT the blue border; the shield is present again immediately after. `grep -n "hideLockShield\|showLockShield" extension/background.js` shows the new pair inside `handleScreenshot`.
- **Verification command:** `grep -n "handleScreenshot" extension/background.js` then read the function.
- **Rollback:** restore the original 4-line capture block.
- **Security relevance:** none (visual fidelity only); the shield restore is best-effort and `onUpdated` + lock state remain the source of truth.

---

## T6 — Startup sweep in `initConnection`
- **Files owned:** `extension/background.js` — `initConnection` (`:111-123`).
- **Depends on:** T1.
- **parallel-safe:** no.
- **Change intent:** At the end of `initConnection` (after `connect()` is invoked, or just before it — either is safe since the sweep is independent of the WS), add:
  ```js
  // Best-effort: clear stale shields left on tabs whose lock state was wiped
  // by a service-worker recycle (tabLocks is in-memory; see comment :43-49).
  // Swallow per-tab errors for protected/closed tabs.
  try {
    const all = await chrome.tabs.query({});
    for (const t of all) {
      if (!tabLocks.owner(t.id)) { try { await hideLockShield(t.id); } catch {} }
    }
  } catch {}
  ```
- **Acceptance evidence:** after reloading the extension (which recycles the worker), tabs that were never locked do not show a stale shield. `grep -n "chrome.tabs.query({})" extension/background.js` shows the new query inside `initConnection`.
- **Verification command:** `grep -n "initConnection\|chrome.tabs.query({})" extension/background.js`
- **Rollback:** remove the sweep block.
- **Security relevance:** prevents a stale shield from permanently blocking the user after a worker recycle (the documented limitation in spec #5).

---

## T7 — (OPTIONAL) Extract pure helper + unit test
- **Files owned:** MAYBE `extension/lib/lock-shield.js` + `tests/lock-shield.test.ts`.
- **Depends on:** T1–T6.
- **parallel-safe:** yes (independent of the wiring).
- **Change intent:** ONLY if T1–T6 produced non-trivial pure logic worth testing (e.g. a `diffShieldSets(before, after)` that returns `{toShow, toHide}`). If the implementation is pure `chrome.scripting` glue with no testable logic, SKIP this task entirely — do NOT fabricate chrome API mocks beyond what `tests/tab-concurrency.test.ts` already uses (it uses none).
- **Acceptance evidence:** IF created, `tests/lock-shield.test.ts` mirrors `tests/tab-concurrency.test.ts` (imports from `extension/lib/lock-shield.js`, runs under `vitest`, no Chrome). IF skipped, document the decision in the PR description.
- **Verification command:** `npm test`
- **Rollback:** delete the file(s).
- **Security relevance:** none (test-only).

---

## T8 — Verification gate
- **Files owned:** none (read-only verification).
- **Depends on:** T1–T6 (and T7 if it ran).
- **parallel-safe:** yes.
- **Change intent:** confirm the build/typecheck/test trifecta is green and no extension asset regressed.
- **Acceptance evidence:** all three commands exit 0.
- **Verification commands (run in order):**
  ```
  npm run build
  npm run typecheck
  npm test
  ```
- **Rollback:** N/A (verification only). If any command fails, fix forward — do NOT commit until green.
- **Security relevance:** ensures no type/lint/test regression slipped in.

---

## Manual smoke checklist (post-T8, before handoff)

These are NOT automated (the extension is plain JS with no Chrome harness); they are the human verification of the success criteria in `spec.md`:

1. Load unpacked extension. Lock a tab via the popup. → Blue inner border appears; mouse/keyboard on the top frame is blocked.
2. While locked, run an agent `browser_click` / `browser_type` against that tab. → Succeeds (synthetic events bypass the shield).
3. Unlock via popup. → Border gone; user can interact.
4. Lock, then `browser_navigate` to a new URL. → Border re-appears after the new document loads.
5. Lock, then take a screenshot via `browser_screenshot`. → Returned image has no blue border; border returns after.
6. Reload the extension (worker recycle). → No stale shields on unlocked tabs.
7. Lock two tabs, popup `unlockAll`. → Both shields gone.
