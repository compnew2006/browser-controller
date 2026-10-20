/**
 * Keyboard input (browser_press_key), split out of interaction.js to keep that
 * module under its size budget. Every key name is checked against the key
 * table in lib/trusted-input.js before either input path runs, so a word that
 * is not a key can never reach the page as a keydown.
 */
import { resolveTab, execDom, getFallback } from '../lib/page-exec.js';
import { trustedSender, locateTarget, releaseShield, cdpKeyPress, keyDefinition } from '../lib/trusted-input.js';
import { refErrorMessage, selectorErrorMessage } from '../lib/ref-errors.js';

/**
 * The answer for a key target that did not resolve: the stale-ref wording for a
 * ref (lib/ref-errors.js), the selector's own not-found message, or the page's
 * message for an invalid selector.
 */
function unresolvedTarget(ref, selector, known, failure) {
  if (failure?.error && failure.error !== 'REF_GONE') return { success: false, error: failure.error };
  return { success: false, error: ref ? refErrorMessage(ref, known) : selectorErrorMessage(selector, failure?.url) };
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

export async function handlePressKey(params) {
  const { tabId, ref, selector, trusted } = params;
  const { key, mods: modifiers } = parseKeyCombo(params.key, params.modifiers || []);
  await resolveTab(tabId);
  const fb = getFallback(tabId, ref);

  // "ArrowDown ArrowDown Enter" / "ctrl+a Backspace": a space-separated key
  // sequence; `repeat` presses the whole sequence N times.
  const raw = String(params.key ?? '');
  const seq = raw.length > 1 && /\s/.test(raw.trim()) ? raw.trim().split(/\s+/) : [raw];
  const combos = seq.map((k) => parseKeyCombo(k, params.modifiers || []));
  const repeat = Math.min(Math.max(1, Number.isInteger(params.repeat) ? params.repeat : 1), 100);

  // Every name must be a key the page can receive (lib/trusted-input.js table or
  // a single character). "Hello" must not go through as a keydown named "Hello".
  for (const c of combos) {
    try { keyDefinition(c.key); } catch {
      return { success: false, error: `UNKNOWN_KEY: "${c.key}" is not a key name (e.g. Enter, Tab, Escape, ArrowDown, a, ctrl+a). To type text, use browser_type.` };
    }
  }

  // Trusted path: a real key press, so default actions run (Tab moves focus
  // and fires blur/focusout, Enter submits, arrows drive autocomplete menus).
  const send = await trustedSender(tabId, trusted);
  if (send) {
    const loc = await locateTarget(tabId, { ref, selector, fb, mode: ref || selector ? 'focus' : 'active' });
    if (!loc || loc.success === false) {
      await releaseShield(tabId);
      if (ref || selector) return unresolvedTarget(ref, selector, fb, loc);
    }
    let after;
    try {
      for (let r = 0; r < repeat; r++) {
        for (const c of combos) await cdpKeyPress(send, c.key, c.mods);
      }
    } finally {
      after = await releaseShield(tabId);
    }
    return {
      success: true, key: combos.length > 1 ? raw : key, ...(modifiers.length && combos.length === 1 ? { modifiers } : {}),
      ...(repeat > 1 ? { repeat } : {}), input: 'cdp', ...(after?.focusedTag ? { focused: after.focusedTag } : {}),
    };
  }

  if (combos.length > 1 || repeat > 1) throw new Error('Key sequences and repeat need the debugger (CDP); press keys one at a time with trusted:false.');
  const res = await execDom(tabId, (_key, _mods, _ref, _sel, _fb) => {
    const D = globalThis.__bcDom;
    if (!D) return { __needDom: true };

    let target = document.activeElement || document.body;
    // When the caller names a target, an unresolved ref/selector must FAIL —
    // silently falling back to activeElement sent Enter to the wrong control
    // with a success result. (Omitting both is still legitimate: intentional
    // activeElement targeting.)
    if (_ref || _sel) {
      const found = D.resolve(_ref, _sel, _fb);
      if (found.error === 'INVALID_SELECTOR') return { success: false, error: `Invalid CSS selector: ${_sel}` };
      const el = found.el || null;
      if (!el) return { success: false, error: 'REF_GONE', url: location.href };
      el.focus();
      target = el;
    }

    const init = {
      key: _key,
      code: _key.length === 1 ? `Key${_key.toUpperCase()}` : _key,
      bubbles: true,
      cancelable: true,
      ctrlKey: _mods.includes('ctrl'),
      altKey: _mods.includes('alt'),
      shiftKey: _mods.includes('shift'),
      metaKey: _mods.includes('meta'),
    };

    target.dispatchEvent(new KeyboardEvent('keydown', init));
    target.dispatchEvent(new KeyboardEvent('keypress', init));
    target.dispatchEvent(new KeyboardEvent('keyup', init));

    return { success: true, key: _key };
  }, [key, modifiers, ref, selector, fb]);
  return res?.success === false ? unresolvedTarget(ref, selector, fb, res) : res;
}

