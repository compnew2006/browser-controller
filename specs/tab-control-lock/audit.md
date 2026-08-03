# Audit — Tab Control-Lock Shield (Fix-Loop 2: keyboard/wheel/focus + leak)

Independent read-only re-audit of the Builder's fix-loop-2 change. No Builder
output was trusted; all source read and all commands run by the Auditor.

## MCP availability / fallbacks / confidence

- **graphify**: NOT re-run this session (single-file plain-JS change; native
  tools are decisive).
- **serena / codebase-memory-mcp / socraticode**: NOT AVAILABLE this session.
  Fallback: native `Read` / `Grep` (`grep -n`) / `Bash` against
  `extension/background.js`. Every load-bearing symbol read in source with line
  numbers (cited below).
- **Confidence: HIGH** for the 9 source checks, gate, and scope. Confidence
  **HIGH** for the new-defect check (synthetic-keyboard regression): the DOM
  event-propagation semantics invoked here are spec-defined and unambiguous —
  a capture-phase listener on `document` is on the propagation path of every
  event whose target is a descendant of `document`, and synthetic events
  dispatched with `el.dispatchEvent(...)` propagate through capture/target/
  bubble phases identically to user events (`isTrusted` does not affect routing,
  only `trusted-ness`).

## Baseline / diff establishment

- `git diff --check` → exit 0 (no whitespace/conflict markers).
- `git diff --stat HEAD -- extension/background.js` → `1 file changed,
  163 insertions(+), 6 deletions(-)`. Matches the Builder's claim (report
  line 173-176).
- `git diff --name-only HEAD` → 8 entries: `.gitignore`,
  `.zcode/plans/plan-sess_cb96dc0a-...md`, `SECURITY.md`,
  `extension/background.js`, `mcp-server/src/bridge.ts`,
  `mcp-server/src/daemon.ts`, `tests/bridge.test.ts`, `tests/daemon.test.ts`.
  The 7 non-`background.js` entries are the pre-existing auth-subprotocol
  feature being developed in parallel (documented as untouched in
  `implementation_report.md:9` and flagged by the task instructions). The
  feature's only file is `extension/background.js`. SCOPE PASS.

## Nine source checks (all read from `extension/background.js:311-382`)

1. **Mouse/pointer on `el` — PASS.** `:329-331`: loop over
   `['pointerdown','click','mousedown','mouseup','contextmenu']`,
   `el.addEventListener(type, block, { capture: true })`. Correct — the overlay
   is the hit-target so capture listeners on `el` fire.
2. **Keyboard/wheel/focus on `document` — PASS.** `:339-344`:
   `const docTypes = ['keydown','keyup','focus','wheel']` then
   `document.addEventListener(type, block, opts)` in a loop. Correct — `document`
   is an ancestor of everything in `<body>`, so capture listeners fire site-wide.
3. **`passive:false` for wheel/keydown/keyup — PASS.** `:341-343`:
   `opts = (type==='wheel'||type==='keydown'||type==='keyup') ? {capture:true,passive:false} : {capture:true}`.
   `focus` correctly does NOT set `passive:false` (it is not cancelable).
4. **Leak audit — add vs remove options IDENTICAL — PASS.**
   - Add (`:341-344`): `{capture:true,passive:false}` for wheel/keydown/keyup;
     `{capture:true}` for focus.
   - Remove (`:371-374`): identical ternary — `{capture:true,passive:false}`
     for wheel/keydown/keyup; `{capture:true}` for focus.
   `capture` is the only flag `removeEventListener` matches on; it matches
   exactly. Removal will succeed.
5. **Same handler reference — PASS.** `:350` stores `el.__bcShieldDocListeners =
   { fn: block, types: docTypes }` (the same `block` arrow closure passed to
   `addEventListener` at `:344`). `:368` reads `bound = el.__bcShieldDocListeners`;
   `:374` passes `bound.fn` to `removeEventListener`. Same reference → removal
   succeeds.
6. **Ordering: detach BEFORE `el.remove()` — PASS.** `:368-377` reads
   `el.__bcShieldDocListeners` and loops `removeEventListener`; `:378` calls
   `el.remove()` only after. The stash is read off `el` before removal (and even
   if removal ran first, the property survives on the detached node — but the
   code does the clean thing).
7. **No-op safety — PASS.** `:363-364`: `const el =
   document.getElementById('__bc-lock-shield'); if (!el) return;`.
   `:369`: `if (bound && typeof bound.fn === 'function' && Array.isArray(bound.types))`
   guards the detach loop, so a node with no stash skips it cleanly.
8. **Idempotent guard + no re-attach on re-call — PASS.** `:316-317`:
   `let el = document.getElementById('__bc-lock-shield'); if (el) return;`.
   The early `return` is BEFORE the `addEventListener` block (`:329-344`), so a
   re-call with the shield already present does NOT attach duplicate document
   listeners. Re-navigation re-injection (the only legitimate re-call path) is
   safe because the previous shield was destroyed by the full page load, so the
   `getElementById` lookup returns null.

All nine source checks PASS.

## Independent verification gate (run by the Auditor)

- `node --check extension/background.js` → `PARSE_OK`.
- `npm run build` (`tsc -p mcp-server/tsconfig.json`) → exit 0, no output.
- `npm run typecheck` (`tsc ... --noEmit`) → exit 0, no output. The rumored
  `pinnedExtensionOrigin` transient error did NOT reproduce; the symbol IS
  defined and used in `mcp-server/src/bridge.ts` (a file NOT touched by this
  feature), so even if it appeared it would not be a feature regression.
- `npm test` (`vitest run`) → exit 0. `Test Files 8 passed (8)`,
  `Tests 162 passed (162)`, 0 failures.
- `git diff --check` → exit 0.

Gate PASS.

## Scope check — PASS

`git diff --name-only HEAD` lists `extension/background.js` as the only feature
file. The other 7 modified entries (`.gitignore`, `.zcode/plans/*`, `SECURITY.md`,
`mcp-server/src/{bridge,daemon}.ts`, `tests/{bridge,daemon}.test.ts`) are the
pre-existing auth-subprotocol session-start changes, explicitly out-of-scope per
task instructions and the Builder report.

## New-defect check (synthetic keyboard events blocked) — **FAIL**

This is the single most important check, and it FAILS. The fix-loop-2 change
introduces a regression that breaks the agent's `browser_type` and
`browser_press_key` tools on any locked tab.

### Mechanism (DOM event-propagation spec)

- `handleType` (`:908-913`) dispatches, per character:
  `el.dispatchEvent(new KeyboardEvent('keydown', {key:ch, bubbles:true}))`,
  then an `input` event, then `keyup`. `el` is an `<input>`/`<textarea>`/
  contenteditable inside `<body>`.
- `handlePressKey` (`:1006-1008`) dispatches `keydown`, `keypress`, `keyup` on
  `target = document.activeElement || document.body` (or the resolved ref/selector
  element), again inside `<body>`.
- The fix attaches a capture-phase `document.addEventListener('keydown', block,
  {capture:true,passive:false})` (`:344`) and likewise for `keyup`.
- `block` calls `e.preventDefault()` + `e.stopImmediatePropagation()` (`:323-326`).

Per the DOM event model: when `el.dispatchEvent(ev)` is called, the event
propagates capture phase from `window` → `document` → ... → target, then bubble
phase back up. A capture-phase listener on `document` fires FIRST, before the
event ever reaches `el` or its own listeners. `stopImmediatePropagation()` halts
all further propagation (no target-phase listeners on `el` fire, no bubble);
`preventDefault()` cancels the default action. This applies to synthetic events
identically — `isTrusted` does not gate propagation or routing, only the value
of `Event.isTrusted`.

### Why the prior audit's "core safety invariant" claim no longer holds

The original audit/review (`review.md:36-40`, `audit.md:96-102`) and the spec's
"Out of scope #6" all reasoned that synthetic events "bypass hit-testing by
construction." That reasoning was correct ONLY for the mouse/pointer half
(because `pointer-events:auto` overlay blocks via hit-testing, and
`el.dispatchEvent` bypasses hit-testing). It was ALSO accidentally correct for
the keyboard half in fix-loop 1, because the keyboard listeners were bound to
`el` (a sibling of `<body>`) and therefore never fired for anything — they
blocked nothing, including the agent's events.

Fix-loop 2 fixed the efficacy bug by moving the keyboard listeners to `document`
in capture phase. That makes them fire for ALL keydown/keyup events whose target
is a descendant of `document` — which is exactly the agent's synthetic keydown/
keyup dispatched on `<body>`-descendant inputs. So the fix correctly blocks real
user typing AND incorrectly blocks the agent's synthetic typing.

### Concrete impact

On a locked tab, calling `browser_type` or `browser_press_key`:
- The capture-phase `document` `keydown` listener fires first and calls
  `stopImmediatePropagation()` → the targeted input's own `keydown` listeners
  (e.g. React `onKeyDown`, framework validators, autocomplete) never receive the
  event.
- `preventDefault()` cancels default key handling.
- `keyup` is likewise blocked.
- The `input`/`change` events (`:902`, `:911`, `:916`) still fire because they
  are NOT in the blocked type set, and `el.value += ch` (`:909`) still mutates
  the value directly — so for a plain `<input>` the character may still appear in
  `.value`. BUT any framework driven by `keydown`/`keyup` (React controlled
  inputs, Vue, Svelte, masked inputs, hotkeys, character-composition, IME,
  maxlength enforcement on keydown, etc.) will malfunction. The agent's typing
  becomes unreliable on exactly the kind of real-world apps this tool targets.

### Why `handleScreenshot` is unaffected (and proves the regression pattern)

`handleScreenshot` (`:1311-1328`) explicitly hides the shield
(`await hideLockShield(tabId)`) before capturing and re-shows it in a `finally`.
The screenshot tool's author KNEW the shield interferes with the agent's view
and transiently dismisses it. `handleType`/`handlePressKey` do NOT do this
(verified: `:875-931` and `:981-1012` contain no `hideLockShield`/`showLockShield`
calls), so the shield — and now its document-level keyboard capture listener —
is live during the agent's typing dispatch. The asymmetry is direct evidence the
fix-loop-2 change broke a previously-working tool path.

### This is a hard reject

The task instructions state: "If the new-defect check (synthetic keyboard events
blocked) FAILS, that is a hard reject." It fails. REJECT.

## Smallest targeted fix (recommended, cleanest)

Two viable options; recommend Option A.

**Option A (cleanest, smallest, spec-aligned) — make `block` skip untrusted
events.** In the injected `showLockShield` `func`, change the handler to:
```js
const block = (e) => {
  if (e.isTrusted === false) return;   // allow the agent's synthetic events
  e.preventDefault();
  e.stopImmediatePropagation();
};
```
This is a one-line guard. Real user input has `isTrusted === true`; the agent's
`el.dispatchEvent(new KeyboardEvent(...))` always has `isTrusted === false`
(the DOM spec forbids script from creating `isTrusted:true` events). This
precisely restores the spec's stated invariant ("synthetic events bypass ...
by construction") for keyboard/scroll/focus, while preserving the fix-loop-2
efficacy for real user input. It also covers `wheel` (agent does not synthesize
wheel) and `focus` defensively. Apply identically in BOTH the mouse/pointer
group (defense in depth — though `handleClick`'s synthetic `MouseEvent` on `el`
is already not on `el`'s capture path because `el` is not the target of synthetic
clicks; still harmless and consistent) and the keyboard/wheel/focus group.

Caveat to record: `isTrusted` does not exist on events in some ancient engines,
but Chrome (the only target — `extension/manifest.json` is Chrome MV3) has
supported it since forever, so this is safe.

**Option B — mirror `handleScreenshot`: hide the shield in `handleType`/
`handlePressKey` around the dispatch.** More invasive (4 new lines per tool,
must wrap in try/finally like screenshot), and it momentarily un-blocks the
tab during typing (a real user could sneak a real keypress in the window).
Option A is strictly better: it never drops the shield, never widens the
race window, and is one line.

Recommend **Option A**.

## Verification commands (Auditor-run), exit codes, tails

| Command | Exit | Tail |
|---|---|---|
| `node --check extension/background.js` | 0 | `PARSE_OK` |
| `npm run build` | 0 | (no output) |
| `npm run typecheck` | 0 | (no output) |
| `npm test` | 0 | `Test Files 8 passed (8) / Tests 162 passed (162)` |
| `git diff --check` | 0 | (clean) |

All gates green, but the green gate does NOT cover the regression (no automated
Chrome/DOM harness exists for the extension — `implementation_report.md:80`,
`audit.md:155-162`). The defect is only visible by reading the dispatch path
against the listener attachment, which is exactly what this audit did.

---

## VERDICT: REJECT

Reason: the fix-loop-2 change (moving keyboard/wheel/focus listeners to
`document` in capture phase with `stopImmediatePropagation`) correctly fixes
the efficacy gap but introduces a NEW regression — it blocks the agent's OWN
synthetic `keydown`/`keyup` events dispatched by `handleType` (`:910,912`) and
`handlePressKey` (`:1006,1008`) on locked tabs, breaking those tools on any
framework that reacts to key events. The leak audit, source checks, scope,
and gate all PASS; the new-defect check FAILS (hard reject per task rules).

Smallest fix: add `if (e.isTrusted === false) return;` as the first line of the
`block` handler (`extension/background.js:323-326`). This restores the agent's
synthetic-event bypass for keyboard/wheel/focus while preserving real-user-input
blocking. Do not ship without this guard.
