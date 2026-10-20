/**
 * Interaction handlers (extracted from background.js): click, type, press_key,
 * hover, select, click_text, dialog, drag, fill_form — the write side that
 * drives the page's event system (synthetic events) or CDP when required.
 */
import { resolveTab, requireTarget, hasPoint, execDom, getFallback } from '../lib/page-exec.js';
import { autoReSnapshot } from './inspection.js';
import { refErrorMessage, selectorErrorMessage } from '../lib/ref-errors.js';
import { trustedSender, locateTarget, locatePointer, releaseShield, cdpClickAt, cdpKeyPress, cdpTypeText, modifierBits, pointInfo, cursorTo, sleep, isBlockedError } from '../lib/trusted-input.js';

export { handleDialog, handleDrag, handleFillForm } from './interaction-advanced.js';
export { handlePressKey, parseKeyCombo } from './interaction-keys.js';

/**
 * The one stale-ref answer for every ref tool. REF_GONE: the ref was issued on
 * this page but its element is gone (virtualized, re-rendered, navigated).
 * REF_NOT_FOUND: no record of the ref on this page (mistyped, or from an old
 * snapshot). With a last known name, `freshRefs` lists at most 5 look-alike refs
 * from a new snapshot; without one, the message says to take a new snapshot.
 */
async function refGone(tabId, res, ref, selector) {
  // A selector that matches nothing is usually the wrong page (navigation,
  // postback), not a virtualized feed — say which locator failed.
  if (!(res._ref || ref) && selector) {
    return { success: false, error: selectorErrorMessage(selector, res.url) };
  }
  const missing = res._ref || ref;
  const known = getFallback(tabId, missing);
  const name = known ? (known.text || '') : '';
  const fresh = name ? await autoReSnapshot(tabId, { name, role: known.role || '' }) : null;
  return {
    success: false,
    error: refErrorMessage(missing, known),
    ...(fresh && fresh.refs.length ? { freshRefs: fresh.refs } : {}),
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
  const info = await pointInfo(tabId, x, y, 'click', clickCountOf(params));
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
  // focus moves, default actions run and the page sees isTrusted:true. The
  // agent cursor glides there first so a person can follow the click.
  const send = await trustedSender(tabId, trusted);
  if (send && BUTTONS.has(button)) {
    const loc = await locatePointer(tabId, { ref, selector, fb }, 'click', clickCountOf(params));
    if (loc && loc.success === false && loc.error === 'REF_GONE') return refGone(tabId, loc, ref, selector);
    // Hidden, disabled or covered: nothing is clicked, and the failure says why.
    if (loc && loc.success === false && isBlockedError(loc.error)) {
      await releaseShield(tabId);
      return { success: false, error: loc.error };
    }
    if (loc?.success && loc.visible) {
      try {
        await cdpClickAt(send, loc.x, loc.y, { button, clickCount: clickCountOf(params), modifiers: clickModifiers(params) });
      } finally {
        await releaseShield(tabId);
      }
      return {
        success: true,
        input: 'cdp',
        at: { x: Math.round(loc.x), y: Math.round(loc.y) },
        ...(loc.via ? { via: loc.via } : {}),
      };
    }
    await releaseShield(tabId);
  }

  // The synthetic path below runs the same checks (lib/page-dom.js clickTarget)
  // before dispatching anything. Errors thrown here come back as SCRIPT_ERROR
  // (async body, so they are reported in-band).
  const res = await execDom(tabId, async (_ref, _sel, _btn, _dbl, _fb) => {
    try {
      const D = globalThis.__bcDom;
      if (!D || !D.clickTarget) return { __needDom: true };

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

      // Hidden, disabled or covered: nothing is dispatched. A checkbox hidden under
      // its visible label is clicked on that label, as a person's click would be.
      const aim = D.clickTarget(el);
      if (aim.message) return { success: false, error: aim.message };
      const target = aim.node;
      // Event coordinates are the target's own (frame-local) viewport point; aim.x/y
      // is the top-level point, reported as `at`.
      const box = target.getBoundingClientRect();
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      const btnVal = _btn === 'left' ? 0 : _btn === 'right' ? 2 : 1;
      const init = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: btnVal };

      target.dispatchEvent(new MouseEvent('mouseover', init));
      target.dispatchEvent(new MouseEvent('mousedown', init));
      if (el.focus) el.focus();
      target.dispatchEvent(new MouseEvent('mouseup', init));
      target.dispatchEvent(new MouseEvent('click', init));

      // A real right-click opens the context menu via a contextmenu event —
      // mousedown/mouseup/click alone never trigger it.
      if (_btn === 'right') {
        target.dispatchEvent(new MouseEvent('contextmenu', init));
      }

      if (_dbl) {
        target.dispatchEvent(new MouseEvent('mousedown', init));
        target.dispatchEvent(new MouseEvent('mouseup', init));
        target.dispatchEvent(new MouseEvent('click', init));
        target.dispatchEvent(new MouseEvent('dblclick', init));
      }

      // Top-level viewport point (iframe offsets added), like the trusted path reports.
      return {
        success: true,
        at: { x: Math.round(aim.x), y: Math.round(aim.y) },
        ...(aim.via ? { via: aim.via } : via !== 'ref' ? { via } : {}),
      };
    } catch (e) {
      return { __bcScriptError: String((e && e.message) || e) };
    }
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
        if (!loc.focused) {
          await sleep(await cursorTo(tabId, loc.x, loc.y, 'click'));
          await cdpClickAt(send, loc.x, loc.y);
        }
        if (clear && loc.needsSelectAll) await cdpKeyPress(send, 'a', ['ctrl']);
        if (clear && loc.hasText && !text) await cdpKeyPress(send, 'Backspace');
        await cdpTypeText(send, text);
      } finally {
        after = await releaseShield(tabId);
      }
      // Short result: how much was typed, and what the targeted field now holds.
      return {
        success: true,
        typed: text.length,
        input: 'cdp',
        ...(after?.value != null ? { value: after.value } : {}),
        ...(loc.via ? { via: loc.via } : {}),
      };
    }
    await releaseShield(tabId);
  }

  // Synthetic path: a user-like sequence per character (keydown, keypress —
  // which a mask may cancel —, the insert, input, keyup), `change` only when
  // focus leaves the field, and targets inside same-origin frames too.
  const res = await execDom(tabId, (_ref, _sel, _text, _clear, _fb) => {
    const D = globalThis.__bcDom;
    if (!D) return { __needDom: true };
    const bare = (n) => !n || n.tagName === 'BODY' || n.tagName === 'HTML';

    let found;
    if (!_ref && !_sel) {
      // Focus may sit inside a same-origin iframe: follow it down (like pageLocate).
      let a = document.activeElement;
      for (let i = 0; a && i < 10; i++) {
        const s = D.shadowOf(a);
        if (s && s.activeElement) { a = s.activeElement; continue; }
        const d = D.frameDoc(a);
        if (d && d.activeElement) { a = d.activeElement; continue; }
        break;
      }
      if (bare(a)) return { success: false, error: 'No field has focus: pass ref/selector, or click the field first.' };
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
    const currentValue = () => (el.isContentEditable ? el.textContent : (el.value ?? ''));

    // The setter of the element's OWN realm: an iframe's <textarea> is not an
    // HTMLTextAreaElement of this window, so the page's prototype would throw.
    const setNativeValue = (target, nextValue) => {
      let setter = null;
      for (let p = Object.getPrototypeOf(target); p && !setter; p = Object.getPrototypeOf(p)) {
        setter = Object.getOwnPropertyDescriptor(p, 'value')?.set || null;
      }
      if (setter) setter.call(target, nextValue);
      else target.value = nextValue;
    };
    // Legacy key codes too: input masks branch on keyCode/charCode, not only on key.
    const keyEvent = (type, ch) => {
      const ev = new KeyboardEvent(type, { key: ch, bubbles: true, cancelable: true });
      const code = ch.length === 1 ? ch.charCodeAt(0) : 0;
      const keyCode = type === 'keydown' ? ch.toUpperCase().charCodeAt(0) : code;
      for (const [k, v] of [['keyCode', keyCode], ['which', keyCode], ['charCode', type === 'keypress' ? code : 0]]) {
        try { Object.defineProperty(ev, k, { get: () => v }); } catch { /* read-only in this engine */ }
      }
      return ev;
    };

    const startValue = currentValue();
    if (_clear) {
      if (el.isContentEditable) el.textContent = '';
      else setNativeValue(el, '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }

    if (el.isContentEditable) {
      el.ownerDocument.execCommand('insertText', false, _text);
    } else {
      for (const ch of _text) {
        const proceed = el.dispatchEvent(keyEvent('keydown', ch));
        if (proceed && el.dispatchEvent(keyEvent('keypress', ch))) {
          // Insert at the caret, as the browser does; a mask that rewrites the
          // value in its input handler is seen by the next character.
          const value = el.value ?? '';
          const start = typeof el.selectionStart === 'number' ? el.selectionStart : value.length;
          const end = typeof el.selectionEnd === 'number' ? el.selectionEnd : start;
          setNativeValue(el, value.slice(0, start) + ch + value.slice(end));
          if (typeof el.setSelectionRange === 'function') {
            try { el.setSelectionRange(start + 1, start + 1); } catch { /* not a text field */ }
          }
          const input = typeof InputEvent === 'function'
            ? new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' })
            : new Event('input', { bubbles: true });
          el.dispatchEvent(input);
        }
        el.dispatchEvent(keyEvent('keyup', ch));
      }
    }

    // `change` belongs to the commit (focus leaving the field), as for a person.
    if (typeof el.addEventListener === 'function') {
      if (el.__bcBlurCommit) el.removeEventListener('blur', el.__bcBlurCommit);
      el.__bcBlurCommit = () => {
        el.__bcBlurCommit = null;
        if (currentValue() !== startValue) el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      el.addEventListener('blur', el.__bcBlurCommit, { once: true });
    }
    return { success: true, typed: _text.length, ...(via !== 'ref' ? { via } : {}), value: String(currentValue() ?? '').slice(0, 100) };
  }, [ref, selector, text, clear, fb]);

  // Virtualization recovery (same as click): type target is gone, so
  // auto-re-snapshot and embed fresh refs. No auto-retry (non-idempotent).
  if (res && res.success === false && res.error === 'REF_GONE') return refGone(tabId, res, ref, selector);
  return res;
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
    const loc = await locatePointer(tabId, { ref, selector, fb }, 'move');
    if (loc?.success && loc.visible) {
      try {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: loc.x, y: loc.y });
      } finally {
        await releaseShield(tabId);
      }
      return { success: true, input: 'cdp' };
    }
    await releaseShield(tabId);
    if (loc && loc.success === false) {
      return loc.error === 'REF_GONE' ? refGone(tabId, loc, ref, selector) : { success: false, error: loc.error };
    }
  }

  const res = await execDom(tabId, (_ref, _sel, _fb) => {
    const D = globalThis.__bcDom;
    if (!D) return { __needDom: true };

    const found = D.resolve(_ref, _sel, _fb);
    if (found.error === 'INVALID_SELECTOR') return { success: false, error: `Invalid CSS selector: ${_sel}` };
    const el = found.el || null;
    if (!el) return { success: false, error: 'REF_GONE', url: location.href };

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
  if (res?.error === 'REF_GONE') return refGone(tabId, res, ref, selector);
  // Not a failure, but not a :hover either: synthetic events run the page's JS
  // hover handlers (menus open) and never apply CSS :hover. Say so.
  return res?.success
    ? { ...res, input: 'synthetic', trusted: false, note: 'CSS :hover was not applied (no debugger); only JS mouseenter/mouseover handlers ran.' }
    : res;
}

export async function handleSelect(params) {
  const { tabId, ref, selector, value, label, index } = params;
  await resolveTab(tabId);
  requireTarget(params);
  if (value === undefined && label === undefined && index === undefined) {
    throw new Error('One of value, label, or index is required to pick an option.');
  }
  const fb = getFallback(tabId, ref);

  const res = await execDom(tabId, (_ref, _sel, _val, _lbl, _idx, _fb) => {
    const D = globalThis.__bcDom;
    if (!D) return { __needDom: true };

    const found = D.resolve(_ref, _sel, _fb);
    if (found.error === 'INVALID_SELECTOR') return { success: false, error: `Invalid CSS selector: ${_sel}` };
    const el = found.el || null;
    if (!el) return { success: false, error: 'REF_GONE', url: location.href };
    if (el.tagName !== 'SELECT') return { success: false, error: 'Not a select element' };

    // A pick that matches nothing is a failure, never a silent no-op: list what exists.
    const options = Array.from(el.options);
    const labelOf = (o) => D.clean(o.textContent);
    const available = () => {
      const shown = options.slice(0, 5).map(labelOf).join(' | ');
      return `available: ${shown}${options.length > 5 ? ` | ... (${options.length} in total)` : ''}`;
    };
    let index = -1;
    if (_val !== null) {
      index = options.findIndex((o) => o.value === _val);
      if (index < 0) return { success: false, error: `OPTION_NOT_FOUND: no option with value "${_val}" (${available()})` };
    } else if (_lbl !== null) {
      // Labels match case-insensitively, like browser_fill_form.
      const want = D.clean(_lbl).toLowerCase();
      index = options.findIndex((o) => labelOf(o).toLowerCase() === want);
      if (index < 0) return { success: false, error: `OPTION_NOT_FOUND: no option labelled "${_lbl}" (${available()})` };
    } else if (_idx !== null) {
      if (!(_idx >= 0 && _idx < options.length)) return { success: false, error: `OPTION_NOT_FOUND: index ${_idx} is out of range (${options.length} options)` };
      index = _idx;
    }
    el.selectedIndex = index;

    // Same order as a person's pick: the input event first, then change.
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { success: true, selected: el.value };
  }, [ref, selector, value, label, index, fb]);
  if (res?.error === 'REF_GONE') return refGone(tabId, res, ref, selector);
  return res;
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
    // Drop a candidate that merely contains a better one (wrapper rows): a hit is
    // dropped when a hit inside it is at least as "interactive". One upward walk
    // from every hit marks its ancestors, so this is linear (2,000 matches: ms).
    const parentOf = (n) => {
      if (n.parentElement) return n.parentElement;
      let r = null;
      try { r = n.getRootNode(); } catch {}
      if (r && r.host) return r.host;
      return (r && r.nodeType === 9 && r.defaultView && r.defaultView.frameElement) || null;
    };
    const containsAny = new Set();     // elements that hold some other hit
    const containsControl = new Set(); // elements that hold some other interactive hit
    const markAncestors = (set, from) => {
      for (let a = parentOf(from); a && !set.has(a); a = parentOf(a)) set.add(a);
    };
    for (const h of hits) {
      markAncestors(containsAny, h.el);
      if (h.interactive) markAncestors(containsControl, h.el);
    }
    const best = hits.filter((h) => !(h.interactive ? containsControl : containsAny).has(h.el));
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
    const loc = await locatePointer(tabId, { ref: tempRef }, 'click');
    if (loc && loc.success === false && isBlockedError(loc.error)) {
      await releaseShield(tabId);
      return { success: false, error: loc.error };
    }
    if (loc?.success && loc.visible) {
      try {
        await cdpClickAt(send, loc.x, loc.y);
      } finally {
        await releaseShield(tabId);
      }
      return {
        ...found,
        input: 'cdp',
        at: { x: Math.round(loc.x), y: Math.round(loc.y) },
        ...(loc.via ? { via: loc.via } : {}),
      };
    }
    await releaseShield(tabId);
  }

  return execDom(tabId, (_ref, _found) => {
    const D = globalThis.__bcDom;
    if (!D || !D.clickTarget) return { __needDom: true };
    const target = D.registry.get(_ref);
    if (!D.connected(target)) return { success: false, error: 'Element disappeared before the click' };
    target.scrollIntoView({ behavior: 'instant', block: 'center' });
    // Same actionability as browser_click (a label-hidden control is clicked on its label).
    const aim = D.clickTarget(target);
    if (aim.message) return { success: false, error: aim.message };
    const node = aim.node;
    const box = node.getBoundingClientRect(); // frame-local event point; aim.x/y is top-level
    const init = { bubbles: true, cancelable: true, composed: true, view: target.ownerDocument.defaultView, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2, button: 0 };
    node.dispatchEvent(new MouseEvent('mouseover', init));
    node.dispatchEvent(new MouseEvent('mousedown', init));
    if (target.focus) target.focus();
    node.dispatchEvent(new MouseEvent('mouseup', init));
    node.dispatchEvent(new MouseEvent('click', init));
    return { ..._found, at: { x: Math.round(aim.x), y: Math.round(aim.y) }, ...(aim.via ? { via: aim.via } : {}) };
  }, [tempRef, found]);
}
