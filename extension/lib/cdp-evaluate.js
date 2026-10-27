/**
 * Evaluate over CDP (Runtime.evaluate), so the page's CSP does not block it.
 *
 *  - cdpEvaluateSource: browser_evaluate (contract 3.0). The source is one expression,
 *    or statements that `return` their value; a returned promise is awaited; a throw is
 *    SCRIPT_ERROR, an overrun is TIMEOUT. With a tabId, a JavaScript dialog that is open
 *    refuses the call (DIALOG_OPEN), and one the script opens ends it at once (paused).
 *
 * Non-JSON values (DOM nodes, cycles, functions) come back as readable descriptions instead of {}.
 */
import { MAX_RESULT_CHARS } from './state.js';
import { getOpenDialog, subscribeCdpEvents, dialogLabel, dialogOpenError, holdFileChooser } from './cdp-session.js';

/** browser_evaluate's timeout: its default and its largest value (contract 3.0). */
export const BROWSER_EVALUATE_DEFAULT_MS = 5_000;
export const BROWSER_EVALUATE_MAX_MS = 30_000;

/**
 * Page-side serializer, run with `this` = the evaluated value. `cap` is the largest string that may
 * cross CDP: a longer JSON comes back as { head, fullLength } (head = its first `cap` characters),
 * so the extension never receives the full payload. Self-contained: it is serialized alone.
 */
function serializeThis(cap) {
  const describe = (n) => {
    if (!(n instanceof Node)) return String(n);
    if (n.nodeType !== 1) return `#${n.nodeName.toLowerCase()}`;
    let s = n.tagName.toLowerCase();
    if (n.id) s += `#${n.id}`;
    if (typeof n.className === 'string' && n.className.trim()) s += `.${n.className.trim().split(/\s+/).slice(0, 3).join('.')}`;
    const text = (n.innerText || n.value || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    return text ? `<${s}> "${text}"` : `<${s}>`;
  };
  const seen = new WeakSet();
  const out = JSON.stringify(this, (_k, v) => {
    if (typeof v === 'bigint') return `${v}n`;
    if (typeof v === 'function') return `[Function ${v.name || 'anonymous'}]`;
    if (typeof v === 'symbol') return v.toString();
    if (v === undefined) return null;
    if (typeof Node !== 'undefined' && v instanceof Node) return describe(v);
    if (v instanceof Map) return Object.fromEntries(v);
    if (v instanceof Set) return [...v];
    if (v instanceof Error) return `${v.name}: ${v.message}`;
    if (typeof NodeList !== 'undefined' && (v instanceof NodeList || v instanceof HTMLCollection)) return [...v];
    if (v && typeof v === 'object') {
      if (seen.has(v)) return '[Circular]';
      seen.add(v);
    }
    return v;
  });
  if (out === undefined) return null;
  if (typeof cap === 'number' && out.length > cap) return { head: out.slice(0, cap), fullLength: out.length };
  return out;
}

function capped(value) {
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  if (raw && raw.length > MAX_RESULT_CHARS) {
    return { success: true, result: raw.slice(0, MAX_RESULT_CHARS), truncated: true, fullLength: raw.length };
  }
  return { success: true, result: value };
}

/**
 * Every CDP call that can wait on the page is raced against the budget, the abort and, when a tab
 * is given, the JavaScript dialog the script opens (Runtime.evaluate waits for the dialog to close).
 * `guarded(p)` resolves to p's answer, { timedOut: true }, { aborted: true } or { dialog }.
 */
function racer(budget, signal, tabId) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), budget);
  });
  const aborted = signal
    ? new Promise((resolve) => {
        if (signal.aborted) resolve({ aborted: true });
        else signal.addEventListener('abort', () => resolve({ aborted: true }), { once: true });
      })
    : null;
  let off = () => {};
  const opened = new Promise((resolve) => {
    if (tabId == null) return;
    off = subscribeCdpEvents(tabId, (method, params) => {
      if (method === 'Page.javascriptDialogOpening') resolve({ dialog: { type: params?.type, message: params?.message ?? '' } });
    });
  });
  return {
    guarded: (p) => Promise.race([p, timeout, opened, ...(aborted ? [aborted] : [])]),
    stop: () => { clearTimeout(timer); off(); },
  };
}

/**
 * The script opened a JavaScript dialog: its Runtime.evaluate waits for the dialog, so the call
 * answers now as a success that names the dialog (an input that opened one answers the same way).
 */
const pausedReply = (dialog) => ({
  success: true,
  paused: true,
  dialog,
  result: null,
  text: `dialog: ${dialogLabel(dialog)}\nthe script is paused until browser_handle_dialog answers it`,
});

/** The remote value of an evaluate reply as a result object (both entry points). */
async function resultOf(send, ro) {
  if (ro.type === 'undefined') return { success: true, result: null, type: 'undefined' };
  if (ro.unserializableValue !== undefined) return { success: true, result: ro.unserializableValue };
  if ('value' in ro && ro.objectId === undefined) return capped(ro.value);
  if (ro.subtype === 'node' || !ro.objectId) return capped(ro.description ?? null);
  const ser = await send('Runtime.callFunctionOn', {
    objectId: ro.objectId,
    functionDeclaration: serializeThis.toString(),
    arguments: [{ value: MAX_RESULT_CHARS }],
    returnByValue: true,
  });
  const json = ser?.result?.value;
  // Over the cap: the page sent only the head and the full length (see serializeThis).
  if (json && typeof json === 'object' && typeof json.head === 'string') {
    return { success: true, result: json.head, truncated: true, fullLength: json.fullLength };
  }
  if (typeof json !== 'string') return capped(ro.description ?? null);
  if (json.length > MAX_RESULT_CHARS) return capped(json);
  try {
    return { success: true, result: JSON.parse(json) };
  } catch {
    return capped(json);
  }
}

/** A thrown value's message: the first line of its description (no stack), or the thrown primitive. */
function messageOf(details) {
  const text = details.exception?.description || details.exception?.value || details.text || 'evaluate threw';
  return String(text).split('\n')[0].slice(0, 2000);
}

/**
 * A CDP call that failed (the debugger detached, the target went away): DEBUGGER_UNAVAILABLE with
 * the protocol's message, never the raw error. The next call reattaches on its own.
 */
export function cdpFailure(err) {
  let text = String(err?.message ?? err);
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed?.message === 'string') text = parsed.message;
  } catch { /* a plain message */ }
  return `DEBUGGER_UNAVAILABLE: ${text.replace(/\s+/g, ' ').trim().slice(0, 300)} (the debugger session failed; the next call reattaches)`;
}

/**
 * Does `expression` parse? Runtime.evaluate of a function expression builds the function, and a
 * SyntaxError comes back as exceptionDetails. throwOnSideEffect makes V8 refuse any code that
 * would run: a source that closes the wrapper early (`1)); f(); ((0`) gets an EvalError before
 * its statements execute, so the parse check never runs the source. Unlike Runtime.compileScript
 * this needs no Runtime domain enabled, and a fresh attach has it off.
 */
function parse(send, expression, group) {
  return send('Runtime.evaluate', { expression, objectGroup: group, returnByValue: false, throwOnSideEffect: true });
}

/** V8 refused a parse check: the source would have run code outside its function (see parse). */
const refusedBy = (details) => /^EvalError\b/.test(String(details.exception?.description || details.text || ''));

/** A parse check refused a break-out: nothing ran, the call fails with a coded message. */
const refusedReply = () => ({
  success: false,
  error: 'SCRIPT_ERROR: the source runs code outside its function body (it closes the wrapper early); refused before it ran, nothing was run',
});

/** The caller (the bridge) gave up on the call: nothing more runs, the failure says so. */
const cancelledReply = () => ({ success: false, error: 'TIMEOUT: evaluate cancelled by the caller' });

/** DIALOG_OPEN for a call on a tab whose JavaScript dialog is open (nothing is sent), else null. */
function dialogRefusal(tabId) {
  const open = tabId == null ? null : getOpenDialog(tabId);
  return open ? { success: false, error: dialogOpenError(tabId, open).message } : null;
}

/**
 * browser_evaluate (contract 3.0): `source` is one expression, or statements that
 * `return` a value. It is compiled first (nothing runs when it does not parse), then
 * run once, awaited, and read back by value. Failures: SCRIPT_ERROR, or TIMEOUT.
 * `tabId` (optional) watches the tab's JavaScript dialogs: DIALOG_OPEN while one is open,
 * and a paused success when the script opens one. The run has a user gesture, so its
 * input.click() would open the native file dialog: with `tabId` a file chooser is
 * intercepted instead (holdFileChooser).
 */
export async function cdpEvaluateSource(send, source, { timeoutMs = BROWSER_EVALUATE_DEFAULT_MS, signal, tabId } = {}) {
  const budget = Math.min(Math.max(1000, timeoutMs), BROWSER_EVALUATE_MAX_MS);
  const refused = dialogRefusal(tabId);
  if (refused) return refused;
  const group = `bc-eval-${Date.now()}`;
  const { guarded, stop } = racer(budget, signal, tabId);
  let chooser = null;
  const timedOut = {
    success: false,
    error: `TIMEOUT: evaluate did not finish within ${budget}ms. The page may still be running it; the call returned so the tab is free.`,
  };
  try {
    if (signal?.aborted) return cancelledReply();
    const code = String(source);
    const single = `(async () => (\n${code.trim().replace(/;+\s*$/, '')}\n))`;
    const body = `(async () => {\n${code}\n})`;
    // Parse only (throwOnSideEffect): a syntax error or a refused break-out runs nothing. An expression first, else a body.
    let fn = single;
    let check = await guarded(parse(send, single, group));
    if (check.exceptionDetails) {
      if (refusedBy(check.exceptionDetails)) return refusedReply();
      fn = body;
      check = await guarded(parse(send, body, group));
      if (check.exceptionDetails) {
        return refusedBy(check.exceptionDetails) ? refusedReply() : { success: false, error: `SCRIPT_ERROR: ${messageOf(check.exceptionDetails)}` };
      }
    }
    if (check.aborted) return cancelledReply();
    if (check.timedOut) return timedOut;
    // A dialog that opened while the source was checked: a run sent now would queue behind it and execute after it closes.
    const late = dialogRefusal(tabId);
    if (late) return late;
    if (tabId != null) {
      chooser = holdFileChooser(tabId, send);
      await chooser.ready;
    }
    const run = await guarded(send('Runtime.evaluate', {
      expression: `${fn}()`,
      awaitPromise: true,
      returnByValue: false,
      userGesture: true,
      objectGroup: group,
      timeout: budget,
    }));
    if (run.aborted) return cancelledReply();
    if (run.dialog) return pausedReply(run.dialog);
    if (run.timedOut) return timedOut;
    if (run.exceptionDetails) return { success: false, error: `SCRIPT_ERROR: ${messageOf(run.exceptionDetails)}` };
    const res = await resultOf(send, run.result || {});
    // Statements give their `return` value: none came back (the reply says how to get one).
    return fn === body && res.type === 'undefined' ? { ...res, statements: true } : res;
  } catch (err) {
    // A rejected CDP call is the debugger failing, not the page throwing (those come back as exceptionDetails).
    return { success: false, error: cdpFailure(err) };
  } finally {
    stop();
    chooser?.release();
    send('Runtime.releaseObjectGroup', { objectGroup: group }).catch(() => {});
  }
}
