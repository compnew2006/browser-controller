/**
 * Interaction handlers (extracted from background.js): click, type, press_key,
 * hover, select, click_text, dialog, drag, fill_form — the write side that
 * drives the page's event system (synthetic events) or CDP when required.
 */
import { resolveTab, requireTarget, hasPoint, execDom, getFallback } from '../lib/page-exec.js';
import { autoReSnapshot } from './inspection.js';
import { trustedSender, locateTarget, releaseShield, cdpClickAt, cdpKeyPress, cdpTypeText, keyDefinition, modifierBits, pointInfo } from '../lib/trusted-input.js';

export { handleDialog, handleDrag, handleFillForm } from './interaction-advanced.js';

/** Shared REF_GONE recovery: re-snapshot and hand fresh refs back (no auto-retry). */
async function refGone(tabId, res, ref, selector) {
  // A selector that matches nothing is usually the wrong page (navigation,
  // postback), not a virtualized feed — say which locator failed.
  if (!(res._ref || ref) && selector) {
    return { success: false, error: `No element matches selector ${selector} on the current page (${res.url || 'navigated?'}).` };
  }
  const fresh = await autoReSnapshot(tabId);
  return {
    success: false,
    error: `Element ${res._ref || ref} is gone from the DOM (feed scrolled/virtualized). Fresh refs captured — retry with a new ref.`,
    freshRefs: fresh,
  };
}

const BUTTONS = new Set(['left', 'right', 'middle']);
const MODS = new Set(['ctrl', 'alt', 'shift', 'meta']);

/** clickCount from the params (1–3; doubleClick = 2). */
function clickCountOf(params) {
  const n = Number(params.clickCount);
  if (Number.isInteger(n) && n >= 1) return Math.min(n, 3);
  return params.doubleClick ? 2 : 1;
}

/** Modifier names held during a click ("ctrl+click" opens links in a new tab). */
function clickModifiers(params) {
  const mods = Array.isArray(params.modifiers) ? params.modifiers.filter((m) => MODS.has(m)) : [];
  return modifierBits(mods);
}

/** Coordinate actions need CDP: there is no element to dispatch synthetic events on. */
async function requireCdp(tabId, what) {
  const send = await trustedSender(tabId, true);
  if (!send) throw new Error(`${what} at x/y needs the debugger (CDP), which could not attach to tab ${tabId}. Use ref or selector instead.`);
  return send;
}

/** Real mouse click at viewport coordinates (the same CSS-pixel frame as browser_screenshot). */
async function clickAtPoint(tabId, params) {
  const { x, y, button = 'left' } = params;
  if (!BUTTONS.has(button)) throw new Error(`Unknown button ${button}`);
  const send = await requireCdp(tabId, 'Clicking');
  const info = await pointInfo(tabId, x, y);
  try {
    await cdpClickAt(send, x, y, { button, clickCount: clickCountOf(params), modifiers: clickModifiers(params) });
  } finally {
    await releaseShield(tabId);
  }
  return {
    success: true, input: 'cdp', at: { x, y },
    ...(info.hit ? { hit: info.hit } : {}),
    ...(info.inView === false ? { warning: 'point is outside the viewport' } : {}),
  };
}

export async function handleClick(params) {
  const { tabId, ref, selector, button = 'left', doubleClick = false, trusted } = params;
  await resolveTab(tabId);
  requireTarget(params, { allowPoint: true });
  if (!ref && !selector) return clickAtPoint(tabId, params);
  // Snapshot-time descriptor used by the shared resolver when the ref is stale.
  const fb = getFallback(tabId, ref);

  // Trusted path: a real mouse click at the element's centre over CDP, so
  // focus moves, default actions run and the page sees isTrusted:true.
  const send = await trustedSender(tabId, trusted);
  if (send && BUTTONS.has(button)) {
    const loc = await locateTarget(tabId, { ref, selector, fb });
    if (loc && loc.success === false && loc.error === 'REF_GONE') return refGone(tabId, loc, ref, selector);
    if (loc?.success && loc.visible) {
      try {
        await cdpClickAt(send, loc.x, loc.y, { button, clickCount: clickCountOf(params), modifiers: clickModifiers(params) });
      } finally {
        await releaseShield(tabId);
      }
      return {
        success: true,
        input: 'cdp',
        ...(loc.via ? { via: loc.via } : {}),
        ...(loc.occludedBy ? { warning: `click point is covered by ${loc.occludedBy}` } : {}),
      };
    }
    await releaseShield(tabId);
    // Zero-size element: no point to hit — fall through to the synthetic path.
  }

  const res = await execDom(tabId, async (_ref, _sel, _btn, _dbl, _fb) => {
    const D = globalThis.__bcDom;
    if (!D) return { __needDom: true };

    // ref registry → first visible selector match → verified fallback (lib/page-dom.js).
    const found = D.resolve(_ref, _sel, _fb);
    if (found.error === 'INVALID_SELECTOR') return { success: false, error: `Invalid CSS selector: ${_sel}` };
    let el = found.el || null;
    const via = found.via || 'ref';
    if (!el) {
      // Element is gone (likely virtualized away on scroll). Abort WITHOUT
      // clicking — the background auto-re-snapshots and embeds fresh refs.
      return { success: false, error: 'REF_GONE', _ref, url: location.href };
    }

    el.scrollIntoView({ behavior: 'instant', block: 'center' });

    // Fix #2 (visibility retry): after scrollIntoView, the element may still be
    // off-screen or zero-size if layout hasn't reflowed yet. Give it one short
    // settle (200ms) and re-read the element once. This kills the common "element
    // present but click landed nowhere" failure on lazy-rendered lists. Bounded
    // to a single retry so a truly-hidden element still surfaces honestly.
    const rect0 = el.getBoundingClientRect();
    const visible0 = rect0.width > 0 && rect0.height > 0;
    if (!visible0) {
      await new Promise((r) => setTimeout(r, 200));
      // re-resolve the element (it may have been re-rendered with a new node)
      el = D.resolve(_ref, _sel, _fb).el || el;
      if (el) el.scrollIntoView({ behavior: 'instant', block: 'center' });
    }
    if (!el) return { success: false, error: 'REF_GONE', _ref };

    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const btnVal = _btn === 'left' ? 0 : _btn === 'right' ? 2 : 1;
    const init = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: btnVal };

    el.dispatchEvent(new MouseEvent('mouseover', init));
    el.dispatchEvent(new MouseEvent('mousedown', init));
    if (el.focus) el.focus();
    el.dispatchEvent(new MouseEvent('mouseup', init));
    el.dispatchEvent(new MouseEvent('click', init));

    // A real right-click opens the context menu via a contextmenu event —
    // mousedown/mouseup/click alone never trigger it.
    if (_btn === 'right') {
      el.dispatchEvent(new MouseEvent('contextmenu', init));
    }

    if (_dbl) {
      el.dispatchEvent(new MouseEvent('mousedown', init));
      el.dispatchEvent(new MouseEvent('mouseup', init));
      el.dispatchEvent(new MouseEvent('click', init));
      el.dispatchEvent(new MouseEvent('dblclick', init));
    }

    return { success: true, ...(via !== 'ref' ? { via } : {}) };
  }, [ref, selector, button, doubleClick, fb]);

  // The page function returns REF_GONE when the element (and all fallbacks)
  // can't be found — typical of virtualized feeds (FB/IG) after scrolling.
  // Auto-re-snapshot and embed fresh refs so the agent retries in ONE step.
  // We do NOT auto-retry the click: it's non-idempotent and the element that
  // re-appears may be a different post after the scroll shifted the feed.
  if (res && res.success === false && res.error === 'REF_GONE') return refGone(tabId, res, ref, selector);
  return res;
}

export async function handleType(params) {
  const { tabId, ref, selector, text, clear = false, trusted } = params;
  await resolveTab(tabId);
  // No ref/selector: type into the element that has focus (like a user
  // typing after clicking a field).
  const focusedOnly = !ref && !selector;
  // Snapshot-time descriptor used by the shared resolver when the ref is stale.
  const fb = getFallback(tabId, ref);

  // Trusted path: focus the field, then real key presses over CDP (keydown /
  // keypress / input / keyup per character). Like a user, this does NOT fire
  // `change` until focus leaves the field — press Tab to commit.
  const send = await trustedSender(tabId, trusted);
  if (send) {
    const mode = focusedOnly ? (clear ? 'focused-clear' : 'focused') : clear ? 'clear' : 'focus';
    const loc = await locateTarget(tabId, { ref, selector, fb, mode });
    if (loc && loc.error === 'NO_FOCUS') {
      await releaseShield(tabId);
      return { success: false, error: 'No field has focus: pass ref/selector, or click the field first.' };
    }
    if (loc && loc.success === false && loc.error === 'REF_GONE') return refGone(tabId, loc, ref, selector);
    if (loc?.success && (loc.focused || loc.visible)) {
      let after;
      try {
        // Not focusable by script (custom widget): click it like a user would.
        if (!loc.focused) await cdpClickAt(send, loc.x, loc.y);
        if (clear && loc.needsSelectAll) await cdpKeyPress(send, 'a', ['ctrl']);
        if (clear && loc.hasText && !text) await cdpKeyPress(send, 'Backspace');
        await cdpTypeText(send, text);
      } finally {
        after = await releaseShield(tabId);
      }
      return {
        success: true,
        typed: text,
        input: 'cdp',
        ...(after?.value != null ? { value: after.value } : {}),
        ...(loc.via ? { via: loc.via } : {}),
      };
    }
    await releaseShield(tabId);
  }

  const res = await execDom(tabId, (_ref, _sel, _text, _clear, _fb) => {
    const D = globalThis.__bcDom;
    if (!D) return { __needDom: true };

    let found;
    if (!_ref && !_sel) {
      const a = document.activeElement;
      if (!a || a === document.body) return { success: false, error: 'No field has focus: pass ref/selector, or click the field first.' };
      found = { el: a, via: 'active' };
    } else {
      found = D.resolve(_ref, _sel, _fb);
    }
    if (found.error === 'INVALID_SELECTOR') return { success: false, error: `Invalid CSS selector: ${_sel}` };
    const el = found.el || null;
    const via = found.via || 'ref';
    if (!el) {
      // Element gone (virtualized feed) — abort WITHOUT typing; background
      // auto-re-snapshots and embeds fresh refs for a one-step retry.
      return { success: false, error: 'REF_GONE', _ref, url: location.href };
    }

    el.focus();

    const setNativeValue = (target, nextValue) => {
      const prototype = target instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (setter) setter.call(target, nextValue);
      else target.value = nextValue;
    };

    if (_clear) {
      if (el.isContentEditable) el.textContent = '';
      else setNativeValue(el, '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }

    if (el.isContentEditable) {
      document.execCommand('insertText', false, _text);
    } else {
      for (const ch of _text) {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
        setNativeValue(el, `${el.value}${ch}`);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
      }
    }

    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { success: true, typed: _text, ...(via !== 'ref' ? { via } : {}) };
  }, [ref, selector, text, clear, fb]);

  // Virtualization recovery (same as click): type target is gone, so
  // auto-re-snapshot and embed fresh refs. No auto-retry (non-idempotent).
  if (res && res.success === false && res.error === 'REF_GONE') return refGone(tabId, res, ref, selector);
  return res;
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

  // Trusted path: a real key press, so default actions run (Tab moves focus
  // and fires blur/focusout, Enter submits, arrows drive autocomplete menus).
  let knownKey = true;
  for (const c of combos) { try { keyDefinition(c.key); } catch { knownKey = false; } }
  if (!knownKey && (combos.length > 1 || repeat > 1)) throw new Error(`Unknown key in "${raw}"`);
  const send = knownKey ? await trustedSender(tabId, trusted) : null;
  if (send) {
    const loc = await locateTarget(tabId, { ref, selector, fb, mode: ref || selector ? 'focus' : 'active' });
    if (!loc || loc.success === false) {
      await releaseShield(tabId);
      if (ref || selector) return { success: false, error: `Element ${ref ? `with ref ${ref}` : `with selector ${selector}`} not found` };
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
  return execDom(tabId, (_key, _mods, _ref, _sel, _fb) => {
    const D = globalThis.__bcDom;
    if (!D) return { __needDom: true };

    let target = document.activeElement || document.body;
    // When the caller names a target, an unresolved ref/selector must FAIL —
    // silently falling back to activeElement sent Enter to the wrong control
    // with a success result. (Omitting both is still legitimate: intentional
    // activeElement targeting.)
    if (_ref || _sel) {
      const el = D.resolve(_ref, _sel, _fb).el;
      if (!el) return { success: false, error: _ref ? `Element with ref ${_ref} not found` : `Element with selector ${_sel} not found` };
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
}

export async function handleHover(params) {
  const { tabId, ref, selector, trusted } = params;
  await resolveTab(tabId);
  requireTarget(params, { allowPoint: true });
  if (!ref && !selector && hasPoint(params)) {
    const sendAt = await requireCdp(tabId, 'Hovering');
    const info = await pointInfo(tabId, params.x, params.y);
    try {
      await sendAt('Input.dispatchMouseEvent', { type: 'mouseMoved', x: params.x, y: params.y });
    } finally {
      await releaseShield(tabId);
    }
    return { success: true, input: 'cdp', at: { x: params.x, y: params.y }, ...(info.hit ? { hit: info.hit } : {}) };
  }
  const fb = getFallback(tabId, ref);

  const send = await trustedSender(tabId, trusted);
  if (send) {
    const loc = await locateTarget(tabId, { ref, selector, fb });
    if (loc?.success && loc.visible) {
      try {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: loc.x, y: loc.y });
      } finally {
        await releaseShield(tabId);
      }
      return { success: true, input: 'cdp' };
    }
    await releaseShield(tabId);
    if (loc && loc.success === false) return { success: false, error: 'Element not found' };
  }

  return execDom(tabId, (_ref, _sel, _fb) => {
    const D = globalThis.__bcDom;
    if (!D) return { __needDom: true };

    const el = D.resolve(_ref, _sel, _fb).el;
    if (!el) return { success: false, error: 'Element not found' };

    el.scrollIntoView({ behavior: 'instant', block: 'center' });
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const init = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };

    el.dispatchEvent(new MouseEvent('mouseenter', { ...init, bubbles: false }));
    el.dispatchEvent(new MouseEvent('mouseover', init));
    el.dispatchEvent(new MouseEvent('mousemove', init));

    return { success: true };
  }, [ref, selector, fb]);
}

export async function handleSelect(params) {
  const { tabId, ref, selector, value, label, index } = params;
  await resolveTab(tabId);
  requireTarget(params);
  if (value === undefined && label === undefined && index === undefined) {
    throw new Error('One of value, label, or index is required to pick an option.');
  }
  const fb = getFallback(tabId, ref);

  return execDom(tabId, (_ref, _sel, _val, _lbl, _idx, _fb) => {
    const D = globalThis.__bcDom;
    if (!D) return { __needDom: true };

    const el = D.resolve(_ref, _sel, _fb).el;
    if (!el) return { success: false, error: 'Element not found' };
    if (el.tagName !== 'SELECT') return { success: false, error: 'Not a select element' };

    if (_val !== null) el.value = _val;
    else if (_lbl !== null) {
      const opt = Array.from(el.options).find((o) => o.textContent.trim() === _lbl);
      if (opt) el.value = opt.value;
      else return { success: false, error: `Option "${_lbl}" not found` };
    } else if (_idx !== null) {
      if (_idx >= 0 && _idx < el.options.length) el.selectedIndex = _idx;
      else return { success: false, error: `Index ${_idx} out of range` };
    }

    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return { success: true, selected: el.value };
  }, [ref, selector, value, label, index, fb]);
}

export async function handleClickByText(params) {
  const { tabId, text, index = 0, exact = false, trusted } = params;
  await resolveTab(tabId);
  const tempRef = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

  // Page side: find the element by accessible name / composed text (shadow
  // roots + same-origin frames), climb to the control that owns it, and park
  // it in the ref registry so the click itself goes through the normal path.
  const found = await execDom(tabId, (_text, _index, _exact, _ref) => {
    const D = globalThis.__bcDom;
    if (!D) return { __needDom: true };
    const want = D.clean(_text).toLowerCase();
    if (!want) return { success: false, error: 'text is required' };
    const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'HTML', 'BODY', 'META', 'LINK']);
    const hits = [];
    const seen = new Set();
    const matches = (s) => {
      const t = D.clean(s).toLowerCase();
      if (!t) return false;
      return _exact ? t === want : t.includes(want);
    };
    for (const root of D.allRoots(true)) {
      let els = [];
      try { els = root.querySelectorAll('*'); } catch {}
      for (const el of els) {
        if (SKIP.has(el.tagName)) continue;
        const own = D.isInteractive(el) ? D.nameOf(el) : D.composedText(el, 200);
        // aria-label / title / value also count as the element's text.
        if (!matches(own) && !matches(D.attr(el, 'aria-label')) && !matches(D.attr(el, 'title'))
          && !(el.tagName === 'INPUT' && matches(el.value))) continue;
        // Climb to the control that owns this text (MUI: <span> inside <button>).
        let target = el;
        let cur = el;
        for (let i = 0; i < 6 && cur; i++) {
          if (D.isInteractive(cur)) { target = cur; break; }
          let r = null;
          try { r = cur.getRootNode(); } catch {}
          cur = cur.parentElement || (r && r.host) || null;
        }
        if (seen.has(target) || !D.isVisible(target)) continue;
        seen.add(target);
        hits.push({ el: target, interactive: D.isInteractive(target), len: D.clean(own).length });
      }
    }
    // Prefer controls over plain text; then the most specific (shortest) text; keep document order otherwise.
    hits.forEach((h, i) => { h.i = i; });
    hits.sort((a, b) => (b.interactive - a.interactive) || (a.len - b.len) || (a.i - b.i));
    // Drop a candidate that merely contains a better one (wrapper rows).
    const best = hits.filter((h) => !hits.some((o) => o !== h && o.i !== h.i && D.composedContains(h.el, o.el) && o.interactive >= h.interactive));
    if (best.length === 0) return { success: false, error: `No element found with text "${_text}"` };
    if (!Number.isInteger(_index) || _index < 0 || _index >= best.length) {
      return { success: false, error: `Only ${best.length} matches, index ${_index} out of range` };
    }
    const chosen = best[_index].el;
    D.registry.set(_ref, chosen);
    return { success: true, clicked: D.nameOf(chosen).slice(0, 80) || D.composedText(chosen, 80), role: D.roleOf(chosen), matchCount: best.length };
  }, [text, index, exact, tempRef]);
  if (!found || found.success === false) return found;

  // Trusted click on the parked element (same path as browser_click).
  const send = await trustedSender(tabId, trusted);
  if (send) {
    const loc = await locateTarget(tabId, { ref: tempRef });
    if (loc?.success && loc.visible) {
      try {
        await cdpClickAt(send, loc.x, loc.y);
      } finally {
        await releaseShield(tabId);
      }
      return { ...found, input: 'cdp', ...(loc.occludedBy ? { warning: `click point is covered by ${loc.occludedBy}` } : {}) };
    }
    await releaseShield(tabId);
  }

  return execDom(tabId, (_ref, _found) => {
    const D = globalThis.__bcDom;
    if (!D) return { __needDom: true };
    const target = D.registry.get(_ref);
    if (!D.connected(target)) return { success: false, error: 'Element disappeared before the click' };
    target.scrollIntoView({ behavior: 'instant', block: 'center' });
    const rect = target.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const init = { bubbles: true, cancelable: true, composed: true, view: target.ownerDocument.defaultView, clientX: x, clientY: y, button: 0 };
    target.dispatchEvent(new MouseEvent('mouseover', init));
    target.dispatchEvent(new MouseEvent('mousedown', init));
    if (target.focus) target.focus();
    target.dispatchEvent(new MouseEvent('mouseup', init));
    target.dispatchEvent(new MouseEvent('click', init));
    return _found;
  }, [tempRef, found]);
}
