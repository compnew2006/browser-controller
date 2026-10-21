/**
 * Interaction handlers: browser_click (also hover and dragTo) and browser_type (text,
 * key, clear, submit). Pointer and keyboard input is trusted CDP input only: with no
 * debugger the call fails with DEBUGGER_UNAVAILABLE and nothing is dispatched. A `target`
 * is the one locator string (lib/target.js). Every dispatch goes through an input session
 * (lib/trusted-input.js inputSession): a JS dialog the input opens settles the call with a
 * `dialog:` line, a cancelled call sends nothing new. browser_fill and browser_handle_dialog
 * are in interaction-advanced.js.
 */
import { resolveTab } from '../lib/page-exec.js';
import { getOpenDialog } from '../lib/cdp-session.js';
import { parseTarget } from '../lib/target.js';
import { requireSender, locateTarget, locatePointer, focusByClick, measureTarget, selectFocused, releaseShield, cdpClickAt, cdpKeyPress, keyDefinition, modifierBits, cursorTo, sleep, assertInputReady, inputSession, dialogSummary } from '../lib/trusted-input.js';
import { reboundNote } from '../lib/ref-errors.js';
import { clearSelection, withFrames, interceptDrags } from '../lib/drag-input.js';

const BUTTONS = new Set(['left', 'right', 'middle']);
/** Modifier names a click or a drag takes ("Control" and "ctrl" both work) and their CDP names. */
const MODIFIER_NAMES = { Alt: 'alt', Control: 'ctrl', Meta: 'meta', Shift: 'shift', alt: 'alt', ctrl: 'ctrl', meta: 'meta', shift: 'shift' };
/** Mouse moves between a drag's press and its release. */
const DRAG_STEPS = 10;
/** How long an input may take to show a navigation or a dialog; the result reports what it did. */
const SETTLE_MS = 300;

/** Modifier bits for a list of names. */
function modifiersOf(names = []) {
  return modifierBits(names.map((m) => {
    const name = MODIFIER_NAMES[m];
    if (!name) throw new Error(`INVALID_ARGUMENT: unknown modifier ${m} (use Alt, Control, Meta or Shift)`);
    return name;
  }));
}

/** clickCount: 1 to 3 (double and triple click). */
function countOf(count) {
  const n = count ?? 1;
  if (!Number.isInteger(n) || n < 1 || n > 3) throw new Error(`INVALID_ARGUMENT: count must be 1, 2 or 3 (got ${count})`);
  return n;
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

/**
 * A `key` value as its key presses, in order: one key or combo ("Enter", "Control+a"), or
 * several separated by spaces ("ArrowDown ArrowDown Enter"). A value of only whitespace is
 * the Space key. Every token is checked before anything is sent: a name that is no key is UNKNOWN_KEY.
 */
function keyCombosOf(key) {
  const text = String(key);
  const tokens = /\S/.test(text) ? text.split(/\s+/).filter(Boolean) : [text];
  return tokens.map((token) => {
    const combo = parseKeyCombo(token);
    try { keyDefinition(combo.key); } catch {
      throw new Error(`UNKNOWN_KEY: "${token}" is not a key name (e.g. Enter, Tab, Escape, ArrowDown, a, ctrl+a). To type text, pass text.`);
    }
    return combo;
  });
}

/** The tab's URL, or null when the tab is gone. */
async function tabUrl(tabId) {
  try { return (await chrome.tabs.get(tabId)).url ?? null; } catch { return null; }
}

/**
 * What an input did within SETTLE_MS: a top-level navigation, or a JS dialog that
 * was not open before the input. Returns as soon as either shows; the input has
 * already returned, so nothing here waits for the page to load.
 */
async function settle(tabId, urlBefore, dialogBefore = null) {
  const deadline = Date.now() + SETTLE_MS;
  for (;;) {
    const dialog = getOpenDialog(tabId);
    const url = await tabUrl(tabId);
    const navigated = url && url !== urlBefore ? url : null;
    const fresh = dialog && !(dialogBefore && dialogBefore.type === dialog.type && dialogBefore.message === dialog.message) ? dialog : null;
    if (navigated || fresh || Date.now() >= deadline) return { navigated, dialog: fresh };
    await sleep(25);
  }
}

/**
 * The answer of an input: its own lines, then what it navigated or opened, then the
 * notes (a ref re-found after the page changed: the last line of the reply).
 */
function inputResult(lines, settled, data = {}, notes = []) {
  const out = [...lines];
  if (settled?.navigated) out.push(`navigated: ${settled.navigated}`);
  if (settled?.dialog) out.push(`dialog: ${dialogSummary(settled.dialog)}`);
  out.push(...notes);
  return {
    success: true,
    text: out.join('\n'),
    ...data,
    ...(settled?.navigated ? { navigated: settled.navigated } : {}),
    ...(settled?.dialog ? { dialog: settled.dialog } : {}),
  };
}

const pointOf = (loc) => ({ x: Math.round(loc.x), y: Math.round(loc.y) });
/** A point target outside the viewport lands nowhere: the answer says so. */
const outsideLines = (loc) => (loc.visible === false ? ['warning: point is outside the viewport'] : []);

/** A located ref that was re-found by its snapshot descriptor: one note line for it (lib/ref-errors.js). */
function reboundNotes(loc, targets) {
  if (loc?.via !== 'fallback') return [];
  return targets.map((t) => parseTarget(t)).filter((p) => p.kind === 'ref').map((p) => reboundNote(p.ref));
}

/** Failed locate: release the input window and return the answer (nothing was sent). */
async function refused(tabId, loc) {
  await releaseShield(tabId);
  return { success: false, error: loc.error };
}

/** Mouse move to a target, no press (hover:true). */
async function hoverTo(tabId, input, target) {
  const urlBefore = await tabUrl(tabId);
  const loc = await locatePointer(tabId, { target }, 'move');
  if (!loc.success) return refused(tabId, loc);
  const isPoint = parseTarget(target).kind === 'point';
  if (loc.visible === false && !isPoint) {
    await releaseShield(tabId);
    return { success: false, error: `ELEMENT_HIDDEN: ${target} has no size on the page, so there is nothing to hover` };
  }
  try {
    await input.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: loc.x, y: loc.y });
  } finally {
    if (!input.blocked) await releaseShield(tabId);
  }
  const settled = input.blocked ? await settle(tabId, urlBefore) : null;
  return inputResult([`hovered ${target}`, ...outsideLines(loc)], settled, { input: 'cdp', at: pointOf(loc) }, reboundNotes(loc, [target]));
}

/**
 * Press on `from`, move in DRAG_STEPS steps to `to`, release. Both points are
 * measured after the last scroll: revealing one can move the other out of view,
 * so the two reveal orders are tried, and when neither keeps both in view the
 * drag is refused (TARGET_OFFSCREEN) with nothing pressed. A failure after the
 * press still releases the button, where the press is now. No text is selected at
 * the press (it would start Chrome's text drag), and the tab draws frames while
 * the drag runs (a background tab otherwise holds each move about a second). When
 * the page starts an HTML5 drag (draggable=true, a link, an image), Chrome hands it
 * over instead of starting its own (interceptDrags) and the rest of the gesture is
 * dragenter / dragover / drop at the same points.
 */
async function dragBetween(tabId, input, from, to) {
  const pair = async () => {
    const a = await measureTarget(tabId, from);
    if (a.error) return { error: a.error };
    const b = await measureTarget(tabId, to);
    if (b.error) return { error: b.error };
    return a.inView && b.inView ? { a, b } : null;
  };
  let points = null;
  const rebound = [];
  for (const first of [from, to]) {
    const loc = first === from ? await locatePointer(tabId, { target: from }, 'click') : await locateTarget(tabId, { target: to });
    if (!loc.success) return refused(tabId, loc);
    rebound.push(...reboundNotes(loc, [first]));
    const m = await pair();
    if (m?.error) return refused(tabId, m);
    if (m) { points = m; break; }
  }
  if (!points) {
    await releaseShield(tabId);
    return { success: false, error: 'TARGET_OFFSCREEN: the drag source and drop target cannot be in the viewport together; move one closer or drag in steps.' };
  }
  const { a, b } = points;
  const urlBefore = await tabUrl(tabId);
  await clearSelection(tabId);
  let at = a;
  let pressed = false;
  let releasing = false;
  // Set once the page starts an HTML5 drag: from then on the gesture is drag events.
  let html5 = false;
  const drag = await interceptDrags(tabId, input.raw);
  const dragEvent = (type, p) => input.send('Input.dispatchDragEvent', { type, x: p.x, y: p.y, data: drag.data });
  try {
    await withFrames(tabId, input.raw, async () => {
      await input.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x, y: a.y });
      pressed = await input.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', clickCount: 1 });
      // The agent cursor (when shown) carries the drag: moves are paced over its glide.
      const glideMs = input.blocked ? 0 : await cursorTo(tabId, b.x, b.y, 'up');
      const t0 = Date.now();
      for (let i = 1; i <= DRAG_STEPS && !input.blocked; i++) {
        if (glideMs) await sleep(t0 + (glideMs * i) / DRAG_STEPS - Date.now());
        at = { x: Math.round(a.x + ((b.x - a.x) * i) / DRAG_STEPS), y: Math.round(a.y + ((b.y - a.y) * i) / DRAG_STEPS) };
        if (html5) {
          await dragEvent('dragOver', at);
        } else {
          await input.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y, button: 'left' });
          if (drag.data) { html5 = true; await dragEvent('dragEnter', at); }
        }
      }
      at = b;
      // Chrome can hand the drag over after the last move's answer.
      if (!html5 && !input.blocked && await drag.started()) { html5 = true; await dragEvent('dragEnter', b); }
      releasing = true;
      if (html5) await dragEvent('drop', b);
      else await input.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 });
    });
  } catch (err) {
    // A failed drag must not leave the button down (or an HTML5 drag open): end it where the press is now.
    if (pressed && !releasing && err?.code !== 'TAB_WEDGED') {
      const end = html5
        ? input.send('Input.dispatchDragEvent', { type: 'cancel', x: at.x, y: at.y, data: drag.data })
        : input.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1 });
      await end.catch(() => {});
    }
    throw err;
  } finally {
    await drag.stop();
    if (!input.blocked) await releaseShield(tabId);
  }
  const settled = await settle(tabId, urlBefore);
  const lines = [`dragged ${from} → ${to}`, ...(html5 ? ['html5: the page started a drag; dragenter, dragover and drop were sent'] : [])];
  return inputResult(lines, settled, { input: 'cdp', from: pointOf(a), to: pointOf(b), ...(html5 ? { html5: true } : {}) }, rebound);
}

/**
 * browser_click: one trusted mouse path. The target is checked first (hidden,
 * disabled or covered: nothing is clicked, the error says why); a point target is
 * clicked as it is. `hover` moves only; `dragTo` drags to a second target.
 */
export async function handleClick(params, _sessionId, _agentName, signal) {
  const { tabId, target, button = 'left', count, modifiers = [], hover = false, dragTo } = params;
  parseTarget(target);
  if (dragTo != null) parseTarget(dragTo);
  if (!BUTTONS.has(button)) throw new Error(`INVALID_ARGUMENT: unknown button ${button}`);
  const clickCount = countOf(count);
  const mods = modifiersOf(modifiers);
  if (hover && dragTo != null) throw new Error('INVALID_ARGUMENT: hover and dragTo cannot be combined');
  await resolveTab(tabId);
  assertInputReady(tabId, signal);
  const input = inputSession(tabId, await requireSender(tabId), signal);
  try {
    if (hover) return await hoverTo(tabId, input, target);
    if (dragTo != null) return await dragBetween(tabId, input, target, dragTo);

    const urlBefore = await tabUrl(tabId);
    const loc = await locatePointer(tabId, { target }, 'click', clickCount);
    if (!loc.success) return refused(tabId, loc);
    try {
      await cdpClickAt(input.send, loc.x, loc.y, { button, clickCount, modifiers: mods });
    } finally {
      if (!input.blocked) await releaseShield(tabId);
    }
    const settled = await settle(tabId, urlBefore);
    return inputResult([`clicked ${target}${loc.onLabel ? ' via label' : ''}`, ...outsideLines(loc)], settled, { input: 'cdp', at: pointOf(loc) }, reboundNotes(loc, [target]));
  } finally {
    input.close();
  }
}

/**
 * browser_type: `target` is focused by a trusted click when it is not focused yet;
 * without one, the focused field takes the input (NO_FOCUS when none is a field).
 * `clear` selects all, `text` goes in with one insertText, `key` is one key, a combo, or
 * several in order (keyCombosOf), `submit` presses Enter last. A step the page never reached
 * (a dialog opened first) is not reported as done.
 */
export async function handleType(params, _sessionId, _agentName, signal) {
  const { tabId, target, text, key, clear = false, submit = false } = params;
  if (target !== undefined) parseTarget(target);
  if (!text && key == null && !clear && !submit) throw new Error('INVALID_ARGUMENT: browser_type needs text, key, clear or submit');
  const combos = key == null ? null : keyCombosOf(key);
  await resolveTab(tabId);
  assertInputReady(tabId, signal);
  const input = inputSession(tabId, await requireSender(tabId), signal);
  try {
    const urlBefore = await tabUrl(tabId);
    let loc;
    if (target !== undefined) {
      loc = await focusByClick(tabId, input, target);
    } else {
      // Text and clear need a field to act on; a key alone may go to whatever has focus.
      loc = await locateTarget(tabId, { mode: text || clear ? 'focused' : 'active' });
      if (loc.error === 'NO_FOCUS') loc = { success: false, error: 'NO_FOCUS: no field has focus: pass target, or click the field first.' };
    }
    if (!loc.success) return refused(tabId, loc);

    const where = target ?? 'focused element';
    const chars = text ? [...String(text)].length : 0;
    const lines = [];
    let typed = null;
    let after = {};
    try {
      if (clear && !input.blocked) await selectFocused(tabId);
      if (clear && !text && !input.blocked) { await cdpKeyPress(input.send, 'Backspace'); lines.push(`cleared ${where}`); }
      if (text && !input.blocked) { await input.send('Input.insertText', { text: String(text) }); typed = chars; lines.push(`typed ${chars} chars into ${where}`); }
      if (combos && !input.blocked) {
        // Each press waits for the one before; a dialog that a press opens ends the sequence.
        let sent = 0;
        for (const combo of combos) {
          if (input.blocked) break;
          await cdpKeyPress(input.send, combo.key, combo.mods);
          sent += 1;
        }
        lines.push(sent === combos.length ? `pressed ${key}` : `pressed ${sent} of ${combos.length} keys`);
      }
      if (submit && !input.blocked) { await cdpKeyPress(input.send, 'Enter'); lines.push('submitted with Enter'); }
    } finally {
      if (!input.blocked) after = await releaseShield(tabId);
    }
    const settled = combos || submit || input.blocked ? await settle(tabId, urlBefore) : null;

    const value = after?.value ?? null;
    if (value != null) lines.push(after.secret ? 'value: ••••' : `value: "${value}"`);
    return inputResult(lines, settled, {
      input: 'cdp',
      ...(typed != null ? { typed } : {}),
      ...(value != null ? { value: after.secret ? '••••' : value } : {}),
    }, target === undefined ? [] : reboundNotes(loc, [target]));
  } finally {
    input.close();
  }
}
