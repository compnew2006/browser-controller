/**
 * Trusted input over CDP (Input.dispatchMouseEvent / Input.dispatchKeyEvent).
 *
 * Synthetic DOM events (el.dispatchEvent) are isTrusted:false, never move real
 * focus, never run default actions (Tab focus traversal, Enter form submit,
 * autocomplete menus) and never fire focus/blur while the window is in the
 * background. Legacy grids and lookup widgets depend on all of that, so the
 * write tools now drive the page the way a user does, like Claude in Chrome.
 * The synthetic path stays as the fallback when CDP can't attach.
 */
import { ensureCdp, ensureViewport, hasCdp } from './cdp-session.js';
import { safeExec, execDom } from './page-exec.js';
import { agentCursorEnabled } from './overlay.js';

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
  });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

/** Up to this length text is typed key by key (keydown/keypress/input/keyup per char). */
export const PER_KEY_MAX = 300;

export async function cdpTypeText(send, text) {
  if ([...text].length > PER_KEY_MAX) {
    await send('Input.insertText', { text });
    return;
  }
  for (const ch of text) {
    if (ch === '\n') { await cdpKeyPress(send, 'Enter'); continue; }
    if (ch === '\t') { await cdpKeyPress(send, 'Tab'); continue; }
    await cdpKeyPress(send, ch);
  }
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
 * Page-side: resolve the target through the shared DOM runtime (ref registry →
 * first visible selector match across shadow roots and same-origin iframes →
 * verified fallback), scroll it into view, optionally focus/select it, and
 * return its centre in TOP-level viewport coordinates (what CDP expects).
 * Also opens the agent's input window (__bcAgentInputUntil, lib/overlay.js) for
 * a few seconds, so the user-input block lets its trusted events through. With
 * `cursor` ({ effect, count }) the agent cursor glides to that centre (`cursorMs`).
 * Kept self-contained: it is serialized into the page by chrome.scripting.
 */
function pageLocate(ref, sel, fb, mode, cursor, check) {
  const D = globalThis.__bcDom;
  // An older runtime (installed before an extension update) has no cursor or clickTarget.
  if (!D || !D.clickTarget || (cursor && !D.cursor)) return { __needDom: true };
  let el = null;
  let via = 'ref';
  if (ref || sel || fb) {
    const r = D.resolve(ref, sel, fb);
    if (r.error === 'INVALID_SELECTOR') return { success: false, error: `Invalid CSS selector: ${sel}` };
    if (r.el) { el = r.el; via = r.via; }
  }
  if (!el && (mode === 'active' || mode === 'focused' || mode === 'focused-clear')) {
    el = document.activeElement;
    // Descend into focused shadow roots / same-origin frames.
    for (let i = 0; el && i < 10; i++) {
      const s = D.shadowOf(el);
      if (s && s.activeElement) { el = s.activeElement; continue; }
      const d = D.frameDoc(el);
      if (d && d.activeElement) { el = d.activeElement; continue; }
      break;
    }
    via = 'active';
    // type without a target needs a real field, not the page body.
    if (mode !== 'active' && (!el || el === document.body || el === document.documentElement)) {
      return { success: false, error: 'NO_FOCUS' };
    }
  }
  if (!el) return { success: false, error: 'REF_GONE', _ref: ref, url: location.href };

  // The agent's trusted input passes the user-input block (see overlay.js).
  window.__bcAgentInputUntil = Date.now() + 8000;

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
  if (check === 'click') {
    const aim = D.clickTarget(el);
    if (aim.message) return { success: false, error: aim.message, x, y };
    if (aim.via) {
      point = { x: aim.x, y: aim.y };
      box = aim.node.getBoundingClientRect();
      reportVia = aim.via;
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
  return { value: value == null ? null : value.slice(0, 100), ...(focusedTag ? { focusedTag } : {}) };
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

/** A locate/click failure that says the target cannot be clicked (see pageLocate `check`). */
export function isBlockedError(error) {
  return /^ELEMENT_(HIDDEN|DISABLED|COVERED)\b/.test(String(error ?? ''));
}

export async function locateTarget(tabId, { ref, selector, fb, mode = 'none', cursor = null, check = null }) {
  const loc = await execDom(tabId, pageLocate, [ref, selector, fb, mode, cursor, check]);
  // Never-shown background tab: size its viewport, then measure again.
  if (loc?.success && loc.zeroViewport && hasCdp(tabId)) {
    await ensureViewport(tabId).catch(() => {});
    // The cursor's effect already played: just move it to the real point.
    return execDom(tabId, pageLocate, [ref, selector, fb, mode, cursor && { effect: 'track' }, check]);
  }
  return loc;
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
  // Gone during the glide: report it rather than clicking where it used to be
  // (and close the shield pass-through the first measurement opened).
  if (again?.error === 'REF_GONE') { await releaseShield(tabId); return again; }
  // A blocked target after the glide is the answer too, not the first measurement.
  return again?.success || isBlockedError(again?.error) ? again : loc;
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


/** Open the agent's input window for its trusted input (raw-coordinate tools like drag). */
export async function openShield(tabId) {
  try {
    await safeExec(tabId, () => {
      window.__bcAgentInputUntil = Date.now() + 8000;
    }, []);
  } catch { /* protected page: CDP input still works, no window to open there */ }
}

export async function releaseShield(tabId) {
  try { return (await safeExec(tabId, pageRelease, [])) || {}; } catch { return {}; /* page navigated away */ }
}

/**
 * Attach the tab's CDP session or return null when CDP is unavailable
 * (another debugger owns the tab, policy blocks chrome.debugger…) so callers
 * fall back to synthetic events. `trusted:false` forces the synthetic path.
 */
export async function trustedSender(tabId, trusted) {
  if (trusted === false) return null;
  try {
    return await ensureCdp(tabId);
  } catch {
    return null;
  }
}
