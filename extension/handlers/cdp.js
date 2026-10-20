/**
 * CDP-backed handlers (extracted from background.js): run_action and
 * upload_file — the two tools that cannot be implemented with
 * chrome.scripting (CSP bypass / DOM.setFileInputFiles).
 */
import { resolveTab, execDom, getFallback, withTimeout } from '../lib/page-exec.js';
import { MAX_RESULT_CHARS } from '../lib/state.js';
import { ensureCdp } from '../lib/cdp-session.js';
import { handleScreenshot } from './tabs.js';

export async function handleRunAction(params, _sessionId, _agentName, signal) {
  const { tabId, code, actionParams = {} } = params;
  if (!code) throw new Error('code is required');
  const tab = await resolveTab(tabId);

  // run_action stays on CDP (plan decision: CDP-only, can't be scripted —
  // it bypasses page CSP via the debugger protocol, unlike browser_evaluate).
  const send = await ensureCdp(tab.id);
  const paramsJson = JSON.stringify(actionParams);
  // Dual mode: accept EITHER a {execute:function()} tool wrapper (legacy
  // skill syntax) OR a plain JS expression/statement (simple usage like
  // "document.title" or "var x=...; JSON.stringify(x)"). The page side wraps
  // the code twice: first as an expression, then (only when that does not
  // parse) as a statement body, so multi-statement code works too.
  const runner = (body) => `(async function() {
    try {
      var result = ${body};
      if (result && typeof result.execute === "function") {
        result = await result.execute(${paramsJson});
      }
      return { __bcOk: true, result: result };
    } catch (e) {
      return { __bcOk: false, message: String((e && e.message) || e) };
    }
  })()`;
  const expressionForm = runner(`await (${code.trim().replace(/;+$/, '')})`);
  const statementForm = runner(`await (async function() {\n${code}\n})()`);

  // Bounded: the transport would give up at 30 s, and nothing else releases a
  // page that never finishes (the tab mutex would stay taken until the idle detach).
  const RUN_ACTION_MS = 25_000;
  const evaluate = (expression) => withTimeout(send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
  ), RUN_ACTION_MS, () => Object.assign(new Error('run_action timed out'), { code: 'TIMEOUT' }));
  let outcome;
  try {
    outcome = await evaluate(expressionForm);
    // A SyntaxError parses nothing, so nothing ran: retry as a statement body.
    if (outcome.exceptionDetails && /SyntaxError/.test(outcome.exceptionDetails.exception?.className || outcome.exceptionDetails.text || '')) {
      outcome = await evaluate(statementForm);
    }
  } catch (err) {
    if (err.code === 'TIMEOUT') return { success: false, error: `TIMEOUT: browser_run_action did not finish within ${RUN_ACTION_MS / 1000}s (the page code may still be running).` };
    throw err;
  }
  const { result, exceptionDetails } = outcome;

  // Cancellation: if the caller (daemon/bridge) aborted while the page was
  // evaluating (e.g. a long IIFE), the result is now useless — drop it so the
  // tab mutex releases immediately and the next caller isn't queued behind a
  // dead request.
  if (signal?.aborted) {
    return { success: false, error: 'aborted' };
  }
  if (exceptionDetails) {
    return { success: false, error: `SCRIPT_ERROR: ${exceptionDetails.exception?.description || exceptionDetails.text}` };
  }
  const outer = result.value || {};
  if (outer.__bcOk === false) {
    return { success: false, error: `SCRIPT_ERROR: ${outer.message}` };
  }
  const value = outer.result;
  // MCP-style content from an execute() action is the result as it is.
  if (value && typeof value === 'object' && Array.isArray(value.content)) {
    return { success: true, result: value };
  }
  // Cap oversized results (same policy as handleEvaluate).
  const raw = JSON.stringify(value);
  if (raw && raw.length > MAX_RESULT_CHARS) {
    return {
      success: true,
      result: raw.slice(0, MAX_RESULT_CHARS) + '…[truncated]',
      truncated: true,
      fullLength: raw.length,
    };
  }
  return { success: true, result: value };
}

/** Main-world expression returning the node marked data-bc-upload=token (pierces open shadow roots / same-origin frames). */
export function findMarkedExpression(token) {
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
 * Page-side: build a File from base64 bytes and hand it to the page — into an
 * <input type="file"> (files + input/change events) or, for any other target,
 * as a drag-and-drop (dragenter/dragover/drop with a DataTransfer), which is
 * what upload drop zones listen for. No temp files, no file dialog.
 */
function pagePutFile(ref, sel, fb, b64, mime, name, x, y) {
  const D = globalThis.__bcDom;
  if (!D) return { __needDom: true };
  let target;
  if (ref || sel) target = D.resolve(ref, sel, fb).el;
  else if (Number.isFinite(x) && Number.isFinite(y)) target = D.elementAt(x, y);
  else target = (D.queryAll('input[type="file"]', true) || [])[0] || null;
  if (!target) return { success: false, error: 'Upload target not found' };
  let bytes;
  try {
    const bin = atob(b64);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch { return { success: false, error: 'imageBase64 is not valid base64' }; }
  const file = new File([bytes], name, { type: mime });
  const dt = new DataTransfer();
  dt.items.add(file);
  if (target.tagName === 'INPUT' && target.type === 'file') {
    target.files = dt.files;
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
    return { success: true, mode: 'input', file: name, size: file.size };
  }
  const r = target.getBoundingClientRect();
  const init = { bubbles: true, cancelable: true, composed: true, dataTransfer: dt, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  for (const type of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(type, init));
  return { success: true, mode: 'drop', file: name, size: file.size, target: D.describe(target) };
}

/** Upload bytes (base64 or a fresh screenshot) instead of a local path. */
async function uploadBytes(tab, params) {
  let b64 = params.imageBase64 || null;
  let mime = params.mimeType || 'image/png';
  let name = params.fileName || 'image.png';
  if (params.fromScreenshot) {
    const shot = await handleScreenshot({
      tabId: params.screenshotTabId ?? tab.id, format: 'png',
      ...(params.region ? { region: params.region } : {}),
    });
    if (!shot?.data) throw new Error('Screenshot for upload returned no data');
    b64 = shot.data;
    mime = 'image/png';
    name = params.fileName || 'screenshot.png';
  }
  if (!b64) throw new Error('imageBase64 or fromScreenshot required');
  const res = await execDom(tab.id, pagePutFile, [
    params.ref || null, params.selector || null, getFallback(tab.id, params.ref),
    b64, mime, name, params.x ?? null, params.y ?? null,
  ]);
  return res;
}

export async function handleUploadFile(params) {
  const { tabId, ref, selector, filePath, files: fileList } = params;
  const tab = await resolveTab(tabId);
  if (params.imageBase64 || params.fromScreenshot) return uploadBytes(tab, params);
  const filePaths = fileList || (filePath ? [filePath] : []);
  if (filePaths.length === 0) throw new Error('filePath, files, imageBase64 or fromScreenshot required');

  // Resolve in the page with the shared resolver (ref registry, visible-first
  // selector across shadow roots / same-origin frames, verified fallback), then
  // hand the node to CDP through a one-shot marker attribute.
  const sel = selector || (ref ? null : 'input[type="file"]');
  const what = selector || (ref ? `ref ${ref}` : 'input[type="file"]');
  const token = `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const check = await execDom(tab.id, (_ref, _sel, _fb, _token) => {
    const D = globalThis.__bcDom;
    if (!D) return { __needDom: true };
    const el = D.resolve(_ref, _sel, _fb).el;
    if (!el) return { found: false };
    el.setAttribute('data-bc-upload', _token);
    return {
      found: true,
      isFileInput: el.tagName === 'INPUT' && el.type === 'file',
      multiple: !!el.multiple,
    };
  }, [ref || null, sel, getFallback(tab.id, ref), token]).catch(() => null);
  if (!check || !check.found) throw new Error(`File input not found: ${what}`);
  if (!check.isFileInput) throw new Error(`Element matching ${what} is not an <input type="file">.`);
  if (filePaths.length > 1 && !check.multiple) {
    throw new Error(`File input matching ${what} does not accept multiple files.`);
  }

  // upload_file stays on CDP (DOM.setFileInputFiles is CDP-only).
  try {
    const send = await ensureCdp(tab.id);
    // Find the marked node wherever it lives (open shadow roots, same-origin frames).
    const { result } = await send('Runtime.evaluate', { expression: findMarkedExpression(token) });
    if (!result || !result.objectId) throw new Error(`File input not found: ${what}`);
    // Chromium fires `input` and `change` itself on the file input here (checked
    // in a real browser): no event is dispatched by hand, or each would fire twice.
    await send('DOM.setFileInputFiles', { files: filePaths, objectId: result.objectId });
  } finally {
    // Always remove the one-shot marker (and the Observation V2 handoff marker).
    try {
      await execDom(tab.id, (_token) => {
        const D = globalThis.__bcDom;
        if (!D) return { __needDom: true };
        const el = (D.queryAll(`[data-bc-upload="${_token}"]`, true) || [])[0];
        if (!el) return null;
        el.removeAttribute('data-bc-upload');
        el.removeAttribute('data-bc-v2-upload');
        return null;
      }, [token]);
    } catch { /* page changed — CDP outcome still determines the tool result */ }
  }

  // Basenames only: the agent does not need (and should not echo) local directories.
  return { success: true, files: filePaths.map((p) => String(p).split(/[\\/]/).pop()), selector: what };
}
