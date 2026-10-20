/**
 * CDP-backed file upload (extracted from background.js): DOM.setFileInputFiles
 * cannot be done with chrome.scripting.
 */
import { resolveTab, execDom, getFallback } from '../lib/page-exec.js';
import { ensureCdp } from '../lib/cdp-session.js';
import { handleScreenshot } from './tabs.js';

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
    await send('DOM.setFileInputFiles', { files: filePaths, objectId: result.objectId });
  } finally {
    // Remove the one-shot marker.
    // DOM.setFileInputFiles already fires input + change, as a user's pick does:
    // firing them again ran React/Vue onChange twice.
    try {
      await execDom(tab.id, (_token) => {
        const D = globalThis.__bcDom;
        if (!D) return { __needDom: true };
        const el = (D.queryAll(`[data-bc-upload="${_token}"]`, true) || [])[0];
        if (!el) return null;
        el.removeAttribute('data-bc-upload');
        return null;
      }, [token]);
    } catch { /* page changed — CDP outcome still determines the tool result */ }
  }

  return { success: true, files: filePaths, selector: what };
}
