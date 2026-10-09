/**
 * Advanced interaction handlers that rely on the debugger API or multi-field
 * orchestration. Kept separate from the common pointer/keyboard handlers so
 * each module stays focused and reviewable.
 */
import { resolveTab, safeExec, execDom, getFallback } from '../lib/page-exec.js';
import { withCdp } from '../lib/cdp-session.js';
import { openShield, releaseShield, cursorTo, sleep } from '../lib/trusted-input.js';

export async function handleDialog(params) {
  const { tabId, action = 'accept', promptText } = params;
  const tab = await resolveTab(tabId);

  // An ALREADY-OPEN native dialog freezes the page's JS thread — overrides
  // can't help in that state. CDP handles it out-of-band, so try it first.
  try {
    return await withCdp(tab.id, async (send) => {
      await send('Page.enable');
      await send('Page.handleJavaScriptDialog', {
        accept: action === 'accept',
        promptText: promptText || '',
      });
      return { success: true, handled: 'open-dialog', action };
    });
  } catch {
    // No dialog showing (or debugger unavailable) — arm future overrides.
  }

  // MAIN world is required: the page must see the overridden dialog methods.
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
  // Direct WebSocket callers bypass the MCP schema, so clamp invalid steps.
  const steps = Math.max(1, Number.isInteger(params.steps) ? params.steps : 10);
  const tab = await resolveTab(tabId);

  let sx = startX, sy = startY, ex = endX, ey = endY;
  if (sx == null || sy == null || ex == null || ey == null) {
    const coords = await execDom(tabId, (_sRef, _sSel, _eRef, _eSel, _sFb, _eFb) => {
      const D = globalThis.__bcDom;
      if (!D) return { __needDom: true };
      function find(ref, selector, fb) {
        if (!ref && !selector) return null;
        const el = D.resolve(ref, selector, fb).el;
        if (!el) return null;
        el.scrollIntoView({ behavior: 'instant', block: 'center' });
        const { x, y } = D.centerOf(el);
        return { x, y };
      }
      return { start: find(_sRef, _sSel, _sFb), end: find(_eRef, _eSel, _eFb) };
    }, [startRef, startSelector, endRef, endSelector, getFallback(tabId, startRef), getFallback(tabId, endRef)]);

    if (coords.start) { sx = coords.start.x; sy = coords.start.y; }
    if (coords.end) { ex = coords.end.x; ey = coords.end.y; }
  }

  if (sx == null || sy == null || ex == null || ey == null) {
    throw new Error('Could not determine drag coordinates. Provide refs/selectors or explicit x,y coordinates.');
  }

  await openShield(tab.id);
  // The agent cursor glides to the start and presses in…
  await sleep(await cursorTo(tab.id, sx, sy, 'down'));
  return withCdp(tab.id, async (send) => {
    await send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: sx, y: sy, button: 'left', clickCount: 1,
    });
    // …then carries the drag: the moves are spread over its glide to the end,
    // paced by the clock so CDP round-trips don't let the cursor run ahead.
    const glideMs = await cursorTo(tab.id, ex, ey, 'up');
    const t0 = Date.now();
    for (let i = 1; i <= steps; i++) {
      if (glideMs) await sleep(t0 + (glideMs * i) / steps - Date.now());
      const progress = i / steps;
      await send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(sx + (ex - sx) * progress),
        y: Math.round(sy + (ey - sy) * progress),
        button: 'left',
      });
    }
    await send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: ex, y: ey, button: 'left', clickCount: 1,
    });
    return { success: true, from: { x: sx, y: sy }, to: { x: ex, y: ey } };
  }).finally(() => releaseShield(tab.id));
}

export async function handleFillForm(params) {
  const { tabId, fields, submit } = params;
  if (!fields || !Array.isArray(fields) || fields.length === 0) {
    throw new Error('fields array is required');
  }
  await resolveTab(tabId);

  // Attach each ref's snapshot descriptor so stale refs re-resolve (verified) in the page.
  const withFb = fields.map((f) => (f && f.ref ? { ...f, fb: getFallback(tabId, f.ref) } : f));

  return execDom(tabId, (_fields, _submit) => {
    const D = globalThis.__bcDom;
    if (!D) return { __needDom: true };

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
      const { ref, selector, value, clear, fb } = field;
      const el = D.resolve(ref, selector, fb).el;
      if (!el) {
        results.push({ selector: selector || ref, success: false, error: 'Not found' });
        continue;
      }

      el.focus();
      if (el.form && !containingForm) containingForm = el.form;
      const isChoice = el.tagName === 'SELECT' || el.type === 'checkbox' || el.type === 'radio';
      if (clear !== false && !isChoice) {
        if (el.isContentEditable) el.textContent = '';
        else setNativeValue(el, '');
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }

      if (el.tagName === 'SELECT') {
        // Match the option's value first, then its visible label.
        const want = String(value);
        const options = Array.from(el.options);
        const option = options.find((candidate) => candidate.value === want)
          || options.find((candidate) => candidate.textContent.trim() === want.trim())
          || options.find((candidate) => candidate.textContent.trim().toLowerCase() === want.trim().toLowerCase());
        if (!option) {
          results.push({ selector: selector || ref, success: false, error: `Option "${value}" not found` });
          continue;
        }
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
        if (setter) setter.call(el, option.value); else el.value = option.value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } else if (el.type === 'checkbox' || el.type === 'radio') {
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
      const form = containingForm || document.querySelector('form');
      if (form) {
        const submitButton = form.querySelector('[type="submit"]') || form.querySelector('button:not([type="button"])');
        if (submitButton) submitButton.click();
        else form.submit();
      }
    }

    const failed = results.filter((result) => !result.success).length;
    return failed === 0
      ? { success: true, fields: results }
      : { success: false, error: `${failed} of ${results.length} fields failed`, fields: results };
  }, [withFb, submit]);
}
