# Plan — Tab Control-Lock Shield

Companion to `spec.md`. Two halves: **Feature coverage** (the build steps in order) and **Risk coverage** (every dependent surfaced by `graphify affected` for the symbols we touch, with its mitigation).

## Reuse map (do not reinvent)

| Need | Reuse (path:symbol) | Why it fits |
|---|---|---|
| Inject a DOM element into a tab | `extension/background.js:256-280` `showOverlay(tabId, label)` via `chrome.scripting.executeScript({target:{tabId}, func, args})` | Same primitive, same `__bc-*` id-guard pattern. The shield is a SEPARATE element (`__bc-lock-shield`) — copy the pattern, do not call `showOverlay`. |
| Remove an injected DOM element | `extension/background.js:282-289` `hideOverlay(tabId)` (`document.getElementById(...)?.remove()` wrapped in `try{}catch{}`) | Mirror exactly for `hideLockShield`. |
| Idempotent re-injection | The `let el = document.getElementById('__bc-overlay'); if(!el){...}` guard at `:261-274` | Same guard with `__bc-lock-shield`. |
| Listen on tab navigation | `chrome.tabs.onUpdated.addListener` already used inside `handleNavigate` `:646-663` (per-call, short-lived) | Add a separate module-level persistent listener for shield re-injection; do NOT touch the per-call one. |
| Lock state primitive | `extension/lib/tab-concurrency.js` `TabLockMap` (`owner`, `lock`, `release`, `releaseByOwner`, `unlockAll`, `snapshot`) — fully read this session | Reuse as-is. `tabLocks.owner(tabId)` is the single source of truth for "should this tab be shielded?" |
| Hash-vs-full nav detection | `extension/utils/navigation.js` `isHashOnlyChange(fromUrl, toUrl)` | Already imported at `background.js:41`. Use it in the `onUpdated` listener to skip no-op re-injections if needed (a hash nav does not destroy the DOM, so the shield survives). |
| Pure-helper unit-test pattern | `tests/tab-concurrency.test.ts` imports from `extension/lib/tab-concurrency.js` and runs under `vitest` with no Chrome | Any extracted pure helper (e.g. shield-state set arithmetic) follows the same pattern. |

## File-impact order (build sequence)

1. **`extension/background.js`** — add `showLockShield(tabId)` + `hideLockShield(tabId)` (sibling to `showOverlay`/`hideOverlay` around `:280-289`); wire them into every lock/release path; add the persistent `chrome.tabs.onUpdated` re-injection listener; hide/restore around `handleScreenshot` capture; startup sweep in `initConnection`.
2. **(Optional) `extension/lib/lock-shield.js`** — extract a PURE helper ONLY if there is non-trivial set logic to test (e.g. "given a snapshot of locked tabIds before and after, return the tabIds to shield and to unshield"). If the wiring is pure `chrome.scripting` glue with no testable logic, SKIP this file and SKIP a new test — do not fabricate chrome API mocks. Decision is per-task: prefer no new file unless a real pure function emerges.
3. **(Optional) `tests/lock-shield.test.ts`** — only if step 2 produces a pure helper. Mirror `tests/tab-concurrency.test.ts`. Otherwise no new test (the existing suite must still pass).
4. **No changes** to `extension/manifest.json`, `extension/content.js`, `extension/popup/*`, `mcp-server/*`, `package.json`.

## Feature-coverage steps

### F1. Define the shield injection helpers
- New `showLockShield(tabId)` in `background.js`. Injects `__bc-lock-shield` via `chrome.scripting.executeScript`. The injected `func`:
  - Guard: `let el = document.getElementById('__bc-lock-shield'); if (el) return;`
  - Create a `position:fixed; inset:0; z-index:2147483647; pointer-events:auto; background:transparent;` div.
  - Blue inner frame via `box-shadow: inset 0 0 0 4px #2563eb;` (no layout shift).
  - Attach capture-phase listeners on the element (or on `document`/`window` with a guard) for `pointerdown`, `click`, `mousedown`, `mouseup`, `wheel`, `keydown`, `keyup`, `contextmenu`, `focus` — each calls `e.preventDefault(); e.stopImmediatePropagation();`. Return `false` from any handler that the browser consults for cancelability.
  - Append to `document.documentElement` (more robust than `body` which may not exist at `document_start`-equivalent timing).
- New `hideLockShield(tabId)` — `chrome.scripting.executeScript({target:{tabId}, func: () => document.getElementById('__bc-lock-shield')?.remove()})` wrapped in `try{}catch{}` (mirrors `hideOverlay`).
- Both `async`, both swallow `chrome://` / closed-tab errors (mirror `:279`, `:288`).

### F2. Wire show on lock acquisition
- `handleTabs` case `'lock'` (`:1275-1284`): after `tabLocks.lock(tabId, owner)`, call `showLockShield(tabId)` (fire-and-forget; `await` is fine since the handler is async).
- Popup `lockTab` message handler (`:1754-1767`): after `tabLocks.lock(msg.tabId, owner)`, call `showLockShield(msg.tabId)`.

### F3. Wire hide on every release path
- `handleTabs` case `'unlock'` (`:1285-1291`): after `tabLocks.release(tabId)`, call `hideLockShield(tabId)`.
- `handleTabs` case `'close'` (`:1264-1269`): after `tabLocks.release(tabId)`, call `hideLockShield(tabId)` (defensive — `onRemoved` will also fire, but explicit is cheap).
- Popup `unlockTab` (`:1768-1779`): after `tabLocks.release(msg.tabId)`, call `hideLockShield(msg.tabId)`.
- Popup `unlockAll` (`:1748-1753`): after `tabLocks.unlockAll()`, iterate the previously-snapshotted locked tabIds (capture BEFORE `unlockAll` via `tabLocks.snapshot()` — `unlockAll` clears the map so we must read first) and call `hideLockShield(tabId)` for each.
- `releaseSession` control message (`:359-371`): `releaseByOwner(owner)` already returns the released tabIds — loop them and call `hideLockShield(tabId)` for each.
- `chrome.tabs.onRemoved` listener (`:1799-1805`): the tab is gone, so `hideLockShield` would no-op/error; skip it (the listener already drops buffers). Document this in the comment.

### F4. Navigation re-injection (correctness issue #1)
- Add a module-level persistent listener: `chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => { if (changeInfo.status === 'complete' && tabLocks.owner(tabId)) showLockShield(tabId); });`
- Place it near the existing `chrome.tabs.onRemoved.addListener` block (`:1799`) for locality.
- This is SEPARATE from the short-lived per-call listener inside `handleNavigate` (`:646-663`) — do not merge or modify that one.

### F5. Screenshot hide/restore (correctness issue #3)
- In `handleScreenshot` (`:1206-1220`): if `tabLocks.owner(tabId)`, `await hideLockShield(tabId)` before `captureVisibleTab`; in a `finally`, `showLockShield(tabId)` (fire-and-forget restore). Keep the existing `active:true` activation logic intact.

### F6. Startup sweep (correctness issue #5)
- In `initConnection()` (`:111-123`), after `autoPairToken()`/`connect()` setup (or just before), add: `try { const all = await chrome.tabs.query({}); for (const t of all) { if (!tabLocks.owner(t.id)) hideLockShield(t.id); } } catch {}` — best-effort, swallow per-tab errors.

## Risk coverage — every dependent from `graphify affected` (Phase 4)

For each symbol we plan to TOUCH, here are the dependents `graphify affected` surfaced and how we avoid breaking them.

### Touch: `handleTabs` (`extension/background.js:1241`)
Affected (depth 2):
- `dispatch()` `[indirect_call]` `:483`
- `handleMessage()` `[calls]` `:406`

**Mitigation:** We do NOT change `handleTabs`'s signature, return shape, or the switch arms' existing behavior. We only ADD `showLockShield`/`hideLockShield` calls inside the `'lock'`/`'unlock'`/`'close'` cases. `dispatch` and `handleMessage` are unaffected (they forward params and pass through the return value). No new error paths; the shield calls are best-effort/swallowed.

### Touch: `tabLocks` (`TabLockMap`, `extension/lib/tab-concurrency.js`)
Affected (depth 2):
- `background.js` `[imports]` `:39`
- `tests/tab-concurrency.test.ts` `[imports]` `:2`
- `handleTabs()` `[calls]` `:1281`
- `getOpenTabs()` `[calls]` `:334`
- `updateUI()` (popup) `[indirect_call]` `extension/popup/popup.js:236`
- `handleMessage()` `[calls]` `:366` (releaseSession)
- `tabLocksToJSON()` `[calls]` `:317`
- `runOnTab()` `[calls]` `extension/lib/tab-concurrency.js:150`
- `dispatch()` `[indirect_call]` `:483`
- `broadcastStatus()` `[calls]` `:344`
- `refreshStatus()` (popup) `[calls]` `extension/popup/popup.js:262`
- `connect()` `[calls]` `:210`
- `buildStatusPayload()` `[calls]` `:307`

**Mitigation:** We do NOT modify `tab-concurrency.js` at all — `TabLockMap` is reused as-is. We only READ `tabLocks.owner(tabId)` / `tabLocks.snapshot()` to decide shield show/hide. Every consumer above (popup `updateUI`/`refreshStatus`, `buildStatusPayload`, `getOpenTabs`, `tabLocksToJSON`, `runOnTab`, `broadcastStatus`, the test) depends on the EXISTING API, which is unchanged. The popup gains no new contract — it already shows `lockedBy` per tab; the shield is invisible to the wire protocol.

### Touch: `showOverlay` (`:256`) and `hideOverlay` (`:282`)
Affected:
- `showOverlay`: `handleMessage()` `[calls]` `:428`, `connect()` `[calls]` `:210`
- `hideOverlay`: `handleMessage()` `[calls]` `:437`, `connect()` `[calls]` `:210`

**Mitigation:** `showOverlay`/`hideOverlay` are NOT modified. The new `showLockShield`/`hideLockShield` are SEPARATE functions operating on a SEPARATE element id (`__bc-lock-shield` vs `__bc-overlay`). The per-action badge lifecycle inside `handleMessage`'s `runOnTabLib` callback (`:425-439`) is untouched — it continues to show/hide the transient activity badge independently of the persistent lock shield.

### Touch: `handleScreenshot` (`:1206`)
Affected:
- `dispatch()` `[indirect_call]` `:480`
- `handleMessage()` `[calls]` `:406`

**Mitigation:** We add a `try { if (tabLocks.owner(tabId)) await hideLockShield(tabId); ... } finally { if (tabLocks.owner(tabId)) showLockShield(tabId); }` around `captureVisibleTab`. The return shape (`{success, format, data}`) is unchanged. `dispatch`/`handleMessage` pass through. If `hideLockShield` throws (protected page), it is swallowed by its own `try{}catch{}`; the `finally` restore is also wrapped. Screenshots on UNLOCKED tabs (the common case) take the `if (tabLocks.owner(tabId))` fast path and incur zero shield work.

### Touch: `chrome.tabs.onRemoved` listener (`:1799`)
- `graphify affected "chrome.tabs.onRemoved"` → "No unique node match" (anonymous listener, not a named symbol). Verified by reading `:1799-1805`.

**Mitigation:** We do NOT modify this listener. It already calls `tabLocks.release(tabId)` and drops per-tab buffers. The tab is gone, so there is nothing to `hideLockShield` — the page no longer exists. The release-by-disconnect path (`releaseSession` → `releaseByOwner`) handles the live-tab case explicitly in F3.

### Touch: new `chrome.tabs.onUpdated` listener (F4)
- `graphify affected "chrome.tabs.onUpdated"` → not a unique node (the only existing `onUpdated` usage is the inline listener inside `handleNavigate` at `:646-663`, which is per-call and short-lived).

**Mitigation:** Adding a second, module-level `onUpdated` listener is safe — Chrome supports multiple listeners. They do not interfere: the `handleNavigate` listener filters by `tId !== tab.id` and removes itself on `complete`/timeout; the new listener filters by `tabLocks.owner(tabId)` and only re-injects the shield. They can both fire on the same `complete` event without conflict.

### Touch: `initConnection` (`:111`)
- `graphify affected "initConnection"` → not surfaced as a unique match in the graph; verified by reading `:111-123` and the `connect()` `[calls]` edge from `handleMessage`'s subgraph. `initConnection()` is called once at the bottom of `background.js:1807`.

**Mitigation:** F6 adds a best-effort `chrome.tabs.query({})` sweep wrapped in `try{}catch{}`. It runs at the END of `initConnection` so it does not block the WS connection setup. Failures (no tabs, protected tabs) are swallowed per-tab. No behavior change for normal startup.

## Blast radius

- **In-process:** `extension/background.js` only (plus an optional pure helper + test). No other runtime code changes.
- **Wire protocol:** NONE. `tabLocks` snapshot, `/status` payload, tool inputs/outputs are all unchanged. The daemon, bridge, MCP server, and popup need ZERO changes.
- **Permissions:** NONE added. `scripting`, `tabs`, `storage`, `activeTab`, `debugger`, `webRequest`, `alarms` already in `manifest.json:11-19`. Shield injection uses `scripting` (already used by `showOverlay`).
- **Storage:** NONE. No new persistence (lock state stays in-memory per existing behavior; correctness issue #5).

## Compatibility & rollback

- **Compat:** purely additive. Existing lock/unlock behavior, popup UX, and per-action badge are unchanged. Agents and the daemon see no difference.
- **Rollback:** revert the single commit (or the diff in `background.js`). No migration, no schema, no persisted state to undo. The optional `extension/lib/lock-shield.js` + `tests/lock-shield.test.ts` (if created) revert with the same commit.
- **Feature flag:** NOT required — the feature is gated by lock acquisition, which is already opt-in per tab. If a user never locks, they see no shield.

## Documentation impact

- `README.md` / `CHANGELOG.md`: a one-line entry noting "locked tabs now show a blue frame and block user input." OPTIONAL — defer to the maintainer's release process. Do NOT bump versions.

## Decisions needing user approval

NONE. All product decisions are LOCKED (see `spec.md`). The only implementation-level judgement call — "extract a pure helper + test, or keep it as glue" — is resolved per F1/F2 by preferring NO new file unless real testable logic emerges, which matches the existing codebase's discipline (the only unit-tested extension code is `tab-concurrency.js`, which is genuinely pure).

## Risk/mitigation summary

| Risk | Likelihood | Mitigation |
|---|---|---|
| Cross-origin iframe lets user click through | High (architectural) | Documented limitation (#4). Out of scope for v1. |
| Service-worker recycle leaves stale shield | Medium | Startup sweep (F6) clears shields on ownerless tabs. |
| Stacked duplicate shields after rapid nav | Low | Idempotent guard `getElementById` (#2). |
| Screenshot includes blue border | Medium (visual) | Hide/restore around `captureVisibleTab` (F5). |
| Shield blocks agent's own clicks | Very Low | Synthetic events bypass hit-testing by construction (`handleClick:747-758`, `handleType:812-818`); verified by reading, not by new code. |
| Protected page (`chrome://`) throws on inject | Low | `try{}catch{}` swallow (mirrors `showOverlay:279`). |
