/**
 * Trusted input over CDP (Input.dispatchMouseEvent / Input.dispatchKeyEvent).
 *
 * Synthetic DOM events (el.dispatchEvent) are isTrusted:false, never move real
 * focus, never run default actions (Tab focus traversal, Enter form submit,
 * autocomplete menus) and never fire focus/blur while the window is in the
 * background. Legacy grids and lookup widgets depend on all of that, so the
 * write tools now drive the page the way a user does, like Claude in Chrome.
 * There is no synthetic fallback: when the debugger cannot attach, input fails
 * with DEBUGGER_UNAVAILABLE (requireSender).
 */
import { ensureCdp, ensureViewport, hasCdp, getOpenDialog, subscribeCdpEvents } from './cdp-session.js';
import { safeExec, execDom, getFallback, wedgedError } from './page-exec.js';
import { wedgedTabs } from './state.js';
import { agentCursorEnabled } from './overlay.js';
import { parseTarget } from './target.js';
import { refErrorMessage } from './ref-errors.js';

const MOD_BITS = { alt: 1, ctrl: 2, meta: 4, shift: 8 };

export function modifierBits(mods = []) {
  return mods.reduce((bits, m) => bits | (MOD_BITS[m] || 0), 0);
}

const NAMED_KEYS = {
  Enter: { code: 'Enter', vk: 13, text: '\r' },
  Tab: { code: 'Tab', vk: 9 },
  Escape: { code: 'Escape', vk: 27 },
  Backspace: { code: 'Backspace', vk: 8 },
  Delete: { code: 'Delete', vk: 46 },
  Insert: { code: 'Insert', vk: 45 },
  ArrowUp: { code: 'ArrowUp', vk: 38 },
  ArrowDown: { code: 'ArrowDown', vk: 40 },
  ArrowLeft: { code: 'ArrowLeft', vk: 37 },
  ArrowRight: { code: 'ArrowRight', vk: 39 },
  Home: { code: 'Home', vk: 36 },
  End: { code: 'End', vk: 35 },
  PageUp: { code: 'PageUp', vk: 33 },
  PageDown: { code: 'PageDown', vk: 34 },
  ' ': { code: 'Space', vk: 32, text: ' ' },
  Space: { code: 'Space', vk: 32, text: ' ', key: ' ' },
  Shift: { code: 'ShiftLeft', vk: 16 },
  Control: { code: 'ControlLeft', vk: 17 },
  Alt: { code: 'AltLeft', vk: 18 },
  Meta: { code: 'MetaLeft', vk: 91 },
  CapsLock: { code: 'CapsLock', vk: 20 },
  NumLock: { code: 'NumLock', vk: 144 },
  ScrollLock: { code: 'ScrollLock', vk: 145 },
  PrintScreen: { code: 'PrintScreen', vk: 44 },
  Pause: { code: 'Pause', vk: 19 },
  ContextMenu: { code: 'ContextMenu', vk: 93 },
};
for (let i = 1; i <= 12; i++) NAMED_KEYS[`F${i}`] = { code: `F${i}`, vk: 111 + i };
// US-layout code + Windows virtual key code for printable punctuation.
const PUNCTUATION = {
  '.': ['Period', 190], '>': ['Period', 190], ',': ['Comma', 188], '<': ['Comma', 188],
  '-': ['Minus', 189], '_': ['Minus', 189], '=': ['Equal', 187], '+': ['Equal', 187],
  '/': ['Slash', 191], '?': ['Slash', 191], ';': ['Semicolon', 186], ':': ['Semicolon', 186],
  "'": ['Quote', 222], '"': ['Quote', 222], '[': ['BracketLeft', 219], '{': ['BracketLeft', 219],
  ']': ['BracketRight', 221], '}': ['BracketRight', 221], '\\': ['Backslash', 220], '|': ['Backslash', 220],
  '`': ['Backquote', 192], '~': ['Backquote', 192],
  '!': ['Digit1', 49], '@': ['Digit2', 50], '#': ['Digit3', 51], '$': ['Digit4', 52], '%': ['Digit5', 53],
  '^': ['Digit6', 54], '&': ['Digit7', 55], '*': ['Digit8', 56], '(': ['Digit9', 57], ')': ['Digit0', 48],
};
const KEY_ALIASES = { Esc: 'Escape', Return: 'Enter', Del: 'Delete', Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight' };

/** CDP key definition for a key name ("Enter", "a", "7", "ب"). */
export function keyDefinition(rawKey) {
  const name = KEY_ALIASES[rawKey] || rawKey;
  const named = NAMED_KEYS[name];
  if (named) return { key: named.key || name, code: named.code, vk: named.vk, text: named.text };
  if ([...name].length !== 1) throw new Error(`Unknown key "${rawKey}"`);
  const ch = name;
  const upper = ch.toUpperCase();
  if (/^[a-z]$/i.test(ch)) return { key: ch, code: `Key${upper}`, vk: upper.charCodeAt(0), text: ch };
  if (/^[0-9]$/.test(ch)) return { key: ch, code: `Digit${ch}`, vk: ch.charCodeAt(0), text: ch };
  // Numeric/mask plugins filter on keyCode: a "." with keyCode 0 is dropped.
  const punct = PUNCTUATION[ch];
  if (punct) return { key: ch, code: punct[0], vk: punct[1], text: ch };
  return { key: ch, code: '', vk: 0, text: ch };
}

/**
 * Control+a / Meta+a (no alt, no shift): select all in the focused field. macOS Chrome
 * binds Control+a to "line start" and reads select-all from the key event's `commands`
 * (the editing command Chrome itself sends for Cmd+A), so the command goes out with the
 * key on every OS.
 */
function selectAllCombo(key, modifiers) {
  const ctrlOrMeta = modifiers & (MOD_BITS.ctrl | MOD_BITS.meta);
  return /^a$/i.test(key) && ctrlOrMeta !== 0 && !(modifiers & (MOD_BITS.alt | MOD_BITS.shift));
}

/** One full key press (keyDown[+char] / keyUp). With ctrl/alt/meta no text is produced. */
export async function cdpKeyPress(send, rawKey, mods = []) {
  const def = keyDefinition(rawKey);
  const modifiers = modifierBits(mods);
  const printable = def.text && !(modifiers & (MOD_BITS.ctrl | MOD_BITS.alt | MOD_BITS.meta));
  const base = { key: def.key, code: def.code, windowsVirtualKeyCode: def.vk, nativeVirtualKeyCode: def.vk, modifiers };
  await send('Input.dispatchKeyEvent', {
    type: printable ? 'keyDown' : 'rawKeyDown',
    ...base,
    ...(printable ? { text: def.text, unmodifiedText: def.text } : {}),
    ...(selectAllCombo(def.key, modifiers) ? { commands: ['selectAll'] } : {}),
  });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

export async function cdpClickAt(send, x, y, { button = 'left', clickCount = 1, modifiers = 0 } = {}) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers });
  for (let n = 1; n <= clickCount; n++) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: n, modifiers });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: n, modifiers });
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Page-side: resolve `target` (the parsed lib/target.js object) through the shared DOM
 * runtime (D.resolveTarget), scroll it into view, optionally focus/select it, and
 * return its centre in TOP-level viewport coordinates (what CDP expects).
 * A point `target` is returned as it is: no scroll, no focus, no element checks.
 * Also opens the agent's input window (__bcAgentInputUntil, lib/overlay.js) for
 * a few seconds, so the user-input block lets its trusted events through. With
 * `cursor` ({ effect, count }) the agent cursor glides to that centre (`cursorMs`).
 * Kept self-contained: it is serialized into the page by chrome.scripting.
 */
function pageLocate(fb, mode, cursor, check, target) {
  // `fb` is the snapshot's fallback descriptor of a ref target (lib/state.js fallbacks).
  const D = globalThis.__bcDom;
  // An older runtime (installed before an extension update) has no cursor, clickTarget or resolveTarget.
  if (!D || !D.clickTarget || (cursor && !D.cursor) || (target && !D.resolveTarget)) return { __needDom: true };
  let el = null;
  let via = 'ref';
  let viewPoint = null;
  if (target) {
    const r = D.resolveTarget(target, fb);
    if (r.error) return { success: false, error: r.error, url: location.href, ...(r.issued !== undefined ? { issued: r.issued } : {}), ...(r.earlier ? { earlier: true } : {}) };
    el = r.el || null;
    via = r.via;
    viewPoint = r.point || null;
  }
  if (!el && !viewPoint && (mode === 'active' || mode === 'focused' || mode === 'focused-clear')) {
    el = document.activeElement || document.body;
    // Descend into focused shadow roots / same-origin frames.
    for (let i = 0; el && i < 10; i++) {
      const s = D.shadowOf(el);
      if (s && s.activeElement) { el = s.activeElement; continue; }
      const d = D.frameDoc(el);
      if (d && d.activeElement) { el = d.activeElement; continue; }
      break;
    }
    via = 'active';
    // Typing without a target needs a real field (text-like input, textarea, contenteditable),
    // not a button, a select or the page body. Keys without text need no field.
    const typable = !!el && (el.isContentEditable || el.tagName === 'TEXTAREA'
      || (el.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'image', 'range', 'color', 'hidden'].includes(el.type)));
    if (mode !== 'active' && !typable) {
      return { success: false, error: 'NO_FOCUS' };
    }
  }
  if (!el && !viewPoint) return { success: false, error: 'REF_GONE', url: location.href };

  // The agent's trusted input passes the user-input block (see overlay.js).
  window.__bcAgentInputUntil = Date.now() + 8000;

  if (viewPoint) {
    // A point is aimed at as it is: no scroll, no focus, no element checks. `visible`
    // here means the point is inside the viewport.
    const inView = viewPoint.x >= 0 && viewPoint.y >= 0 && viewPoint.x <= window.innerWidth && viewPoint.y <= window.innerHeight;
    const cursorMs = cursor && inView && D.cursor ? D.cursor(viewPoint.x, viewPoint.y, cursor.effect, cursor.count) : 0;
    return {
      success: true,
      x: viewPoint.x, y: viewPoint.y,
      zeroViewport: window.innerWidth === 0 || window.innerHeight === 0,
      visible: inView,
      focused: false,
      needsSelectAll: false,
      hasText: false,
      ...(cursorMs ? { cursorMs } : {}),
      via: 'point',
    };
  }

  if (via !== 'active') el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
  if (mode === 'focus' || mode === 'clear' || mode === 'focused-clear') {
    if (typeof el.focus === 'function') el.focus();
    if (mode === 'clear' || mode === 'focused-clear') {
      if (el.isContentEditable) {
        const r = el.ownerDocument.createRange();
        r.selectNodeContents(el);
        const s = el.ownerDocument.defaultView.getSelection();
        s.removeAllRanges();
        s.addRange(r);
      } else if (typeof el.select === 'function') {
        el.select();
      }
    }
  }

  const { x, y, rect } = D.centerOf(el);
  // The field the caller aimed at (read back by pageRelease, see below).
  window.__bcLocatedEl = el;
  let focusedEl = el.ownerDocument.activeElement;
  for (let i = 0; focusedEl && i < 10; i++) {
    const s = D.shadowOf(focusedEl);
    if (s && s.activeElement) focusedEl = s.activeElement; else break;
  }
  const focused = focusedEl === el || D.composedContains(el, focusedEl);
  const hasValue = 'value' in el && !el.isContentEditable && typeof el.value === 'string';
  let fullySelected = false;
  try { fullySelected = el.selectionStart === 0 && el.selectionEnd === el.value.length; } catch { /* number/email inputs */ }
  // A click must reach its target: hidden, disabled or covered (lib/page-dom.js
  // clickTarget) is a failure, measured before anything is clicked. A checkbox
  // hidden under its visible <label> is clicked through that label instead.
  let point = { x, y };
  let box = rect;
  let reportVia = via;
  let onLabel = false;
  if (check === 'click') {
    const aim = D.clickTarget(el);
    if (aim.message) return { success: false, error: aim.message, x, y };
    if (aim.via) {
      point = { x: aim.x, y: aim.y };
      box = aim.node.getBoundingClientRect();
      reportVia = aim.via;
      onLabel = aim.via === 'label';
    }
  }
  // Agent cursor (lib/page-dom.js): glide to the point the real input will hit.
  const cursorMs = cursor && box.width > 0 && box.height > 0 && D.cursor ? D.cursor(point.x, point.y, cursor.effect, cursor.count) : 0;
  return {
    success: true,
    x: point.x, y: point.y,
    zeroViewport: window.innerWidth === 0 || window.innerHeight === 0,
    visible: box.width > 0 && box.height > 0,
    focused,
    // clear: a value that select() could not select still needs Ctrl+A.
    needsSelectAll: hasValue && el.value.length > 0 && !fullySelected,
    hasText: hasValue ? el.value.length > 0 : (el.textContent || '').length > 0,
    ...(cursorMs ? { cursorMs } : {}),
    ...(reportVia !== 'ref' ? { via: reportVia } : {}),
    ...(onLabel ? { onLabel: true } : {}),
    // A fallback re-resolution says what it actually hit, so a wrong guess is visible.
    ...(via === 'fallback' ? { target: { role: D.roleOf(el), name: D.nameOf(el).slice(0, 60) } } : {}),
  };
}

/** Close the agent's input window; report the focused field's value for verification. */
function pageRelease() {
  window.__bcAgentInputUntil = 0;
  let a = document.activeElement;
  for (let i = 0; a && i < 10; i++) {
    if (a.shadowRoot && a.shadowRoot.activeElement) { a = a.shadowRoot.activeElement; continue; }
    if (a.tagName !== 'IFRAME') break;
    try { a = a.contentDocument.activeElement; } catch { break; }
  }
  const focusedTag = a && a !== document.body ? a.tagName.toLowerCase() + (a.id ? `#${a.id}` : '') : undefined;
  // The value is the field the caller aimed at: a Tab typed into it moves focus elsewhere.
  const located = window.__bcLocatedEl || null;
  window.__bcLocatedEl = null;
  const target = located && located.isConnected !== false ? located : (focusedTag ? a : null);
  if (!target) return { value: null };
  const value = typeof target.value === 'string' ? target.value : target.isContentEditable ? target.textContent : null;
  // A password is reported as masked by the caller; its value never leaves the page.
  return { value: value == null ? null : value.slice(0, 100), secret: target.type === 'password', ...(focusedTag ? { focusedTag } : {}) };
}

/**
 * Page-side: what is at a top-level viewport point (pierces shadow roots and
 * same-origin frames), open the agent's input window, and glide the agent
 * cursor there.
 */
function pagePointInfo(x, y, effect, count) {
  const D = globalThis.__bcDom;
  if (!D || (effect && !D.cursor)) return { __needDom: true };
  window.__bcAgentInputUntil = Date.now() + 8000;
  const inView = x >= 0 && y >= 0 && x <= window.innerWidth && y <= window.innerHeight;
  const cursorMs = effect && D.cursor ? D.cursor(x, y, effect, count) : 0;
  const el = D.elementAt(x, y);
  if (!el) return { inView, cursorMs };
  // Report the control that owns the point (e.g. the <button> around an <svg>).
  let owner = el;
  for (let cur = el, i = 0; cur && i < 6; i++) {
    if (D.isInteractive(cur)) { owner = cur; break; }
    let r = null;
    try { r = cur.getRootNode(); } catch {}
    cur = cur.parentElement || (r && r.host) || null;
  }
  const name = D.nameOf(owner).slice(0, 60);
  return { inView, cursorMs, hit: { role: D.roleOf(owner), ...(name ? { name } : {}), tag: owner.tagName.toLowerCase() } };
}

/**
 * Describe the element at (x, y), let trusted input through the shield, and —
 * when the agent cursor is switched on — glide it there (`effect`: 'move' |
 * 'click', see lib/page-dom.js), resolving once it has arrived so the real
 * input lands under it.
 */
export async function pointInfo(tabId, x, y, effect = 'move', count = 1) {
  const cursor = (await agentCursorEnabled()) ? effect : null;
  let info = {};
  try { info = (await execDom(tabId, pagePointInfo, [x, y, cursor, count])) || {}; } catch { /* protected page: input still works */ }
  if (info.cursorMs > 0) await sleep(info.cursorMs);
  return info;
}

/**
 * What a `target` string aims at: the parsed locator and, for a ref, its snapshot
 * fallback (the descriptor the page re-finds a re-rendered element with). Throws
 * INVALID_ARGUMENT for a blank target.
 */
export function targetAim(tabId, target) {
  const parsed = parseTarget(target);
  return { parsed, fb: parsed.kind === 'ref' ? getFallback(tabId, parsed.ref) : null };
}

/**
 * A ref miss on the target path is worded here. The page says whether the ref was
 * ever issued (`issued`); without that, the extension's own record decides
 * (fallbackByTab). Either way it goes through refErrorMessage, as every ref tool does.
 */
export function wordTargetRefMiss(tabId, parsed, loc) {
  if (!parsed || parsed.kind !== 'ref' || loc?.error !== 'REF_GONE') return loc;
  const known = loc.issued !== undefined ? loc.issued : getFallback(tabId, parsed.ref);
  return { ...loc, error: refErrorMessage(parsed.ref, known, !!loc.earlier) };
}

/**
 * Locate the element (or point) a tool acts on: `target` is the one locator string
 * (contract principle 2). Without one, `mode` decides (the active or focused element).
 * Throws INVALID_ARGUMENT for a blank target.
 */
export async function locateTarget(tabId, { target, mode = 'none', cursor = null, check = null }) {
  const parsed = target == null ? null : parseTarget(target);
  // A ref on the target path keeps its snapshot fallback (the re-render re-find the ref path always had).
  const aimFb = parsed?.kind === 'ref' ? getFallback(tabId, parsed.ref) : null;
  const run = (cur) => execDom(tabId, pageLocate, [aimFb, mode, cur, check, parsed]);
  let loc = await run(cursor);
  // Never-shown background tab: size its viewport, then measure again.
  if (loc?.success && loc.zeroViewport && hasCdp(tabId)) {
    const first = loc;
    await ensureViewport(tabId).catch(() => {});
    // The cursor's effect already played: just move it to the real point.
    loc = await run(cursor && { effect: 'track' });
    if (first.via === 'fallback' && loc?.success) loc = { ...loc, via: 'fallback' };
  }
  return wordTargetRefMiss(tabId, parsed, loc);
}

/**
 * locateTarget for mouse input. With the agent cursor switched on, it glides
 * to the target first (`effect`: 'move' | 'click'); the glide takes time, so
 * the target is measured again once the cursor has arrived: a layout shift
 * during the animation must not make the click miss.
 */
export async function locatePointer(tabId, target, effect, count = 1) {
  // A click is only sent to a target that can take it (hidden/disabled/covered: fails).
  const aim = effect === 'click' ? { ...target, check: 'click' } : target;
  if (!(await agentCursorEnabled())) return locateTarget(tabId, aim);
  const loc = await locateTarget(tabId, { ...aim, cursor: { effect, count } });
  if (!loc?.success || !(loc.cursorMs > 0)) return loc;
  await sleep(loc.cursorMs);
  const again = await locateTarget(tabId, { ...aim, cursor: { effect: 'track' } });
  // The answer is the measurement after the glide, never the first one: a target that
  // vanished or became blocked during the glide is reported, not clicked where it was.
  if (!again?.success) { await releaseShield(tabId); return again; }
  // The first measurement re-found a stale ref; the second one reads the re-bound registry entry.
  return loc.via === 'fallback' ? { ...again, via: 'fallback' } : again;
}

/**
 * The tab's CDP session. Browser input never falls back to synthetic events:
 * when the debugger cannot attach this throws DEBUGGER_UNAVAILABLE.
 */
export async function requireSender(tabId) {
  try {
    return await ensureCdp(tabId);
  } catch (err) {
    throw new Error(`DEBUGGER_UNAVAILABLE: could not attach the debugger to tab ${tabId} (${String(err?.message || err)}). Browser input needs it.`, { cause: err });
  }
}

/** A page-controlled text cut to `max` characters for a result line ("…" marks the cut). */
export function clipText(text, max = 200) {
  const chars = [...String(text ?? '')];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
}

/** `confirm "Delete this item?"`: the dialog as a result line names it (type, clipped message). */
export function dialogSummary(dialog) {
  return `${dialog.type ?? 'dialog'} "${clipText(dialog.message ?? '')}"`;
}

/** How long one input dispatch may take before the tab counts as unresponsive. */
export const INPUT_BUDGET_MS = 5_000;

const cancelledError = () => new Error('TIMEOUT: the call ran out of time, so the input was stopped before it was sent; nothing more was pressed or typed.');

/** A release (mouse up, key up) completes a press that already went out: it is sent even when the call is cancelled. */
const isRelease = (method, params) => (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseReleased')
  || (method === 'Input.dispatchKeyEvent' && params?.type === 'keyUp');

/**
 * Refuse an input before anything is sent: a JS dialog is open on the tab (the page
 * takes no input until it is answered), or the call was already cancelled.
 */
export function assertInputReady(tabId, signal) {
  const open = getOpenDialog(tabId);
  if (open) throw new Error(`DIALOG_OPEN: a ${dialogSummary(open)} is open on tab ${tabId}; answer it with browser_handle_dialog first.`);
  if (signal?.aborted) throw cancelledError();
}

/**
 * The CDP send for one input call. Two things a bare `await send(...)` gets wrong:
 *  - A JS dialog that an input opens (confirm() in a click handler) blocks the page, so the
 *    renderer never acks the dispatch that opened it. Each dispatch therefore races the tab's
 *    Page.javascriptDialogOpening event: once a dialog is open the dispatch in flight is
 *    abandoned (its late ack or rejection is swallowed), no later dispatch is sent, and
 *    `blocked` holds the dialog.
 *  - A renderer that never acks at all: after INPUT_BUDGET_MS the tab is marked wedged
 *    (wedgedTabs, as safeExec does) and the call fails with the wedged-tab text.
 * A cancelled call (`signal`, the bridge timed it out) starts no new dispatch; a release
 * still goes out, so no button or key is left down. `send(method, params)` resolves true
 * when the dispatch was sent and false when a dialog already blocks the page. close() ends
 * the dialog watch: call it when the input is over.
 */
export function inputSession(tabId, send, signal) {
  assertInputReady(tabId, signal);
  let blocked = null;
  let wake;
  const opened = new Promise((resolve) => { wake = resolve; });
  const off = subscribeCdpEvents(tabId, (method) => {
    if (method !== 'Page.javascriptDialogOpening' || blocked) return;
    blocked = getOpenDialog(tabId) ?? { type: 'dialog', message: '' };
    wake();
  });
  return {
    get blocked() { return blocked; },
    /** The bare sender, for calls that are not input dispatches (file upload, the value probe). */
    raw: send,
    async send(method, params = {}) {
      if (blocked) return false;
      if (signal?.aborted && !isRelease(method, params)) throw cancelledError();
      const dispatch = send(method, params);
      dispatch.catch(() => {}); // a late ack or rejection after the dialog or the budget is swallowed
      let timer;
      const outcome = await Promise.race([
        dispatch.then(() => 'acked'),
        opened.then(() => 'dialog'),
        new Promise((resolve) => { timer = setTimeout(() => resolve('stalled'), INPUT_BUDGET_MS); }),
      ]).finally(() => clearTimeout(timer));
      if (outcome === 'stalled') {
        wedgedTabs.set(tabId, Date.now());
        throw wedgedError(tabId, INPUT_BUDGET_MS);
      }
      return true;
    },
    close() { off(); },
  };
}

/**
 * Focus a target the way a person does: a trusted click on it, unless it already
 * has focus. A failed check (hidden, disabled, covered) comes back with nothing clicked.
 */
export async function focusByClick(tabId, input, target) {
  const loc = await locateTarget(tabId, { target, check: 'click' });
  if (!loc.success || loc.focused || input.blocked) return loc;
  await sleep(await cursorTo(tabId, loc.x, loc.y, 'click'));
  await cdpClickAt(input.send, loc.x, loc.y);
  return loc;
}

/** Page-side: where a target is now. No scroll, no focus, no actionability check. */
function pageMeasure(t, fb) {
  const D = globalThis.__bcDom;
  if (!D || !D.resolveTarget) return { __needDom: true };
  const r = D.resolveTarget(t, fb);
  if (r.error) return { error: r.error };
  const p = r.point ? { x: r.point.x, y: r.point.y } : D.centerOf(r.el);
  return { x: p.x, y: p.y, inView: p.x >= 0 && p.y >= 0 && p.x <= window.innerWidth && p.y <= window.innerHeight };
}

/**
 * Where a target's centre is right now, as measured by the page, and whether that
 * point is inside the viewport. Measures only: use it after the last scroll.
 */
export async function measureTarget(tabId, target) {
  const { parsed, fb } = targetAim(tabId, target);
  const m = await execDom(tabId, pageMeasure, [parsed, fb]);
  return wordTargetRefMiss(tabId, parsed, m);
}

/** Page-side: select everything in the field that has focus (a DOM selection, no key events). */
function pageSelectFocused() {
  let a = document.activeElement;
  for (let i = 0; a && i < 10; i++) {
    if (a.shadowRoot && a.shadowRoot.activeElement) { a = a.shadowRoot.activeElement; continue; }
    if (a.tagName !== 'IFRAME') break;
    try { a = a.contentDocument.activeElement; } catch { break; }
  }
  if (!a || a === document.body || a === document.documentElement) return {};
  if (a.isContentEditable) {
    const r = a.ownerDocument.createRange();
    r.selectNodeContents(a);
    const s = a.ownerDocument.defaultView.getSelection();
    s.removeAllRanges();
    s.addRange(r);
  } else if (typeof a.select === 'function') {
    a.select();
  }
  return {};
}

/** First step of clear: select the focused field's whole contents, so the next insert or Backspace replaces them. */
export async function selectFocused(tabId) {
  await safeExec(tabId, pageSelectFocused, []);
}

function pageCursor(x, y, effect, count) {
  const D = globalThis.__bcDom;
  if (!D || !D.cursor) return { __needDom: true };
  return { ms: D.cursor ? D.cursor(x, y, effect, count) : 0 };
}

/**
 * Glide the agent cursor to (x, y) without waiting; returns the glide's
 * duration in ms (0: nothing to wait for, or the cursor is switched off).
 * Cosmetic, never throws.
 */
export async function cursorTo(tabId, x, y, effect = 'move', count = 1) {
  if (!(await agentCursorEnabled())) return 0;
  try { return (await execDom(tabId, pageCursor, [x, y, effect, count]))?.ms || 0; } catch { return 0; }
}


export async function releaseShield(tabId) {
  try { return (await safeExec(tabId, pageRelease, [])) || {}; } catch { return {}; /* page navigated away */ }
}
