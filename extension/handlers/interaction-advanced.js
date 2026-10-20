/**
 * Advanced interaction handlers that rely on the debugger API or multi-field
 * orchestration. Kept separate from the common pointer/keyboard handlers so
 * each module stays focused and reviewable.
 */
import { resolveTab, execDom, getFallback } from '../lib/page-exec.js';
import { withCdp, getOpenDialog, clearOpenDialog, sendAttached, settleWithin, TIMED_OUT } from '../lib/cdp-session.js';
import { openShield, releaseShield, cursorTo, sleep } from '../lib/trusted-input.js';
import { refErrorMessage, selectorErrorMessage } from '../lib/ref-errors.js';

/** One answer to a dialog. A page that never accepts it returns TIMEOUT instead of holding the tab. */
const DIALOG_ANSWER_MS = 3_000;

/**
 * handle_dialog: answers the JavaScript dialog open on the tab, over the tab's
 * debugger session. The session records each dialog as it opens (cdp-session
 * enables Page at attach), and that record says what is open. With nothing
 * recorded the answer is still tried once over the existing attachment: a record
 * can be lost while Chrome keeps the attachment (service-worker restart). No page
 * code runs, and no debugger is attached just to look for a dialog.
 */
export async function handleDialog(params) {
  const { tabId, action = 'accept', promptText } = params;
  const tab = await resolveTab(tabId);
  const recorded = getOpenDialog(tab.id);

  let answer;
  try {
    answer = await settleWithin(
      sendAttached(tab.id, 'Page.handleJavaScriptDialog', { accept: action === 'accept', promptText: promptText || '' }),
      DIALOG_ANSWER_MS,
    );
  } catch (err) {
    if (/no dialog is showing|not attached/i.test(String(err?.message || err))) {
      clearOpenDialog(tab.id);
      return { success: false, error: `NO_DIALOG: Chrome has no dialog to answer on tab ${tab.id}. A dialog that opened before a debugger session was attached to this tab is out of reach: Chrome answers only the session that saw it open.` };
    }
    throw err;
  }
  if (answer === TIMED_OUT) {
    return { success: false, error: `TIMEOUT: the dialog was not answered within ${DIALOG_ANSWER_MS}ms; it may still be open.` };
  }
  clearOpenDialog(tab.id);
  return { success: true, handled: true, action, type: recorded?.type ?? null, message: recorded?.message ?? null };
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
      const find = (ref, selector, fb) => (ref || selector ? D.resolve(ref, selector, fb).el || null : null);
      const inView = (point) => point.x >= 0 && point.y >= 0
        && point.x <= globalThis.innerWidth && point.y <= globalThis.innerHeight;
      const reveal = (el) => el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
      const sEl = find(_sRef, _sSel, _sFb);
      const eEl = find(_eRef, _eSel, _eFb);
      if (!sEl || !eEl) return { start: null, end: null };
      // Both points are measured after the last scroll: scrolling to one point
      // can move the other out of view, so a point measured earlier is stale.
      reveal(sEl);
      let start = D.centerOf(sEl);
      let end = D.centerOf(eEl);
      if (inView(start) && inView(end)) return { start, end };
      reveal(eEl);
      start = D.centerOf(sEl);
      end = D.centerOf(eEl);
      if (inView(start) && inView(end)) return { start, end };
      // Neither scroll order keeps both points in the viewport at once.
      return { start: null, end: null, offscreen: true };
    }, [startRef, startSelector, endRef, endSelector, getFallback(tabId, startRef), getFallback(tabId, endRef)]);

    if (coords?.offscreen) {
      return {
        success: false,
        error: 'TARGET_OFFSCREEN: the drop target cannot be scrolled into the viewport together with the drag source; move one closer or drag in steps.',
      };
    }
    if (coords?.start) { sx = coords.start.x; sy = coords.start.y; }
    if (coords?.end) { ex = coords.end.x; ey = coords.end.y; }
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
  const tab = await resolveTab(tabId);

  // Attach each ref's snapshot descriptor so stale refs re-resolve (verified) in the page.
  const withFb = fields.map((f) => (f && f.ref ? { ...f, fb: getFallback(tabId, f.ref) } : f));

  const res = await execDom(tabId, (_fields, _submit) => {
    const D = globalThis.__bcDom;
    if (!D) return { __needDom: true };

    // The value setter of the element's OWN realm: an element of a same-origin
    // iframe is not an HTMLInputElement of this window, so the top window's
    // prototype setter would throw. Same walk as browser_type's synthetic path.
    const setNativeValue = (target, nextValue) => {
      let setter = null;
      for (let p = Object.getPrototypeOf(target); p && !setter; p = Object.getPrototypeOf(p)) {
        setter = Object.getOwnPropertyDescriptor(p, 'value')?.set || null;
      }
      if (setter) setter.call(target, nextValue);
      else target.value = nextValue;
    };
    // A form's default submit control, as implicit submission picks it.
    const SUBMITTER = 'button:not([type]):not(:disabled), button[type="submit"]:not(:disabled), '
      + 'input[type="submit"]:not(:disabled), input[type="image"]:not(:disabled)';
    /**
     * Submit through the form's own submit path (requestSubmit: validation and
     * submit handlers run). Returns true only when the submit event fired, so a
     * form blocked by constraint validation is reported as not submitted.
     */
    const submitForm = (form) => {
      let fired = false;
      const onSubmit = () => { fired = true; };
      form.addEventListener('submit', onSubmit);
      try {
        const submitter = form.querySelector(SUBMITTER);
        if (typeof form.requestSubmit === 'function') {
          if (submitter) form.requestSubmit(submitter);
          else form.requestSubmit();
        } else if (submitter) {
          submitter.click();
        }
      } finally {
        form.removeEventListener('submit', onSubmit);
      }
      return fired;
    };

    // The element a field names, or why not: NO_TARGET (neither ref nor selector),
    // REF_GONE (a ref that is stale or was never issued here; the extension words
    // it), INVALID_SELECTOR, or NO_MATCH (a selector that matches nothing).
    const resolveField = (field) => {
      if (!field || !(field.ref || field.selector)) return { el: null, error: 'NO_TARGET' };
      const found = D.resolve(field.ref, field.selector, field.fb);
      if (found.el) return found;
      if (field.ref) return { el: null, error: 'REF_GONE' };
      return { el: null, error: found.error === 'INVALID_SELECTOR' ? 'INVALID_SELECTOR' : 'NO_MATCH' };
    };
    // The form every field belongs to, decided before typing anything, so a
    // submit that cannot target one form is refused with no side effects.
    let formToSubmit = null;
    if (_submit) {
      const owners = [...new Set(_fields.map((f) => resolveField(f).el).filter(Boolean).map((el) => el.form || null))];
      if (owners.length > 1) {
        return { success: false, error: 'FORM_AMBIGUOUS: the fields belong to several forms, so there is no single form to submit; nothing was filled.' };
      }
      if (owners.length === 1 && owners[0] === null) {
        return { success: false, error: 'NO_FORM: none of the fields is inside a <form>, so there is nothing to submit; nothing was filled.' };
      }
      formToSubmit = owners[0] ?? null;
    }

    const results = [];
    for (const field of _fields) {
      const { ref, selector, value, clear } = field;
      // Resolved as each field is reached: filling one field may re-render another.
      const { el, error } = resolveField(field);
      if (!el) {
        results.push({ selector: selector || ref, success: false, error });
        continue;
      }

      el.focus();
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
        setNativeValue(el, option.value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } else if (el.type === 'checkbox' || el.type === 'radio') {
        const checked = value === true || value === 'true';
        if (el.checked !== checked) el.click();
      } else if (el.isContentEditable) {
        // The element's own document: an iframe's editor is not in the top document.
        el.ownerDocument.execCommand('insertText', false, value);
      } else {
        setNativeValue(el, String(value));
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }

      el.dispatchEvent(new Event('change', { bubbles: true }));
      results.push({ selector: selector || ref, success: true, value });
    }

    const failed = results.filter((result) => !result.success).length;
    if (failed > 0) {
      // A partly filled form is not submitted: it would send incomplete data.
      return {
        success: false,
        error: `${failed} of ${results.length} fields failed${_submit ? '; the form was not submitted' : ''}`,
        fields: results,
      };
    }
    if (!_submit) return { success: true, fields: results };

    if (!formToSubmit || !submitForm(formToSubmit)) {
      return {
        success: false,
        error: 'SUBMIT_BLOCKED: the form did not submit (constraint validation stopped it, or it has no submit path).',
        fields: results,
        submitted: false,
      };
    }
    return { success: true, fields: results, submitted: true };
  }, [withFb, submit]);

  // A field that did not resolve gets the same wording as every other ref tool
  // (lib/ref-errors.js), or the selector's own not-found message. Results come back
  // one per field, in order, so the index names the field.
  if (!Array.isArray(res?.fields)) return res;
  const fieldError = (result, field) => {
    if (result.error === 'REF_GONE') return refErrorMessage(field.ref, getFallback(tabId, field.ref));
    if (result.error === 'NO_MATCH') return selectorErrorMessage(field.selector, tab.url);
    if (result.error === 'INVALID_SELECTOR') return `Invalid CSS selector: ${field.selector}`;
    if (result.error === 'NO_TARGET') return 'ref or selector is required (get refs from browser_snapshot).';
    return result.error;
  };
  return {
    ...res,
    fields: res.fields.map((result, i) => (result.success ? result : { ...result, error: fieldError(result, fields[i] || {}) })),
  };
}
