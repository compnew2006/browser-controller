/**
 * Screenshot handler (browser_screenshot, Browser Controller 3.0): one JPEG of a
 * tab's viewport, of one element (`target`) or of one viewport rectangle (`region`).
 *  - the active tab of its window: chrome.tabs.captureVisibleTab (no debugger, no
 *    tab switch);
 *  - a background tab: CDP Page.captureScreenshot, never activating it. When CDP
 *    cannot capture it, the call fails (DEBUGGER_UNAVAILABLE); the user's tab is not switched.
 * The longest side is at most MAX_IMAGE_EDGE and the base64 stays under
 * SCREENSHOT_MAX_BASE64_CHARS (one WebSocket frame). The result's `scale` and
 * `origin` map image pixels to viewport CSS px: viewportX = origin[0] + imageX / scale.
 */
import { resolveTab, safeExec, execDom, getFallback, assertResponsive, wedgedError, PAGE_EXEC_TIMEOUT_MS } from '../lib/page-exec.js';
import { refErrorMessage } from '../lib/ref-errors.js';
import { wedgedTabs, windowCaptureMutex } from '../lib/state.js';
import { hideLockShield, setAgentCursorHidden, agentCursorEnabled } from '../lib/overlay.js';
import { withCdp, ensureViewport } from '../lib/cdp-session.js';
import { raceReject } from '../lib/timing.js';
import { locateTarget, releaseShield } from '../lib/trusted-input.js';
import { parseTarget, targetLabel } from '../lib/target.js';

const CDP_CAPTURE_TIMEOUT_MS = 4000;
/**
 * A background tab usually does not paint, so Page.captureScreenshot may never
 * answer: give up after this long and report DEBUGGER_UNAVAILABLE.
 */
const BACKGROUND_PROBE_MS = 2500;
/** Longest side of a returned image, in image pixels (the size an image is read at in full). */
export const MAX_IMAGE_EDGE = 1568;
/**
 * Base64 characters one screenshot may carry. The bridge takes frames up to 1 MB
 * (bridge.ts MAX_WS_MESSAGE_BYTES, BC_MAX_WS_MESSAGE_BYTES); the rest of the frame
 * is the JSON envelope. Keep in step with that default.
 */
export const SCREENSHOT_MAX_BASE64_CHARS = 900_000;
const JPEG_QUALITY = 80;
const MIN_SCALE = 0.05;
/** Removed in 3.0 and changing WHAT is captured: a call that sends one is refused, never answered with another picture. */
const REFUSED_OPTIONS = ['fullPage', 'scale', 'ref', 'selector'];

function coded(code, message, cause) {
  const err = new Error(`${code}: ${message}`, cause ? { cause } : undefined);
  err.code = code;
  return err;
}

/**
 * One shield step (a page script). A page that does not answer it within the page-call
 * budget is marked wedged the way safeExec marks a first-time timeout, and the call fails
 * TAB_WEDGED. A tab already marked was probed by assertResponsive before this runs.
 * The steps swallow their own errors, so a rejection here is the timeout.
 */
function shieldStep(tabId, step) {
  return raceReject(step(), PAGE_EXEC_TIMEOUT_MS, 'shield step timed out').catch(() => {
    wedgedTabs.set(tabId, Date.now());
    throw wedgedError(tabId, PAGE_EXEC_TIMEOUT_MS);
  });
}

/** Pixel size of a base64 PNG/JPEG (null if it can't be read). */
export function imageSize(b64) {
  let bin;
  try { bin = atob(String(b64).slice(0, 87_384)); } catch { return null; }
  const at = (i) => bin.charCodeAt(i);
  if (bin.length > 24 && at(0) === 0x89 && bin.slice(1, 4) === 'PNG') {
    return { width: ((at(16) << 24) | (at(17) << 16) | (at(18) << 8) | at(19)) >>> 0, height: ((at(20) << 24) | (at(21) << 16) | (at(22) << 8) | at(23)) >>> 0 };
  }
  if (at(0) === 0xff && at(1) === 0xd8) {
    let i = 2;
    while (i + 9 < bin.length) {
      if (at(i) !== 0xff) { i++; continue; }
      const marker = at(i + 1);
      const len = (at(i + 2) << 8) | at(i + 3);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { width: (at(i + 7) << 8) | at(i + 8), height: (at(i + 5) << 8) | at(i + 6) };
      }
      i += 2 + len;
    }
  }
  return null;
}

/**
 * The image scale for a capture of cssW × cssH CSS px at device ratio dpr, cut down
 * when the longest device-pixel side would exceed MAX_IMAGE_EDGE. `edgeClamped` is
 * true when that rule (not the caller) cut it.
 */
export function planScale({ cssW, cssH, dpr, scale }) {
  const edgeLimit = MAX_IMAGE_EDGE / (Math.max(cssW, cssH) * dpr);
  const edgeClamped = scale > edgeLimit;
  return { scale: edgeClamped ? edgeLimit : scale, edgeClamped };
}

/**
 * Bring an encoded JPEG under the frame budget: each try lowers the quality and
 * shrinks the scale by the size ratio (with a margin). `redo({quality, scale})`
 * encodes the picture again. Throws SCREENSHOT_TOO_LARGE when no try fits.
 */
export async function fitToBudget(first, redo, budget = SCREENSHOT_MAX_BASE64_CHARS) {
  let shot = first;
  for (let tries = 0; shot.data.length > budget && tries < 3; tries++) {
    const ratio = Math.min(0.95, Math.sqrt(budget / shot.data.length) * 0.9);
    const next = { quality: Math.max(40, shot.quality - 15), scale: shot.scale * ratio };
    if (next.scale < MIN_SCALE) break;
    shot = await redo(next);
  }
  if (shot.data.length > budget) {
    throw coded('SCREENSHOT_TOO_LARGE', `the image is still ${Math.round(shot.data.length / 1000)} KB at ${shot.width}×${shot.height} after downscaling (limit ${Math.round(budget / 1000)} KB). Ask for a smaller target or region.`);
  }
  return shot;
}

const errText = (err) => String(err?.message || err).slice(0, 200);

function b64ToBlob(b64, type) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

async function blobToB64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Device pixels per CSS pixel: window.devicePixelRatio, else the layout-metrics ratio. */
async function pageDpr(send, metrics, vv) {
  try {
    const r = await raceReject(send('Runtime.evaluate', { expression: 'window.devicePixelRatio', returnByValue: true }), 1500, 'devicePixelRatio timed out');
    const v = Number(r?.result?.value);
    if (v > 0 && v < 16) return v;
  } catch { /* frozen or restricted page: fall back */ }
  return metrics.visualViewport?.clientWidth > 0 ? metrics.visualViewport.clientWidth / vv.clientWidth : 1;
}

/**
 * The part of a w × h viewport (CSS px) a crop covers: the crop cut to the viewport.
 * `clipped` when the crop reached past it.
 */
function cropOf(w, h, crop) {
  if (!crop) return { originX: 0, originY: 0, width: w, height: h, clipped: false };
  const originX = Math.max(0, Math.min(crop.x, w - 1));
  const originY = Math.max(0, Math.min(crop.y, h - 1));
  const right = Math.max(originX + 1, Math.min(w, crop.x + crop.width));
  const bottom = Math.max(originY + 1, Math.min(h, crop.y + crop.height));
  return {
    originX,
    originY,
    width: right - originX,
    height: bottom - originY,
    clipped: crop.x < 0 || crop.y < 0 || crop.x + crop.width > w || crop.y + crop.height > h,
  };
}

/** The pixel → viewport mapping of a picture: viewportX = origin[0] + imageX / scale. */
function frameOf(imageWidth, cssWidth, view, vp) {
  return {
    scale: Math.round((imageWidth / cssWidth) * 1000) / 1000,
    origin: [Math.round(view.originX), Math.round(view.originY)],
    viewport: [Math.round(vp.width), Math.round(vp.height)],
  };
}

/** CSS size of the page's viewport (innerWidth × innerHeight), or null when the page does not answer. */
async function viewportOf(tabId) {
  try {
    const v = await safeExec(tabId, () => [window.innerWidth, window.innerHeight]);
    return Array.isArray(v) && v[0] > 0 ? { width: v[0], height: v[1] } : null;
  } catch {
    return null;
  }
}

/**
 * CDP capture (Page.captureScreenshot, debugger attached) of the viewport, or of
 * `crop` inside it. A background tab is captured this way, and it never switches.
 */
async function cdpCapture(tabId, crop, timeoutMs) {
  return withCdp(tabId, async (send) => {
    let metrics = await send('Page.getLayoutMetrics');
    if (!(metrics?.cssVisualViewport?.clientWidth > 0)) {
      await ensureViewport(tabId);
      metrics = await send('Page.getLayoutMetrics');
    }
    const vv = metrics.cssVisualViewport;
    const view = cropOf(vv.clientWidth, vv.clientHeight, crop);
    // The capture comes out at clip.scale × devicePixelRatio (device pixels). The
    // layout metrics can't be trusted for that ratio (real Chrome at DPR 2 reports
    // equal device and CSS viewport widths), so ask the page.
    const dpr = await pageDpr(send, metrics, vv);
    const plan = planScale({ cssW: view.width, cssH: view.height, dpr, scale: 1 });
    const once = async ({ quality, scale }) => {
      const { data } = await raceReject(send('Page.captureScreenshot', {
        format: 'jpeg',
        quality,
        clip: { x: vv.pageX + view.originX, y: vv.pageY + view.originY, width: view.width, height: view.height, scale },
      }), timeoutMs, 'Page.captureScreenshot timed out');
      const size = imageSize(data) || { width: Math.round(view.width * scale * dpr), height: Math.round(view.height * scale * dpr) };
      return { data, quality, scale, width: size.width, height: size.height };
    };
    const first = await once({ quality: JPEG_QUALITY, scale: plan.scale });
    const shot = await fitToBudget(first, once);
    return {
      data: shot.data,
      width: shot.width,
      height: shot.height,
      frame: frameOf(shot.width, view.width, view, { width: vv.clientWidth, height: vv.clientHeight }),
      edgeClamped: plan.edgeClamped,
      refit: shot !== first,
      clipped: view.clipped,
      via: 'cdp',
    };
  });
}

/**
 * The active tab, from captureVisibleTab: the viewport as it is on screen, cropped
 * and downscaled here, so the picture is what the user sees. Callers hold
 * windowCaptureMutex and the tab is the window's active tab.
 */
async function visibleScreenshot(tab, crop, protectedPage) {
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  const [shown] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
  if (shown?.id !== tab.id) throw coded('TAB_NOT_VISIBLE', 'the tab was switched away while it was captured.');
  const bmp = await createImageBitmap(b64ToBlob(dataUrl.slice(dataUrl.indexOf(',') + 1), 'image/png'));
  try {
    // Read the size now: a closed bitmap reports 0.
    const imgW = bmp.width;
    const imgH = bmp.height;
    // The page's CSS viewport gives the device pixel ratio: image px / CSS px.
    const vp = protectedPage ? null : await viewportOf(tab.id);
    if (crop && !vp) throw coded('UNSUPPORTED', 'the page did not report its size, so an element or region cannot be cropped.');
    const dpr = vp ? imgW / vp.width : 1;
    const cssW = imgW / dpr;
    const cssH = imgH / dpr;
    const view = cropOf(cssW, cssH, crop);
    const sx = Math.round(view.originX * dpr);
    const sy = Math.round(view.originY * dpr);
    const sw = Math.max(1, Math.min(Math.round(view.width * dpr), imgW - sx));
    const sh = Math.max(1, Math.min(Math.round(view.height * dpr), imgH - sy));
    const plan = planScale({ cssW: sw / dpr, cssH: sh / dpr, dpr, scale: 1 });
    const encode = async ({ quality, scale }) => {
      const w = Math.max(1, Math.round(sw * scale));
      const h = Math.max(1, Math.round(sh * scale));
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, w, h);
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: quality / 100 });
      return { data: await blobToB64(blob), quality, scale, width: w, height: h };
    };
    const first = await encode({ quality: JPEG_QUALITY, scale: plan.scale });
    const shot = await fitToBudget(first, encode);
    return {
      data: shot.data,
      width: shot.width,
      height: shot.height,
      ...(vp ? { frame: frameOf(shot.width, sw / dpr, view, vp) } : {}),
      edgeClamped: plan.edgeClamped,
      refit: shot !== first,
      clipped: view.clipped,
      via: 'visible',
    };
  } finally {
    bmp.close?.();
  }
}

/** A CDP capture that failed is DEBUGGER_UNAVAILABLE: the caller learns the picture is not there. */
async function debuggerShot(tabId, crop, timeoutMs) {
  try {
    return await cdpCapture(tabId, crop, timeoutMs);
  } catch (err) {
    throw coded('DEBUGGER_UNAVAILABLE', `the debugger could not capture the tab (${errText(err)}).`, err);
  }
}

/**
 * One picture, by where the tab is. The active tab comes from captureVisibleTab; if
 * that fails, CDP is tried. A background tab is captured over CDP without being
 * activated: when that fails, the call fails too (no tab switch).
 */
async function takeShot(tab, crop, protectedPage) {
  if (!tab.active) return debuggerShot(tab.id, crop, BACKGROUND_PROBE_MS);
  try {
    return await windowCaptureMutex.run(tab.windowId, () => visibleScreenshot(tab, crop, protectedPage));
  } catch (err) {
    // A page the debugger cannot reach has no second way; a picture that is too big or has no size would fail the same over CDP.
    if (protectedPage || ['SCREENSHOT_TOO_LARGE', 'UNSUPPORTED'].includes(err?.code)) throw err;
    return { ...(await debuggerShot(tab.id, crop, CDP_CAPTURE_TIMEOUT_MS)), cdpFallback: errText(err) };
  }
}

/** Page side (self-contained, serialized): the top-level viewport box of the element a target resolves to. */
function pageBoxOf(t, fb) {
  const D = globalThis.__bcDom;
  if (!D || !D.resolveTarget) return { __needDom: true };
  const hit = D.resolveTarget(t, fb);
  if (hit.error) return { error: hit.error };
  const el = hit.el;
  if (!el || el.nodeType !== 1) return { error: 'REF_GONE' };
  const { x, y, rect } = D.centerOf(el);
  if (!(rect.width > 0 && rect.height > 0)) return { error: 'ELEMENT_HIDDEN: the element has no visible box (hidden or zero-size).' };
  return { region: { x: x - rect.width / 2, y: y - rect.height / 2, width: rect.width, height: rect.height } };
}

/**
 * The box of `target` in viewport CSS px. The locator (lib/trusted-input.js) resolves
 * it and scrolls it into view, with the wording of every target error; the box is
 * then read from the same element.
 */
async function elementBox(tabId, target, parsed) {
  let loc = await locateTarget(tabId, { target });
  if (loc?.success && loc.zeroViewport) {
    // A tab never shown has no layout yet (0x0): size it over CDP, then measure again.
    await withCdp(tabId, () => ensureViewport(tabId));
    loc = await locateTarget(tabId, { target });
    if (loc?.zeroViewport) throw coded('UNSUPPORTED', 'the tab has no layout (0x0 viewport), so the element cannot be measured.');
  }
  if (!loc?.success) throw new Error(loc?.error || `NOT_FOUND: ${targetLabel(target)} matches nothing.`);
  if (!loc.visible) throw coded('ELEMENT_HIDDEN', `${targetLabel(target)} has no visible box (hidden or zero-size).`);
  const fb = parsed.kind === 'ref' ? getFallback(tabId, parsed.ref) : null;
  const box = await execDom(tabId, pageBoxOf, [parsed, fb]);
  if (box?.error === 'REF_GONE') throw new Error(refErrorMessage(parsed.ref, fb));
  if (!box || box.error) throw new Error(box?.error || `NOT_FOUND: ${targetLabel(target)} matches nothing.`);
  return box.region;
}

/**
 * Validates the call; returns the parsed target (null without one). format, quality
 * and maxWidth (removed in 3.0) are ignored: the picture is always a JPEG and the
 * result states its real size.
 */
function checkRequest(params) {
  for (const name of REFUSED_OPTIONS) {
    if (params[name] !== undefined && params[name] !== null && params[name] !== false) {
      throw coded('INVALID_ARGUMENT', `${name} is not a browser_screenshot option in 3.0. Use target (one element) or region (a viewport rectangle).`);
    }
  }
  if (params.target != null && params.region != null) throw coded('INVALID_ARGUMENT', 'give target or region, not both.');
  const { region } = params;
  if (region != null && !([region.x, region.y, region.width, region.height].every(Number.isFinite) && region.width > 0 && region.height > 0)) {
    throw coded('INVALID_ARGUMENT', 'region needs numeric x and y and a positive width and height (CSS px of the viewport).');
  }
  if (params.target == null) return null;
  const parsed = parseTarget(params.target);
  if (parsed.kind === 'point') throw coded('INVALID_ARGUMENT', 'a point is not an element: use region for a rectangle.');
  return parsed;
}

export async function handleScreenshot(params) {
  // The agent cursor stays out of the picture: it would cover what was just clicked.
  const cursor = !wedgedTabs.has(params.tabId) && await agentCursorEnabled();
  if (cursor) await setAgentCursorHidden(params.tabId, true);
  try {
    return await captureScreenshot(params);
  } finally {
    if (cursor) await setAgentCursorHidden(params.tabId, false);
  }
}

async function captureScreenshot(params) {
  const { tabId, target = null, region = null } = params;
  const parsed = checkRequest(params);
  const tab = await resolveTab(tabId);
  const protectedPage = /^(chrome|chrome-extension|devtools|edge|about):/i.test(tab.url || '');
  // The router shows the shield for this call: take it out of the picture for the
  // capture. The router removes it when the call ends.
  if (!protectedPage) {
    // A frozen page answers no script: fail fast here, before any step waits on it.
    await assertResponsive(tabId);
    await shieldStep(tabId, () => hideLockShield(tabId));
  }
  try {
    const crop = target != null ? await elementBox(tabId, target, parsed) : region;
    const shot = await takeShot(tab, crop, protectedPage);
    const label = target != null ? `element ${targetLabel(target)}` : (region ? 'region' : 'viewport');
    const notes = [
      ...(shot.clipped ? ['clipped to the viewport'] : []),
      ...(shot.edgeClamped ? [`scaled down to a ${MAX_IMAGE_EDGE} px longest side`] : []),
      ...(shot.refit ? ['reduced to fit the 1 MB frame limit'] : []),
    ];
    return {
      success: true,
      text: `${shot.width}x${shot.height} jpeg, ${label}${notes.length ? ` (${notes.join('; ')})` : ''}`,
      image: { data: shot.data, mimeType: 'image/jpeg' },
      width: shot.width,
      height: shot.height,
      via: shot.via,
      ...(shot.frame ? { scale: shot.frame.scale, origin: shot.frame.origin, viewport: shot.frame.viewport } : {}),
      ...(shot.cdpFallback ? { cdpFallback: shot.cdpFallback } : {}),
    };
  } finally {
    // The input window the locate opened (pageLocate, lib/trusted-input.js) closes with the call.
    if (target != null) await releaseShield(tabId);
  }
}
