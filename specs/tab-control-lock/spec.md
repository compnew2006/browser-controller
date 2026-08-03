# Spec — Tab Control-Lock Shield (blue inner frame + input block)

## Header (LOCKED)

**Stack (detected from root markers, do not re-detect):**
- TypeScript strict (`mcp-server/tsconfig.json`) — MCP server / daemon only. **No TS changes required by this feature.**
- Chrome Extension Manifest V3, **plain JS** (`extension/`) — service worker `extension/background.js`, content script `extension/content.js`.
- Vitest (`vitest.config.ts`, includes `tests/**/*.test.ts`).

**Real commands (verbatim):**
- `npm run build` → `tsc -p mcp-server/tsconfig.json`
- `npm test` → `vitest run`
- `npm run typecheck` → `tsc -p mcp-server/tsconfig.json --noEmit`

**MCP tiering note (this session):**
- **graphify** — LIVE (primary structural tool; `graphify-out/graph.json` EXISTS from Phase 0 — used as-is, not rebuilt). Confirmed via `graphify affected` runs below.
- serena / codebase-memory-mcp / socraticode — availability UNKNOWN this session. **Fallback used:** native `Read` / `Grep` / `Bash` against `extension/background.js`, `extension/lib/tab-concurrency.js`, `extension/content.js`, `extension/manifest.json`. Every load-bearing symbol below was READ in source this session (paths + line numbers cited).

**Scope:** ENTIRELY in the extension (`extension/background.js`, possibly a small new pure helper under `extension/lib/`). No daemon / MCP / TS changes unless a test demands it. No manifest permission adds. No version bump.

---

## Requirement

> Arabic original: "اريد إضافة عدم إمكانية التحكم في التبويب الذي يتحكم فيه الاسكربت وإحاطة شاشته باللون الازق كطيف داخلي للتبويب في الصفحة المفتوحة"
>
> English: "I want to prevent the user from controlling the tab that the script is controlling, and surround its screen with a blue color as an inner frame/border for the tab in the open page."

When an agent holds the lock on a tab, the human user must NOT be able to drive that tab with the mouse/keyboard, AND the page must show a visible blue inner border (frame) signaling "agent-controlled." When the lock is released, the block + border disappear and the user regains full control.

---

## LOCKED design decisions (decided by the user via the Orchestrator — baked in, not re-litigated)

1. **Trigger lifecycle = tab-lock lifecycle.** The shield (block + blue frame) becomes active when an agent locks the tab — `browser_tabs { action: "lock" }` via `handleTabs` (`extension/background.js:1275-1284`) OR the popup `lockTab` message (`extension/background.js:1754-1767`) — and is removed on every lock-release path: `unlock` (`handleTabs` case `'unlock'`, `:1285-1291`), popup `unlockTab` (`:1768-1779`), popup `unlockAll` (`:1748-1753`), `releaseSession` control message → `tabLocks.releaseByOwner(owner)` (`:359-371`), and `chrome.tabs.onRemoved` → `tabLocks.release(tabId)` (`:1799-1805`). It is **NOT** tied to per-action `showOverlay`/`hideOverlay` (`:428`, `:437`) — those remain a separate, transient activity indicator.
2. **Block strength = full block + transparent overlay.** A full-viewport transparent overlay that captures ALL real user input — `pointerdown`/`click`, `wheel`/`scroll`, `keydown`/`keyup`, `contextmenu`, `focus` — via `pointer-events:auto` + listeners that call `preventDefault()`/`stopPropagation()`, PLUS a blue inner border frame around the viewport edges. The page stays VISIBLE (transparent, not dimmed). The existing per-action corner badge (`__bc-overlay`, `showOverlay` `:256-280`) stays unchanged.

---

## The 6 critical correctness issues — chosen resolution

### 1. Navigation re-injection (full nav destroys the shield DOM)
**Problem:** A `chrome.scripting.executeScript` injection is destroyed when the tab does a full navigation (new document). The lock is still in `tabLocks`, but the shield is gone → user can interact again. SPA/hash navigations do NOT destroy the DOM (`isHashOnlyChange` in `extension/utils/navigation.js` returns true → no reload; `handleNavigate` `:615-700` skips the `onUpdated` wait in that case).

**Resolution — chosen approach (a): `chrome.tabs.onUpdated` listener re-injection.**
- Add a single `chrome.tabs.onUpdated` listener in `background.js`. When `changeInfo.status === 'complete'` AND `tabLocks.owner(tabId)` is set, call `showLockShield(tabId)` again (idempotent — see #2). This covers full navigations on a locked tab.
- Rationale vs. content.js: `executeScript` injection matches the existing `showOverlay`/`hideOverlay` pattern (same primitive, same `target:{tabId}`, same `catch {}` swallow for protected pages). Reusing `content.js` would require a message bus between the service worker and the content script for lock/unlock signals, and would still NOT cover the very first injection on a tab that loaded its document before the lock was taken (content scripts only auto-inject on `(status==='loading'|'complete', run_at document_start)`). The `onUpdated` approach is simpler, centrally controlled, and aligns with how `handleNavigate` already listens on `chrome.tabs.onUpdated` (`:646-663`).
- Coalesce with the existing listener pattern: do NOT add a second listener for the same purpose if it can be avoided; if a separate listener is cleaner (the existing `onUpdated` listener inside `handleNavigate` is per-call and short-lived), add a module-level persistent listener dedicated to shield re-injection.
- **Hash/SPA case:** `isHashOnlyChange` navigations do not reload, so `onUpdated` `complete` does not fire for them and the shield is already intact — no action needed. The listener only fires on real loads.

### 2. Idempotent injection (no stacked duplicates)
**Resolution:** Stable element id `__bc-lock-shield`. The injected function begins with `let el = document.getElementById('__bc-lock-shield'); if (el) { /* update label if needed, return */ return; }` — mirrors the existing `showOverlay` guard (`:261-274`). Re-injection after navigation is naturally safe because the new document has no such element; re-injection without navigation is a no-op.

### 3. Screenshot interaction (blue border would appear in `captureVisibleTab`)
**Problem:** `handleScreenshot` (`:1206-1220`) uses `chrome.tabs.captureVisibleTab(windowId, ...)`. The blue border overlays the viewport and would be captured → the agent sees a frame it cannot dismiss, hurting fidelity.

**Resolution — hide the shield momentarily during capture.**
- In `handleScreenshot`, BEFORE `captureVisibleTab`, call `hideLockShield(tabId)`; AFTER the capture resolves (success or failure), call `showLockShield(tabId)` to restore. Use `try/finally` so a capture error still restores the shield.
- Guard: only do the hide/restore if `tabLocks.owner(tabId)` is set (no-op otherwise — most screenshots are on unlocked tabs during normal agent flow).
- This keeps the agent's view equal to the real page (the human's blocked view still has the border at all other times).

### 4. z-index / shadow DOM / iframes
**Resolution:**
- `z-index: 2147483647` (same as existing overlay `:267`) — sits above page content.
- `position: fixed; inset: 0; pointer-events: auto;` for the input-capturing layer; the blue frame is a `box-shadow: inset 0 0 0 4px #2563eb` (or an absolutely-positioned border element) on the same layer so it does NOT shrink the layout.
- **Frames:** the existing `content.js` runs `all_frames: true` (`manifest.json:34`), but the shield is injected via `chrome.scripting.executeScript` with default `target:{tabId}` (top frame only). A top-frame shield does NOT cover same-origin or cross-origin iframes. **Documented limitation:** a determined user can click inside an iframe. This is acceptable for v1 (matches the requirement's "the open page" framing and avoids the complexity/perf cost of recursing into every frame on every injection). Filed as a follow-up, not a blocker.

### 5. Service-worker recycling (MV3 ~30s idle)
**Problem:** `tabLocks` is in-memory (`TabLockMap` in `extension/lib/tab-concurrency.js:57-139`, `this.locks = new Map()`). If the worker recycles, lock state is wiped TODAY (existing behavior — `consoleByTab`/`networkByTab`/`fallbackByTab` have the same limitation, documented at `background.js:10-13`, `:43-49`). The shield, however, lives in the PAGE and survives worker recycling — so a recycled worker could leave a shield visible on a tab whose lock state was wiped.

**Resolution — accept the existing limitation + best-effort cleanup on startup.**
- On `initConnection()` startup (`:111-123`), after reading storage, iterate `chrome.tabs.query({})` and for each tab whose `tabLocks.owner(tabId)` is unset, best-effort call `hideLockShield(tabId)` (swallow errors for protected/closed tabs). This clears stale shields left by a recycled worker.
- Rationale: a perfect fix would require persisting lock state to `chrome.storage.session` (write-heavy, and the rest of the codebase deliberately avoids it — see audit note at `:43-49`). Persisting locks is out of scope for this feature and would change existing behavior; the startup sweep is a cheap, bounded mitigation that addresses the visible symptom (stale shield) without re-architecting lock durability.

### 6. Removal robustness
**Resolution:** `hideLockShield(tabId)` uses `chrome.scripting.executeScript` with a `func` that does `document.getElementById('__bc-lock-shield')?.remove()` (mirrors `hideOverlay` `:282-289`). If the shield was never injected, `getElementById` returns null, `?.remove()` is a no-op, and the whole call is wrapped in `try {} catch {}` so protected/closed tabs do not throw. Removal is invoked on every release path listed in Decision 1.

---

## Out of scope

- Persisting `tabLocks` to `chrome.storage.session` or any durable store (existing in-memory behavior is preserved; see #5).
- Injecting the shield into same-origin or cross-origin iframes (#4 — documented limitation).
- Removing or merging the existing per-action `__bc-overlay` corner badge (`showOverlay`/`hideOverlay`). It stays as-is.
- Any MCP server / daemon / TypeScript change.
- Any new manifest permission or host permission. Any version bump (`manifest.json` and `package.json` stay at `2.0.0`).
- Bypassing the shield for the agent's own synthetic events — this is ALREADY true by construction (`handleClick` `:747-758` and `handleType` `:812-818` call `el.dispatchEvent(new MouseEvent/KeyboardEvent(...))` directly on the resolved element, which the browser delivers synthetically without hit-testing through the shield's `pointer-events:auto` layer). No change needed; this is the core safety invariant and it is verified by reading those handlers, not by new code.

---

## Success criteria (observable)

1. **Lock shows the shield.** After `browser_tabs { action:"lock", tabId }` (or popup `lockTab`), the target tab displays a blue inner border around the viewport AND real user pointer/keyboard input on the top frame is blocked (`preventDefault`/`stopPropagation` on the captured events).
2. **Agent still works.** While locked, the agent's `browser_click` / `browser_type` / `browser_press_key` / `browser_snapshot` / `browser_evaluate` succeed against the locked tab (synthetic events bypass the shield — verified by reading `handleClick:747-758`, `handleType:812-818`).
3. **Release removes the shield on EVERY release path:** `unlock`, popup `unlockTab`, popup `unlockAll`, `releaseSession` (agent disconnect), and `chrome.tabs.onRemoved` (tab closed). After any of these, the blue border is gone and the user can interact again.
4. **Navigation re-injection.** A full navigation on a locked tab (URL change → new document) results in the shield re-appearing once `changeInfo.status === 'complete'`. A hash-only / SPA navigation leaves the shield intact (no flicker, no duplicate).
5. **Idempotency.** Calling `showLockShield(tabId)` twice without a navigation in between produces exactly one shield element (no stacked overlays).
6. **Screenshot fidelity.** `browser_screenshot` on a locked tab returns an image WITHOUT the blue border (shield hidden during capture and restored after).
7. **Removal robustness.** `hideLockShield(tabId)` on a tab that never had the shield injected is a no-op (no throw).
8. **Startup sweep.** After a service-worker recycle + `initConnection`, tabs with no owner have no shield.
9. **Verification gate passes:** `npm run build`, `npm run typecheck`, `npm test` all green. Any new pure helper has a TS test mirroring `tests/tab-concurrency.test.ts`.
