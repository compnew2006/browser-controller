/**
 * browser_fill: set many form fields in one call. Text fields get their value
 * as one real insertion over CDP (Input.insertText: beforeinput + input, as a
 * paste does), after their old value is selected. <select>, checkboxes,
 * radios and date/time/color/range inputs are set in the page with the events
 * a user's choice fires (no CDP input reaches a native <select> popup). File
 * inputs get local files through DOM.setFileInputFiles. Only failures are listed.
 */
import { resolveTab, execDom, getFallback } from '../lib/page-exec.js';
import { cdpSender, locateTarget, releaseShield, cdpKeyPress } from '../lib/trusted-input.js';

/** Main-world expression returning the node marked data-bc-upload=token (pierces open shadow roots / same-origin frames). */
function findMarkedExpression(token) {
  return `(() => { const s = '[data-bc-upload="${token}"]';
    const q = (root, d) => { const hit = root.querySelector(s); if (hit || d > 6) return hit;
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) { const h = q(el.shadowRoot, d + 1); if (h) return h; }
        if (el.tagName === 'IFRAME') { try { const h = el.contentDocument && q(el.contentDocument, d + 1); if (h) return h; } catch (e) {} }
      }
      return null; };
    return q(document, 0); })()`;
}

/**
 * Page-side: resolve one field and set it when the page itself can
 * ({ done: true }), or say how the extension must: { kind: 'text' } (CDP
 * insertion) or { kind: 'file' } (marked with `token` for CDP).
 */
function pageFillField(ref, sel, fb, value, token) {
  const D = globalThis.__bcDom;
  if (!D) return { __needDom: true };
  const found = D.resolve(ref, sel, fb);
  if (found.error === 'INVALID_SELECTOR') return { error: `Invalid CSS selector: ${sel}` };
  const el = found.el;
  if (!el) return { error: ref ? `REF_GONE: ${ref} is no longer on the page; take a new browser_snapshot` : `no element matches ${sel}` };
  if (el.disabled === true || D.attr(el, 'aria-disabled') === 'true') return { error: 'DISABLED: the field is disabled' };
  const tag = el.tagName;
  const type = String(el.type || '').toLowerCase();
  const fire = (...types) => { for (const t of types) el.dispatchEvent(new Event(t, { bubbles: true })); };
  const list = Array.isArray(value) ? value.map(String) : [String(value)];

  if (tag === 'SELECT') {
    const norm = (s) => D.clean(s).toLowerCase();
    const options = Array.from(el.options);
    const picks = [];
    for (const want of list) {
      const o = options.find((x) => x.value === want) || options.find((x) => norm(x.textContent) === norm(want));
      if (!o) return { error: `no option "${want}"; options: ${options.slice(0, 12).map((x) => D.clean(x.textContent)).join(' | ')}` };
      picks.push(o);
    }
    if (picks.length > 1 && !el.multiple) return { error: 'this <select> takes one value' };
    for (const o of options) o.selected = picks.includes(o);
    fire('input', 'change');
    return { done: true };
  }

  const native = tag === 'INPUT' && (type === 'checkbox' || type === 'radio');
  if (native || ['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio'].includes(D.attr(el, 'role'))) {
    if (value !== true && value !== false && value !== 'true' && value !== 'false') return { error: 'a checkbox, radio or switch takes true or false' };
    const want = value === true || value === 'true';
    const isOn = () => (native ? el.checked : D.attr(el, 'aria-checked') === 'true');
    if (isOn() !== want) {
      if (!want && (type === 'radio' || D.attr(el, 'role') === 'radio')) return { error: 'a radio cannot be unchecked: set another radio of its group to true' };
      el.click(); // the page's own toggle: the change/input events and its handlers run
    }
    return isOn() === want ? { done: true } : { error: 'the page did not change its state' };
  }

  if (tag === 'INPUT' && type === 'file') {
    if (list.length > 1 && !el.multiple) return { error: 'this file input takes one file' };
    el.setAttribute('data-bc-upload', token);
    return { kind: 'file' };
  }

  if (tag === 'INPUT' && ['date', 'time', 'datetime-local', 'month', 'week', 'color', 'range'].includes(type)) {
    // No keyboard path into these pickers: set the value as the picker does.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, list[0]);
    fire('input', 'change');
    if (list[0] !== '' && el.value === '') {
      const format = { date: 'YYYY-MM-DD', time: 'HH:MM', 'datetime-local': 'YYYY-MM-DDTHH:MM', month: 'YYYY-MM', week: 'YYYY-Www' }[type];
      return { error: `"${list[0]}" is not a valid ${type} value${format ? ` (${format})` : ''}` };
    }
    return { done: true };
  }

  const editable = el.isContentEditable || tag === 'TEXTAREA'
    || (tag === 'INPUT' && !['button', 'submit', 'reset', 'image', 'hidden'].includes(type));
  if (!editable) return { error: `not a form field (${D.describe(el)}): click it, or use browser_type` };
  if (el.readOnly) return { error: 'the field is read-only' };
  return { kind: 'text' };
}

/** Remove the one-shot upload marker (the page may have navigated: ignore). */
async function unmark(tabId, token) {
  try {
    await execDom(tabId, (_token) => {
      const D = globalThis.__bcDom;
      if (!D) return { __needDom: true };
      for (const el of D.queryAll(`[data-bc-upload="${_token}"]`, true) || []) el.removeAttribute('data-bc-upload');
      return null;
    }, [token]);
  } catch { /* page changed */ }
}

/** Fill one field; returns an error message or null. */
async function fillOne(tabId, send, field) {
  const { ref = null, selector = null, value } = field || {};
  if (!ref && !selector) return 'ref or selector is required';
  if (value === undefined || value === null) return 'value is required';
  const fb = getFallback(tabId, ref);
  const token = `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const prep = await execDom(tabId, pageFillField, [ref, selector, fb, value, token]);
  if (!prep || prep.error) return prep?.error || 'field not found';
  if (prep.done) return null;

  if (prep.kind === 'file') {
    const files = Array.isArray(value) ? value.map(String) : [String(value)];
    try {
      // DOM.setFileInputFiles fires input + change once, as a user's pick does.
      const { result } = await send('Runtime.evaluate', { expression: findMarkedExpression(token) });
      if (!result?.objectId) return 'the file input disappeared';
      await send('DOM.setFileInputFiles', { files, objectId: result.objectId });
    } finally {
      await unmark(tabId, token);
    }
    return null;
  }

  // Text: focus and select the old value, then insert the new one in one go.
  const loc = await locateTarget(tabId, { ref, selector, fb, mode: 'clear' });
  if (!loc?.success) return loc?.error === 'REF_GONE' ? `REF_GONE: ${ref || selector} is no longer on the page` : (loc?.error || 'field not found');
  if (!loc.focused) return 'the field cannot take focus: click it, then browser_type';
  if (loc.needsSelectAll) await cdpKeyPress(send, 'a', ['ctrl']);
  const text = Array.isArray(value) ? value.join(', ') : String(value);
  if (text) await send('Input.insertText', { text });
  else if (loc.hasText) await cdpKeyPress(send, 'Delete');
  return null;
}

export async function handleFill(params) {
  const { tabId, fields } = params;
  if (!Array.isArray(fields) || fields.length === 0) throw new Error('fields is required: [{ ref or selector, value }]');
  await resolveTab(tabId);
  const send = await cdpSender(tabId);
  const failed = [];
  try {
    for (const field of fields) {
      let error;
      try { error = await fillOne(tabId, send, field); } catch (err) { error = err?.message || String(err); }
      if (error) failed.push({ field: field?.ref || field?.selector || null, error });
      if (/^DIALOG_OPEN/.test(error || '')) break; // nothing else can run until it is answered
    }
  } finally {
    await releaseShield(tabId);
  }
  if (!failed.length) return { success: true, filled: fields.length };
  return { success: false, error: `${failed.length} of ${fields.length} fields failed`, failed };
}
