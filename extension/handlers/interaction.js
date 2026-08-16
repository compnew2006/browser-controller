/**
 * Interaction handlers (extracted from background.js): click, type, press_key,
 * hover, select, click_text, dialog, drag, fill_form — the write side that
 * drives the page's event system (synthetic events) or CDP when required.
 */
import { resolveTab, requireTarget, safeExec, getFallback } from '../lib/page-exec.js';
import { autoReSnapshot } from './inspection.js';
import { PAGE_RESOLVE_FALLBACK_FN } from '../utils/smart-selector.js';

export async function handleClick(params) {
  const { tabId, ref, selector, button = 'left', doubleClick = false } = params;
  await resolveTab(tabId);
  requireTarget(params);
  const fb = getFallback(tabId, ref);
  const resolveFallbackSrc = PAGE_RESOLVE_FALLBACK_FN.toString();

  const res = await safeExec(tabId, async (_ref, _sel, _btn, _dbl, _fb, resolveFallbackSrc) => {
    let el = _ref ? document.querySelector(`[data-mcp-ref="${_ref}"]`) : null;
    let via = 'ref';
    if (!el && _sel) { el = document.querySelector(_sel); via = 'selector'; }
    // Rebuild the resolver from its source (chrome.scripting can't serialize fns).
    let resolveFallback = null;
    try { resolveFallback = eval('(' + resolveFallbackSrc + ')'); } catch {}
    // Smart-selector fallback (plan task 3): ref broke → try robust selector,
    // then text+role+tag scan. The agent doesn't request this; it's automatic.
    if (!el && _fb && resolveFallback) { el = resolveFallback(_fb); if (el) via = 'fallback'; }
    if (!el) {
      // Element is gone (likely virtualized away on scroll). Abort WITHOUT
      // clicking — the background auto-re-snapshots and embeds fresh refs.
      return { success: false, error: 'REF_GONE', _ref };
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
      el = _ref ? document.querySelector(`[data-mcp-ref="${_ref}"]`) : el;
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
  }, [ref, selector, button, doubleClick, fb, resolveFallbackSrc]);

  // The page function returns REF_GONE when the element (and all fallbacks)
  // can't be found — typical of virtualized feeds (FB/IG) after scrolling.
  // Auto-re-snapshot and embed fresh refs so the agent retries in ONE step.
  // We do NOT auto-retry the click: it's non-idempotent and the element that
  // re-appears may be a different post after the scroll shifted the feed.
  if (res && res.success === false && res.error === 'REF_GONE') {
    const fresh = await autoReSnapshot(tabId);
    return {
      success: false,
      error: `Element ${res._ref || ref} is gone from the DOM (feed scrolled/virtualized). Fresh refs captured — retry with a new ref.`,
      freshRefs: fresh,
    };
  }
  return res;
}

export async function handleType(params) {
  const { tabId, ref, selector, text, clear = false } = params;
  await resolveTab(tabId);
  requireTarget(params);
  const fb = getFallback(tabId, ref);
  const resolveFallbackSrc = PAGE_RESOLVE_FALLBACK_FN.toString();

  const res = await safeExec(tabId, (_ref, _sel, _text, _clear, _fb, resolveFallbackSrc) => {
    let el = _ref ? document.querySelector(`[data-mcp-ref="${_ref}"]`) : null;
    let via = 'ref';
    if (!el && _sel) { el = document.querySelector(_sel); via = 'selector'; }
    let resolveFallback = null;
    try { resolveFallback = eval('(' + resolveFallbackSrc + ')'); } catch {}
    if (!el && _fb && resolveFallback) { el = resolveFallback(_fb); if (el) via = 'fallback'; }
    if (!el) {
      // Element gone (virtualized feed) — abort WITHOUT typing; background
      // auto-re-snapshots and embeds fresh refs for a one-step retry.
      return { success: false, error: 'REF_GONE', _ref };
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
  }, [ref, selector, text, clear, fb, resolveFallbackSrc]);

  // Virtualization recovery (same as click): type target is gone, so
  // auto-re-snapshot and embed fresh refs. No auto-retry (non-idempotent).
  if (res && res.success === false && res.error === 'REF_GONE') {
    const fresh = await autoReSnapshot(tabId);
    return {
      success: false,
      error: `Element ${res._ref || ref} is gone from the DOM (feed scrolled/virtualized). Fresh refs captured — retry with a new ref.`,
      freshRefs: fresh,
    };
  }
  return res;
}

export async function handlePressKey(params) {
  const { tabId, key, modifiers = [], ref, selector } = params;
  await resolveTab(tabId);

  return safeExec(tabId, (_key, _mods, _ref, _sel) => {
    let target = document.activeElement || document.body;
    // When the caller names a target, an unresolved ref/selector must FAIL —
    // silently falling back to activeElement sent Enter to the wrong control
    // with a success result. (Omitting both is still legitimate: intentional
    // activeElement targeting.)
    if (_ref) {
      const el = document.querySelector(`[data-mcp-ref="${_ref}"]`);
      if (!el) return { success: false, error: `Element with ref ${_ref} not found` };
      el.focus();
      target = el;
    } else if (_sel) {
      const el = document.querySelector(_sel);
      if (!el) return { success: false, error: `Element with selector ${_sel} not found` };
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
  }, [key, modifiers, ref, selector]);
}

export async function handleHover(params) {
  const { tabId, ref, selector } = params;
  await resolveTab(tabId);
  requireTarget(params);

  return safeExec(tabId, (_ref, _sel) => {
    let el = _ref ? document.querySelector(`[data-mcp-ref="${_ref}"]`) : null;
    if (!el && _sel) el = document.querySelector(_sel);
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
  }, [ref, selector]);
}

export async function handleSelect(params) {
  const { tabId, ref, selector, value, label, index } = params;
  await resolveTab(tabId);
  requireTarget(params);
  if (value === undefined && label === undefined && index === undefined) {
    throw new Error('One of value, label, or index is required to pick an option.');
  }

  return safeExec(tabId, (_ref, _sel, _val, _lbl, _idx) => {
    let el = _ref ? document.querySelector(`[data-mcp-ref="${_ref}"]`) : null;
    if (!el && _sel) el = document.querySelector(_sel);
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
  }, [ref, selector, value, label, index]);
}

export async function handleClickByText(params) {
  const { tabId, text, index = 0, exact = false } = params;
  await resolveTab(tabId);

  return safeExec(tabId, (_text, _index, _exact) => {
    const textLower = _text.toLowerCase();
    const candidates = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let node;
    while ((node = walker.nextNode())) {
      const s = getComputedStyle(node);
      if (s.display === 'none' || s.visibility === 'hidden') continue;
      const r = node.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;

      const nodeText = (node.innerText || node.textContent || '').trim();
      const firstLine = nodeText.split('\n')[0].trim();
      const match = _exact
        ? firstLine === _text
        : firstLine.toLowerCase().includes(textLower);

      if (match) {
        candidates.push({ el: node, text: firstLine, depth: getDepth(node) });
      }
    }

    function getDepth(el) { let d = 0; let p = el; while ((p = p.parentElement)) d++; return d; }

    candidates.sort((a, b) => b.depth - a.depth);

    if (candidates.length === 0) return { success: false, error: `No element found with text "${_text}"` };
    // Guard the full range: a negative index used to read candidates[-1] and
    // crash with a raw TypeError (schema bounds only protect MCP callers).
    if (!Number.isInteger(_index) || _index < 0 || _index >= candidates.length) {
      return { success: false, error: `Only ${candidates.length} matches, index ${_index} out of range` };
    }

    const target = candidates[_index].el;
    target.scrollIntoView({ behavior: 'instant', block: 'center' });
    const rect = target.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const init = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 };

    target.dispatchEvent(new MouseEvent('mouseover', init));
    target.dispatchEvent(new MouseEvent('mousedown', init));
    if (target.focus) target.focus();
    target.dispatchEvent(new MouseEvent('mouseup', init));
    target.dispatchEvent(new MouseEvent('click', init));

    return { success: true, clicked: candidates[_index].text, matchCount: candidates.length };
  }, [text, index, exact]);
}

export async function handleDialog(params) {
  const { tabId, action = 'accept', promptText } = params;
  await resolveTab(tabId);

  // MAIN world is the whole point: the overrides must replace the PAGE's
  // window.alert/confirm/prompt. In the default ISOLATED world the page never
  // sees them, real dialogs keep blocking, and the tool is a no-op. State
  // (__mcpDialogLog / __mcpDialogOverrides) also lives in the page context, so
  // repeat calls read what the page actually invoked. (handleEvaluate uses
  // world:'MAIN' for the same reason.)
  return safeExec(tabId, (_action, _promptText) => {
    window.__mcpDialogLog = window.__mcpDialogLog || [];
    window.__mcpDialogAction = _action;
    window.__mcpDialogPromptText = _promptText || '';

    if (!window.__mcpDialogOverrides) {
      window.__mcpDialogOverrides = true;

      window.alert = function (msg) {
        window.__mcpDialogLog.push({ type: 'alert', message: String(msg), timestamp: Date.now(), handled: window.__mcpDialogAction });
      };

      window.confirm = function (msg) {
        const accepted = window.__mcpDialogAction === 'accept';
        window.__mcpDialogLog.push({ type: 'confirm', message: String(msg), timestamp: Date.now(), result: accepted });
        return accepted;
      };

      window.prompt = function (msg, def) {
        const accepted = window.__mcpDialogAction === 'accept';
        const text = accepted ? (window.__mcpDialogPromptText || def || '') : null;
        window.__mcpDialogLog.push({ type: 'prompt', message: String(msg), timestamp: Date.now(), result: text });
        return accepted ? text : null;
      };
    }

    const log = [...window.__mcpDialogLog];
    window.__mcpDialogLog = [];
    return { success: true, dialogs: log, message: log.length ? 'Retrieved dialog history' : 'Overrides configured' };
  }, [action, promptText], { world: 'MAIN' });
}

export async function handleDrag(params) {
  const { tabId, startRef, startSelector, endRef, endSelector, startX, startY, endX, endY } = params;
  // Guard for direct-WS callers (the zod schema only protects MCP callers):
  // steps=0/negative skipped every mouseMoved and teleported the cursor.
  const steps = Math.max(1, Number.isInteger(params.steps) ? params.steps : 10);
  const tab = await resolveTab(tabId);

  let sx = startX, sy = startY, ex = endX, ey = endY;

  if (sx == null || sy == null || ex == null || ey == null) {
    const coords = await safeExec(tabId, (_sRef, _sSel, _eRef, _eSel) => {
      function find(ref, sel) {
        let el = ref ? document.querySelector(`[data-mcp-ref="${ref}"]`) : null;
        if (!el && sel) el = document.querySelector(sel);
        if (!el) return null;
        el.scrollIntoView({ behavior: 'instant', block: 'center' });
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
      return { start: find(_sRef, _sSel), end: find(_eRef, _eSel) };
    }, [startRef, startSelector, endRef, endSelector]);

    if (coords.start) { sx = coords.start.x; sy = coords.start.y; }
    if (coords.end) { ex = coords.end.x; ey = coords.end.y; }
  }

  if (sx == null || sy == null || ex == null || ey == null) {
    throw new Error('Could not determine drag coordinates. Provide refs/selectors or explicit x,y coordinates.');
  }

  // drag stays on CDP (Input.dispatchMouseEvent is CDP-only).
  await chrome.debugger.attach({ tabId: tab.id }, '1.3');
  try {
    await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchMouseEvent', {
      type: 'mousePressed', x: sx, y: sy, button: 'left', clickCount: 1,
    });

    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(sx + (ex - sx) * t),
        y: Math.round(sy + (ey - sy) * t),
        button: 'left',
      });
    }

    await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: ex, y: ey, button: 'left', clickCount: 1,
    });

    return { success: true, from: { x: sx, y: sy }, to: { x: ex, y: ey } };
  } finally {
    try { await chrome.debugger.detach({ tabId: tab.id }); } catch {}
  }
}

export async function handleFillForm(params) {
  const { tabId, fields, submit } = params;
  if (!fields || !Array.isArray(fields) || fields.length === 0) {
    throw new Error('fields array is required');
  }
  await resolveTab(tabId);

  return safeExec(tabId, (_fields, _submit) => {
    // Same native-prototype setter as handleType: React/Vue controlled inputs
    // ignore a plain `el.value =` assignment, which is the main use case for a
    // bulk-fill tool.
    const setNativeValue = (target, nextValue) => {
      const prototype = target instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (setter) setter.call(target, nextValue);
      else target.value = nextValue;
    };
    const results = [];
    let containingForm = null;
    for (const field of _fields) {
      const { ref, selector, value, clear } = field;
      let el = ref ? document.querySelector(`[data-mcp-ref="${ref}"]`) : null;
      if (!el && selector) el = document.querySelector(selector);
      if (!el) {
        results.push({ selector: selector || ref, success: false, error: 'Not found' });
        continue;
      }

      el.focus();
      if (el.form && !containingForm) containingForm = el.form;

      if (clear !== false) {
        if (el.isContentEditable) {
          el.textContent = '';
        } else {
          setNativeValue(el, '');
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }

      if (el.tagName === 'SELECT') {
        const opt = Array.from(el.options).find((o) => o.value === String(value));
        if (!opt) {
          results.push({ selector: selector || ref, success: false, error: `Option "${value}" not found` });
          continue;
        }
        setNativeValue(el, String(value));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (el.type === 'checkbox' || el.type === 'radio') {
        // The schema allows strings — coerce strictly, or value:"false" would
        // check the box (!! "false" === true).
        const checked = value === true || value === 'true';
        if (el.checked !== checked) el.click();
      } else if (el.isContentEditable) {
        document.execCommand('insertText', false, value);
      } else {
        setNativeValue(el, String(value));
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }

      el.dispatchEvent(new Event('change', { bubbles: true }));
      results.push({ selector: selector || ref, success: true, value });
    }

    if (_submit) {
      // Submit the form the filled fields BELONG to (el.form), not the first
      // <form> on the page — multi-form pages would otherwise submit the
      // wrong one. Fall back to the first form only when no filled field had
      // an associated form (e.g. all contentEditable).
      const form = containingForm || document.querySelector('form');
      if (form) {
        const submitBtn = form.querySelector('[type="submit"]') || form.querySelector('button:not([type="button"])');
        if (submitBtn) submitBtn.click();
        else form.submit();
      }
    }

    const failed = results.filter((r) => !r.success).length;
    return failed === 0
      ? { success: true, fields: results }
      : { success: false, error: `${failed} of ${results.length} fields failed`, fields: results };
  }, [fields, submit]);
}
