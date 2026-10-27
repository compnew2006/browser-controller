/**
 * Advanced interaction handlers: browser_fill (one call, one field per entry, each
 * by its element kind) and browser_handle_dialog.
 * Page functions below are serialized into the page: each one is self-contained.
 */
import { resolveTab, execDom } from '../lib/page-exec.js';
import { getOpenDialog, clearOpenDialog, sendAttached } from '../lib/cdp-session.js';
import { requireSender, locateTarget, focusByClick, selectFocused, releaseShield, cursorTo, cdpClickAt, cdpKeyPress, targetAim, targetChangedError, wordTargetRefMiss, assertInputReady, inputSession, dialogSummary, inputBlockedError } from '../lib/trusted-input.js';
import { settleWithin, TIMED_OUT, sleep } from '../lib/timing.js';
import { reboundNote } from '../lib/ref-errors.js';
import { targetLabel } from '../lib/target.js';

/** One answer to a dialog. A page that never accepts it returns TIMEOUT instead of holding the tab. */
const DIALOG_ANSWER_MS = 3_000;
/** A dialog's message is page-written text: shown on one line, at most this many characters. */
const DIALOG_MESSAGE_MAX = 200;

/** The dialog's message as one short line (line breaks become spaces), or null when there is none. */
function shortMessage(message) {
  if (message == null) return null;
  const one = String(message).replace(/\s+/g, ' ').trim();
  return one.length > DIALOG_MESSAGE_MAX ? `${one.slice(0, DIALOG_MESSAGE_MAX)}…` : one;
}

/**
 * browser_handle_dialog: answers the JavaScript dialog open on the tab, over the
 * tab's debugger session. The session records each dialog as it opens (cdp-session
 * enables Page at attach), and that record says what is open. With nothing
 * recorded the answer is still tried once over the existing attachment: a record
 * can be lost while Chrome keeps the attachment (service-worker restart). No page
 * code runs, and no debugger is attached just to look for a dialog.
 * `accept: true` accepts, `false` dismisses; the older `action` ('accept'|'dismiss') still works.
 */
export async function handleDialog(params) {
  const { tabId, promptText } = params;
  const accept = typeof params.accept === 'boolean' ? params.accept : (params.action ?? 'accept') !== 'dismiss';
  const tab = await resolveTab(tabId);
  const recorded = getOpenDialog(tab.id);

  let answer;
  try {
    answer = await settleWithin(
      sendAttached(tab.id, 'Page.handleJavaScriptDialog', { accept, promptText: promptText || '' }),
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
  const type = recorded?.type ?? 'dialog';
  const message = shortMessage(recorded?.message);
  return {
    success: true,
    text: `${accept ? 'accepted' : 'dismissed'} ${type}${message != null ? ` "${message}"` : ''}`,
    handled: true,
    accept,
    action: accept ? 'accept' : 'dismiss',
    type: recorded?.type ?? null,
    message,
  };
}

/**
 * Page-side: the kind of field a target is, and its state. Reads only: no scroll,
 * no focus, no input. Kinds: select, checkbox, radio (`aria` for an ARIA widget that is not
 * a native input), file, picker, text, or other (refused).
 */
function pageFieldKind(t, fb) {
  const D = globalThis.__bcDom;
  if (!D || !D.resolveTarget || !D.fileInputFor) return { __needDom: true };
  const r = D.resolveTarget(t, fb, { file: true });
  if (r.error) return { error: r.error, ...(r.issued !== undefined ? { issued: r.issued } : {}), ...(r.earlier ? { earlier: true } : {}) };
  // A ref re-found by its descriptor is reported (the note line); the registry now holds it.
  const rebound = r.via === 'fallback' ? { via: 'fallback' } : {};
  const el = r.el;
  if (!el) return { kind: 'none', ...rebound };
  // A hidden file input, its label or the visible upload button: all are the file field.
  const fileInput = D.fileInputFor(el);
  if (fileInput) return { kind: 'file', multiple: !!fileInput.multiple, ...rebound };
  const tag = el.tagName.toLowerCase();
  const type = String(el.type || '').toLowerCase();
  if (tag === 'select') return { kind: 'select', multiple: !!el.multiple, ...rebound };
  if (tag === 'input' && (type === 'checkbox' || type === 'radio')) return { kind: type, checked: !!el.checked, ...rebound };
  if (tag === 'input' && type === 'file') return { kind: 'file', multiple: !!el.multiple, ...rebound };
  // A picker sets its whole value (no typing path): see pageSetPicker.
  if (tag === 'input' && ['date', 'time', 'datetime-local', 'month', 'week', 'color', 'range'].includes(type)) return { kind: 'picker', type, ...rebound };
  const role = tag === 'input' ? '' : D.roleOf(el);
  if (role === 'checkbox' || role === 'radio' || role === 'switch') {
    return { kind: role === 'radio' ? 'radio' : 'checkbox', aria: true, checked: el.getAttribute('aria-checked') === 'true', ...rebound };
  }
  const notText = ['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'image', 'hidden'];
  if (el.isContentEditable || tag === 'textarea' || (tag === 'input' && !notText.includes(type))) return { kind: 'text', ...rebound };
  return { kind: 'other', tag, type, ...rebound };
}

/**
 * Page-side: set a picker input (date, time, datetime-local, month, week, color, range) as
 * the picker does: the native value setter (a framework's tracked value is bypassed, so its
 * change handler sees the new value), then input and change. A value the browser sanitizes
 * (a bad date, an off-step range) reads back different: `same` is false. A disabled or
 * read-only field is not set.
 */
function pageSetPicker(t, fb, value) {
  const D = globalThis.__bcDom;
  if (!D || !D.resolveTarget) return { __needDom: true };
  const r = D.resolveTarget(t, fb);
  if (r.error) return { error: r.error, ...(r.issued !== undefined ? { issued: r.issued } : {}), ...(r.earlier ? { earlier: true } : {}) };
  const el = r.el;
  if (!el) return { error: 'INVALID_ARGUMENT: not a picker field' };
  if (!el.disabled && !el.readOnly) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const kept = String(el.value ?? '');
  const same = el.type === 'color' ? kept.toLowerCase() === value.toLowerCase()
    : el.type === 'range' ? Number(kept) === Number(value)
      : kept === value;
  return { same, kept };
}

/** Page-side: the aria-checked state of a target now (ARIA checkbox, radio or switch). */
function pageAriaChecked(t, fb) {
  const D = globalThis.__bcDom;
  if (!D || !D.resolveTarget) return { __needDom: true };
  const r = D.resolveTarget(t, fb);
  if (r.error) return { error: r.error, ...(r.issued !== undefined ? { issued: r.issued } : {}), ...(r.earlier ? { earlier: true } : {}) };
  return { checked: !!r.el && r.el.getAttribute('aria-checked') === 'true' };
}

/**
 * Page-side: pick options of a <select>. A value matches the option's value exactly,
 * else its label (trimmed, case-insensitive). A miss lists up to five labels.
 */
function pageChooseOptions(t, fb, wanted, multi) {
  const D = globalThis.__bcDom;
  if (!D || !D.resolveTarget) return { __needDom: true };
  const r = D.resolveTarget(t, fb);
  if (r.error) return { error: r.error };
  const el = r.el;
  const options = Array.from(el.options);
  const labelOf = (o) => String(o.textContent || '').trim();
  const picks = [];
  for (const w of wanted) {
    let o = options.find((c) => c.value === w);
    if (!o) o = options.find((c) => labelOf(c).toLowerCase() === w.trim().toLowerCase());
    if (!o) {
      const labels = options.slice(0, 5).map(labelOf).join(', ');
      return { error: `OPTION_NOT_FOUND: "${w}" (options: ${labels}${options.length > 5 ? ', …' : ''})` };
    }
    picks.push(o);
  }
  if (multi) for (const o of options) o.selected = picks.includes(o);
  else el.selectedIndex = options.indexOf(picks[0]);
  // Same order as a person's pick: the input event first, then change.
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return {};
}

/** Page-side: mark the file input with a one-shot token (CDP finds it by the marker). */
function pageMarkFile(t, fb, token) {
  const D = globalThis.__bcDom;
  if (!D || !D.resolveTarget || !D.fileInputFor) return { __needDom: true };
  const r = D.resolveTarget(t, fb, { file: true });
  if (r.error) return { error: r.error };
  const el = D.fileInputFor(r.el);
  if (!el) return { notFile: true };
  el.setAttribute('data-bc-upload', token);
  return { multiple: !!el.multiple };
}

/** Page-side: remove the one-shot marker, wherever the input lives. */
function pageUnmarkFile(token) {
  const D = globalThis.__bcDom;
  if (!D || !D.queryAll) return { __needDom: true };
  for (const el of D.queryAll(`[data-bc-upload="${token}"]`, true) || []) el.removeAttribute('data-bc-upload');
  return {};
}

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

/** An absolute path: POSIX (/…) or a Windows drive (C:\\… or C:/…). */
const isAbsolutePath = (path) => path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path);

/** DOM.setFileInputFiles on a file input (the input's marker is found over CDP). Returns an error string or null. */
async function setFiles(tabId, send, target, parsed, fb, paths) {
  const label = targetLabel(target);
  const token = `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const mark = await execDom(tabId, pageMarkFile, [parsed, fb, token]);
  if (mark?.error) return wordTargetRefMiss(tabId, parsed, mark).error;
  if (!mark || mark.notFile) return `INVALID_ARGUMENT: ${label} is not a file input`;
  if (paths.length > 1 && !mark.multiple) return `INVALID_ARGUMENT: ${label} does not accept several files`;
  try {
    const { result } = await send('Runtime.evaluate', { expression: findMarkedExpression(token) });
    if (!result || !result.objectId) return `NOT_FOUND: ${label} is no longer on the page`;
    // Chromium fires `input` and `change` itself on the file input.
    await send('DOM.setFileInputFiles', { files: paths, objectId: result.objectId });
    return null;
  } finally {
    await execDom(tabId, pageUnmarkFile, [token]).catch(() => {});
  }
}

/**
 * The server flags the path-like values it could not read (`missingFiles`, names only).
 * Only a file input refuses the whole call: a select's values may look like paths ("/en").
 * Nothing is sent to the page before this check, so nothing is filled.
 */
async function refuseMissingFiles(tabId, fields) {
  const missing = [];
  for (const field of fields) {
    if (!Array.isArray(field?.missingFiles) || field.missingFiles.length === 0) continue;
    const { parsed, fb } = targetAim(tabId, field.target);
    const info = await execDom(tabId, pageFieldKind, [parsed, fb]);
    if (info?.kind === 'file') missing.push(...field.missingFiles.map(String));
  }
  if (missing.length) throw new Error(`FILE_NOT_FOUND: ${missing.join(', ')} does not exist or is not a readable file; nothing was filled.`);
}

/** Page side: the safety fingerprint of each field's element, in field order (null for a point target). */
function pageFieldFingerprints(targets) {
  const D = globalThis.__bcDom;
  if (!D || !D.resolveTarget || !D.safetyFingerprint) return { __needDom: true };
  const perField = [];
  for (const item of targets) {
    // The same options as the classifier (browser_fill), so both fingerprint the same element.
    const resolved = D.resolveTarget(item.target, item.fallback, { file: true });
    if (resolved.error) return { error: resolved.error };
    perField.push(resolved.el ? D.safetyFingerprint(resolved.el) : null);
  }
  return { perField };
}

/**
 * The server's safety check classified these fields (`expectFingerprints`, in field order; a point
 * target has no fingerprint). Resolve them all now, before any input, and refuse the call when one
 * differs. Returns each field's own fingerprint, so a field's click re-checks it, or null when the
 * call carries no list. An empty list has nothing to compare.
 */
async function checkFieldFingerprints(tabId, fields, expectFingerprints) {
  if (!Array.isArray(expectFingerprints) || expectFingerprints.length === 0) return null;
  const aims = fields.map((field) => {
    const { parsed, fb } = targetAim(tabId, field?.target);
    return { target: parsed, fallback: fb };
  });
  const res = await execDom(tabId, pageFieldFingerprints, [aims]);
  if (!res || res.error || res.__needDom) throw targetChangedError();
  const now = res.perField.filter((fp) => fp !== null);
  if (now.length !== expectFingerprints.length || now.some((fp, i) => fp !== expectFingerprints[i])) throw targetChangedError();
  return res.perField;
}

/**
 * Fill one field by its kind. Returns null when it is filled, else `CODE: message`.
 * `input` is the call's input session: a dialog the field's input opens ends the field
 * (the caller reports it), and nothing after it is sent.
 */
async function fillField(tabId, input, field, rebound, expect = null) {
  const target = field.target;
  const label = targetLabel(target);
  const { parsed, fb } = targetAim(tabId, target);
  const info = await execDom(tabId, pageFieldKind, [parsed, fb]);
  if (info?.via === 'fallback') rebound.add(parsed.ref);
  if (info?.error) return wordTargetRefMiss(tabId, parsed, info).error;
  if (!info || info.kind === 'none') return `INVALID_ARGUMENT: ${label} is not a form field`;
  if (info.kind === 'other') return `INVALID_ARGUMENT: ${label} is a <${info.tag}${info.type ? ` type="${info.type}"` : ''}>, not a form field`;
  const value = typeof field.value === 'number' ? String(field.value) : field.value;

  if (info.kind === 'text') {
    if (typeof value !== 'string') return `INVALID_ARGUMENT: ${label} takes a string`;
    const loc = await focusByClick(tabId, input, target, { edit: true, expect });
    if (!loc.success) return loc.error;
    if (input.blocked) return null;
    await selectFocused(tabId);
    if (value === '') await cdpKeyPress(input.send, 'Backspace');
    else await input.send('Input.insertText', { text: value });
    if (input.blocked) return null;
    // Read back: a page that rejects input keeps its value, and is not "filled".
    // The value API reads CRLF back as LF, and the read back covers the first 100 characters.
    const after = await releaseShield(tabId, value);
    if (loc.clicked && after?.pressSeen === false) return inputBlockedError(`the click that focuses ${label}`);
    const kept = after?.secret ? (after?.hasValue ? '••••' : '') : after?.value ?? '';
    const expected = value.replace(/\r\n?/g, '\n').slice(0, 100);
    const accepted = after?.secret ? after?.matchesTyped === true : after?.value === expected;
    if (!accepted) return `VALUE_NOT_SET: kept "${after?.secret && kept ? '••••' : kept}"`;
    return null;
  }

  if (info.kind === 'picker') {
    if (typeof value !== 'string') return `INVALID_ARGUMENT: ${label} takes a string`;
    const res = await execDom(tabId, pageSetPicker, [parsed, fb, value]);
    if (res?.error) return wordTargetRefMiss(tabId, parsed, res).error;
    return res?.same === true ? null : `VALUE_NOT_SET: kept "${res?.kept ?? ''}"`;
  }

  if (info.kind === 'select') {
    const wanted = Array.isArray(value) ? value : [value];
    if (!wanted.every((v) => typeof v === 'string')) return `INVALID_ARGUMENT: ${label} takes a string or a string[]`;
    if (!info.multiple && wanted.length !== 1) return `INVALID_ARGUMENT: ${label} is a single-choice select: give one value`;
    const res = await execDom(tabId, pageChooseOptions, [parsed, fb, wanted, info.multiple]);
    return res?.error ? wordTargetRefMiss(tabId, parsed, res).error : null;
  }

  if (info.kind === 'checkbox' || info.kind === 'radio') {
    if (typeof value !== 'boolean') return `INVALID_ARGUMENT: ${label} takes true or false`;
    if (info.kind === 'radio' && !value) return `INVALID_ARGUMENT: ${label} is a radio button: it can only be set to true`;
    // Clicked only when the state differs (a click on a checked box would uncheck it).
    if (info.checked === value) return null;
    const loc = await locateTarget(tabId, { target, check: 'click', expect });
    if (!loc.success) return loc.error;
    if (input.blocked) return null;
    await sleep(await cursorTo(tabId, loc.x, loc.y, 'click'));
    await cdpClickAt(input.send, loc.x, loc.y);
    if (!info.aria || input.blocked) return null;
    // An ARIA widget's state is its aria-checked: a click the page ignored leaves it unchanged.
    const now = wordTargetRefMiss(tabId, parsed, await execDom(tabId, pageAriaChecked, [parsed, fb]));
    if (now?.error) return now.error;
    return now?.checked === value ? null : `VALUE_NOT_SET: kept aria-checked="${now?.checked ? 'true' : 'false'}"`;
  }

  // file: the absolute paths (the server checks they exist). A relative path is refused here,
  // before anything is sent: Chrome resolves it against its own working directory, which the
  // server's secret-file check never saw.
  const paths = Array.isArray(field.value) ? field.value : null;
  if (!paths || paths.length === 0 || !paths.every((p) => typeof p === 'string' && p)) {
    return `INVALID_ARGUMENT: ${label} is a file input: give an array of absolute file paths`;
  }
  if (!paths.every(isAbsolutePath)) {
    return `INVALID_ARGUMENT: ${label} is a file input: give absolute file paths (got a relative path)`;
  }
  return setFiles(tabId, input.raw, target, parsed, fb, paths);
}

/**
 * browser_fill: each field by its element kind. Fields are filled in order; one
 * field that fails does not stop the others. Nothing is submitted. A dialog that a
 * field's input opens stops the fill: the field after it is not filled.
 */
export async function handleFill(params, _sessionId, _agentName, signal) {
  const { tabId, fields } = params;
  if (!Array.isArray(fields) || fields.length < 1 || fields.length > 50) {
    throw new Error('INVALID_ARGUMENT: fields needs 1 to 50 entries');
  }
  await resolveTab(tabId);
  assertInputReady(tabId, signal);
  await refuseMissingFiles(tabId, fields);
  const expected = await checkFieldFingerprints(tabId, fields, params.expectFingerprints);
  const input = inputSession(tabId, await requireSender(tabId), signal);
  const failed = [];
  const rebound = new Set();
  let stopped = null;
  try {
    for (const [index, field] of fields.entries()) {
      const target = targetLabel(field?.target ?? '(no target)');
      if (stopped) { failed.push(`${target}: ${stopped}`); continue; }
      if (input.blocked) {
        stopped = 'DIALOG_OPEN: not filled, a dialog is open';
        failed.push(`${target}: ${stopped}`);
        continue;
      }
      let error = null;
      try {
        error = await fillField(tabId, input, field ?? {}, rebound, expected?.[index] ?? null);
      } catch (err) {
        error = String(err?.message || err);
        // A wedged tab or a cancelled call: the rest of the call is not attempted.
        if (err?.code === 'TAB_WEDGED' || signal?.aborted) stopped = 'TIMEOUT: not attempted, the call stopped first';
      }
      if (input.blocked) {
        const dialog = getOpenDialog(tabId) ?? { type: 'dialog', message: '' };
        error = `DIALOG_OPEN: ${dialogSummary(dialog)} opened while filling; answer it with browser_handle_dialog, then fill the rest`;
      }
      if (error) failed.push(`${target}: ${error}`);
    }
  } finally {
    if (!input.blocked) await releaseShield(tabId);
    input.close();
  }
  const notes = [...rebound].map((ref) => reboundNote(ref));
  if (failed.length) {
    return { success: false, error: [`FILL_FAILED: ${failed.length} of ${fields.length} fields failed`, ...failed, ...notes].join('\n') };
  }
  return { success: true, text: [`filled ${fields.length} fields`, ...notes].join('\n'), filled: fields.length };
}
