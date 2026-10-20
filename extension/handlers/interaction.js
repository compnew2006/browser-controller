/**
 * Interaction handlers: browser_click (an element by ref, selector or visible
 * text, or a viewport point; hover and drag too), browser_type (text and key
 * presses) and browser_handle_dialog. All input is real CDP input
 * (lib/trusted-input.js); browser_fill lives in fill.js.
 */
import { resolveTab, hasPoint, execDom, getFallback, withTimeout } from '../lib/page-exec.js';
import { cdpSender, locateTarget, locatePointer, releaseShield, cdpClickAt, cdpKeyPress, cdpTypeText, keyDefinition, modifierBits, pointInfo, cursorTo, sleep } from '../lib/trusted-input.js';
import { lastMousePoint, withCdp, openDialog, clearDialog } from '../lib/cdp-session.js';

/** A ref or selector that no longer finds its element: say which, and how to recover. */
function refGone(res, ref, selector) {
  // A selector that matches nothing is usually the wrong page (navigation,
  // postback), not a re-rendered list — say which locator failed.
  if (!(res._ref || ref) && selector) {
    return { success: false, error: `No element matches selector ${selector} on the current page (${res.url || 'navigated?'}).` };
  }
  return { success: false, error: `REF_GONE: ${res._ref || ref} is no longer on the page. Take a new browser_snapshot (or use query) and retry with a fresh ref.` };
}

/** A failed locate: the stale-ref message, or the page's own error. */
function locateFailure(loc, ref, selector) {
  if (loc?.error === 'REF_GONE') return refGone(loc, ref, selector);
  return { success: false, error: loc?.error || 'Element not found' };
}

const BUTTONS = new Set(['left', 'right', 'middle']);
const MODS = new Set(['ctrl', 'alt', 'shift', 'meta']);
const DRAG_STEPS = 10;

/** Why a located target must not get the mouse (null: go ahead). Hovering a disabled control is fine (tooltips). */
function refusal(loc, clicking) {
  if (clicking && loc.disabled) return 'DISABLED: the element is disabled; nothing was clicked.';
  if (!loc.visible) return 'HIDDEN: the element is not displayed; nothing was clicked. If a menu reveals it, hover that menu first (browser_click hover:true).';
  if (loc.occludedBy) return `COVERED: ${loc.occludedBy} covers the element; nothing was clicked. Close what covers it first, or click it by x/y.`;
  return null;
}

/**
 * Page-side: the visible element whose text, label or value contains `text`
 * (case-insensitive; shadow roots and same-origin frames), climbed to the
 * control that owns it, parked in the ref registry under `tempRef`. Controls
 * beat plain text, then the shortest text (an exact match first), then
 * document order — one pass, no pairwise wrapper filtering.
 */
function pageFindText(text, tempRef) {
  const D = globalThis.__bcDom;
  if (!D) return { __needDom: true };
  const want = D.clean(text).toLowerCase();
  if (!want) return { success: false, error: 'text is empty' };
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'HTML', 'BODY', 'META', 'LINK']);
  const matchLen = (s) => {
    const t = D.clean(s).toLowerCase();
    return t && t.includes(want) ? t.length : 0;
  };
  const hits = new Map(); // target -> { interactive, len, order }
  let order = 0;
  for (const root of D.allRoots(true)) {
    let els = [];
    try { els = root.querySelectorAll('*'); } catch {}
    for (const el of els) {
      if (SKIP.has(el.tagName) || (el.id && el.id.startsWith('__bc'))) continue;
      const len = matchLen(D.isInteractive(el) ? D.nameOf(el) : D.composedText(el, 200))
        || matchLen(D.attr(el, 'aria-label')) || matchLen(D.attr(el, 'title'))
        || (el.tagName === 'INPUT' ? matchLen(el.value) : 0);
      if (!len) continue;
      // Climb to the control that owns this text (MUI: <span> inside <button>).
      let target = el;
      for (let cur = el, i = 0; cur && i < 6; i++) {
        if (D.isInteractive(cur)) { target = cur; break; }
        let r = null;
        try { r = cur.getRootNode(); } catch {}
        cur = cur.parentElement || (r && r.host) || null;
      }
      const prev = hits.get(target);
      if (prev) { prev.len = Math.min(prev.len, len); continue; }
      if (!D.isVisible(target)) continue;
      const interactive = D.isInteractive(target);
      // Plain text: a parent holding only this same text is a wrapper; keep the inner element.
      let at = order++;
      if (!interactive) {
        let parent = el.parentElement;
        if (!parent) { try { parent = el.getRootNode().host || null; } catch {} }
        const ph = parent && hits.get(parent);
        if (ph && !ph.interactive && ph.len === len) { hits.delete(parent); at = ph.order; }
      }
      hits.set(target, { interactive, len, order: at });
    }
  }
  const ranked = [...hits].sort(([, a], [, b]) => (b.interactive - a.interactive) || (a.len - b.len) || (a.order - b.order));
  if (!ranked.length) return { success: false, error: `No visible element with text "${text}". Take a browser_snapshot to see what is there.` };
  const [el, best] = ranked[0];
  D.registry.set(tempRef, el);
  const ties = ranked.filter(([, h]) => h.interactive === best.interactive && h.len === best.len).length;
  const name = D.nameOf(el).slice(0, 60) || D.composedText(el, 60);
  return { success: true, clicked: `${D.roleOf(el)}${name ? ` "${name}"` : ''}`, ...(ties > 1 ? { matches: ties } : {}) };
}

/**
 * Locate an element for the mouse. A hover-revealed item (a menu entry) can
 * lose its hover to the agent's frame: put the pointer back where the agent
 * left it and look again.
 */
async function locateForMouse(tabId, send, target, effect, count) {
  let loc = await locatePointer(tabId, target, effect, count);
  const back = lastMousePoint(tabId);
  if (loc?.success && !loc.visible && back) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: back.x, y: back.y });
    await sleep(150);
    loc = (await locatePointer(tabId, target, effect, count)) || loc;
  }
  return loc;
}

/** Where a drag ends: an element (measured where it is, not scrolled) or a viewport point. */
async function dropPoint(tabId, to) {
  if (!to || typeof to !== 'object') throw new Error('dragTo needs ref, selector, or x and y.');
  if (hasPoint(to)) return { x: to.x, y: to.y };
  if (!to.ref && !to.selector) throw new Error('dragTo needs ref, selector, or x and y.');
  const loc = await locateTarget(tabId, { ref: to.ref, selector: to.selector, fb: getFallback(tabId, to.ref), mode: 'measure' });
  if (!loc?.success) return { error: locateFailure(loc, to.ref, to.selector).error };
  if (!loc.visible || !loc.inView) return { error: 'The drop target is not in view: scroll so both ends of the drag are visible, then retry.' };
  return { x: loc.x, y: loc.y };
}

/** Press at `from`, move in steps (paced by the agent cursor's glide when it is on), release at `to`. */
async function drag(tabId, send, from, to) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
  const glideMs = await cursorTo(tabId, to.x, to.y, 'up');
  const t0 = Date.now();
  for (let i = 1; i <= DRAG_STEPS; i++) {
    if (glideMs) await sleep(t0 + (glideMs * i) / DRAG_STEPS - Date.now());
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(from.x + ((to.x - from.x) * i) / DRAG_STEPS),
      y: Math.round(from.y + ((to.y - from.y) * i) / DRAG_STEPS),
      button: 'left', buttons: 1,
    });
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 });
}

/**
 * browser_click: one real mouse action on an element (ref / selector / text)
 * or at a viewport point (x/y). Default: click (clickCount, button,
 * modifiers); hover: only move there; dragTo: press there and release on
 * another element or point.
 */
export async function handleClick(params) {
  const { tabId, ref, selector, text, hover = false, dragTo } = params;
  const button = params.button ?? 'left';
  if (!BUTTONS.has(button)) throw new Error(`Unknown button ${button}`);
  await resolveTab(tabId);
  const point = hasPoint(params);
  if (!ref && !selector && !text && !point) {
    throw new Error('Give ref, selector or text (refs come from browser_snapshot), or x and y viewport coordinates.');
  }
  const send = await cdpSender(tabId);
  const count = Math.min(Math.max(Number.isInteger(params.clickCount) ? params.clickCount : 1, 1), 3);
  const effect = dragTo ? 'down' : hover ? 'move' : 'click';
  const extra = {};

  let at;
  if (ref || selector || text) {
    let target = { ref, selector, fb: getFallback(tabId, ref) };
    if (!ref && !selector) {
      const tempRef = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
      const found = await execDom(tabId, pageFindText, [text, tempRef]);
      if (!found?.success) return found;
      Object.assign(extra, { clicked: found.clicked }, found.matches ? { matches: found.matches, hint: `${found.matches} elements match equally; this clicked the first. Use a ref from browser_snapshot {query} for another.` } : {});
      target = { ref: tempRef };
    }
    const loc = await locateForMouse(tabId, send, target, effect, count);
    if (!loc?.success) return locateFailure(loc, ref, selector);
    const why = refusal(loc, !hover && !dragTo);
    if (why) {
      await releaseShield(tabId);
      return { success: false, error: why };
    }
    at = { x: loc.x, y: loc.y };
    if (loc.via) extra.via = loc.via;
    if (loc.target) extra.target = loc.target;
  } else {
    const info = await pointInfo(tabId, params.x, params.y, effect, count);
    at = { x: params.x, y: params.y };
    if (info.hit) extra.hit = info.hit;
    if (info.inView === false) extra.warning = 'point is outside the viewport';
  }

  try {
    if (dragTo) {
      const end = await dropPoint(tabId, dragTo);
      if (end.error) return { success: false, error: end.error };
      await drag(tabId, send, at, end);
    } else if (hover) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
    } else {
      const mods = Array.isArray(params.modifiers) ? params.modifiers.filter((m) => MODS.has(m)) : [];
      await cdpClickAt(send, at.x, at.y, { button, clickCount: count, modifiers: modifierBits(mods) });
    }
  } finally {
    await releaseShield(tabId);
  }
  return { success: true, ...extra };
}

/** "ctrl+a" / "Control+Shift+Tab" -> { key: 'a', mods: ['ctrl'] }; plain keys pass through. */
export function parseKeyCombo(key, modifiers = []) {
  const mods = [...modifiers];
  if (typeof key !== 'string' || key.length < 3 || !key.includes('+')) return { key, mods };
  const parts = key.split('+');
  const last = parts.pop() || '+';
  const alias = { control: 'ctrl', ctrl: 'ctrl', alt: 'alt', option: 'alt', shift: 'shift', meta: 'meta', cmd: 'meta', command: 'meta', win: 'meta' };
  for (const part of parts) {
    const m = alias[part.trim().toLowerCase()];
    if (!m) return { key, mods: [...modifiers] };
    if (!mods.includes(m)) mods.push(m);
  }
  return { key: last, mods };
}

/** "ArrowDown ArrowDown Enter" / "ctrl+a Backspace" -> combos; an unknown key fails before anything is pressed. */
export function parseKeys(raw) {
  const s = String(raw ?? '');
  const seq = s.length > 1 && /\s/.test(s.trim()) ? s.trim().split(/\s+/) : [s];
  if (seq.length > 100) throw new Error('At most 100 keys per call.');
  return seq.map((k) => {
    const combo = parseKeyCombo(k);
    try { keyDefinition(combo.key); } catch {
      throw new Error(`Unknown key "${k}". Use names like Enter, Tab, Escape, ArrowDown, PageDown, F5, a single character, or combos like ctrl+a; separate keys with spaces.`);
    }
    return combo;
  });
}

/**
 * browser_type: real key presses. `text` is typed into ref/selector (focused
 * first) or the focused field; `key` is pressed after it (or alone: then the
 * focused element, or the page, gets it).
 */
export async function handleType(params) {
  const { tabId, ref, selector, text, key, clear = false } = params;
  await resolveTab(tabId);
  const typing = typeof text === 'string' && text.length > 0;
  if (!typing && !key && !clear) throw new Error('Give text to type, key to press, or both.');
  const combos = key ? parseKeys(key) : [];
  const send = await cdpSender(tabId);
  const named = !!(ref || selector);
  const field = typing || clear;
  const mode = named ? (clear ? 'clear' : 'focus') : field ? (clear ? 'focused-clear' : 'focused') : 'active';
  const loc = await locateTarget(tabId, { ref, selector, fb: getFallback(tabId, ref), mode });
  if (loc?.error === 'NO_FOCUS') {
    await releaseShield(tabId);
    return { success: false, error: 'No field has focus: pass ref/selector, or click the field first.' };
  }
  if (!loc?.success) return locateFailure(loc, ref, selector);
  if (named && !loc.focused && !loc.visible) {
    await releaseShield(tabId);
    return { success: false, error: 'HIDDEN: the element is not displayed; nothing was typed.' };
  }
  let after;
  try {
    // Not focusable by script (a custom widget): click it like a user would.
    if (named && !loc.focused) {
      await sleep(await cursorTo(tabId, loc.x, loc.y, 'click'));
      await cdpClickAt(send, loc.x, loc.y);
    }
    if (clear && loc.needsSelectAll) await cdpKeyPress(send, 'a', ['ctrl']);
    if (clear && loc.hasText && !typing) await cdpKeyPress(send, 'Backspace');
    if (typing) await cdpTypeText(send, text);
    for (const c of combos) await cdpKeyPress(send, c.key, c.mods);
  } finally {
    after = await releaseShield(tabId);
  }
  return {
    success: true,
    // After keys (Tab, Enter) focus may have moved on: say where, not some other field's value.
    ...(key ? (after?.focusedTag ? { focused: after.focusedTag } : {}) : after?.value != null ? { value: after.value } : {}),
    ...(loc.via && loc.via !== 'active' ? { via: loc.via } : {}),
    ...(loc.target ? { target: loc.target } : {}),
  };
}

/**
 * Answer the JavaScript dialog open in the tab. The tab's debugger session
 * (lib/cdp-session.js) records a dialog that opens while it is attached, which
 * every agent action on the tab is; tool results then carry `dialog`.
 */
export async function handleDialog(params) {
  const { tabId, action = 'accept', promptText } = params;
  const tab = await resolveTab(tabId);
  const dialog = openDialog(tab.id);
  if (!dialog) {
    return {
      success: false,
      error: 'NO_DIALOG: no dialog is open in this tab. A dialog that opened before the agent acted on the tab cannot be answered: reload the tab (browser_navigate) instead.',
    };
  }
  await withCdp(tab.id, (send) => withTimeout(
    send('Page.handleJavaScriptDialog', { accept: action === 'accept', ...(promptText != null ? { promptText } : {}) }),
    3_000,
    () => new Error('The dialog did not close (page not responding).'),
  ));
  clearDialog(tab.id);
  return { success: true, action, dialog };
}
