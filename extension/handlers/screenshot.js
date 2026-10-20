/**
 * Screenshot handler (split out of tabs.js). One picture of a tab, sized for the
 * agent (longest side at most MAX_IMAGE_EDGE) and fitted under the 1 MB frame
 * limit. The active tab's viewport is read with captureVisibleTab (no debugger,
 * no tab switch); a full page or a zoom needs CDP.
 */
import { resolveTab, safeExec, execDom, getFallback } from '../lib/page-exec.js';
import { refErrorMessage } from '../lib/ref-errors.js';
import { tabLocks, wedgedTabs, windowCaptureMutex } from '../lib/state.js';
import { showLockShield, hideLockShield, setAgentCursorHidden, agentCursorEnabled } from '../lib/overlay.js';
import { withCdp, ensureViewport } from '../lib/cdp-session.js';

const CDP_CAPTURE_TIMEOUT_MS = 4000;
/**
 * A background tab usually does not paint, so Page.captureScreenshot may never
 * answer: probe it this briefly, then show the tab the old way.
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
/** A full-page capture is cut at this height (the result says so). */
export const FULL_PAGE_MAX_HEIGHT = 16_000;
const MIN_SCALE = 0.05;

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms); }),
  ]).finally(() => clearTimeout(timer));
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
 * The image scale for a capture of cssW × cssH CSS px at device ratio dpr: the
 * requested scale, cut down so the longest side fits MAX_IMAGE_EDGE and the width
 * fits maxWidth. `edgeClamped` is true when the edge rule (not the caller) cut it.
 */
export function planScale({ cssW, cssH, dpr, scale, maxWidth }) {
  const edgeLimit = MAX_IMAGE_EDGE / (Math.max(cssW, cssH) * dpr);
  let s = scale;
  const edgeClamped = s > edgeLimit;
  if (edgeClamped) s = edgeLimit;
  if (maxWidth && cssW * s * dpr > maxWidth) s = maxWidth / (cssW * dpr);
  return { scale: s, edgeClamped };
}

/**
 * Bring an encoded screenshot under the frame budget. A PNG first becomes a JPEG
 * at the same size; each later try shrinks the scale by the size ratio (with a
 * margin) and lowers the JPEG quality. `redo({format, quality, scale})` makes the
 * image for those settings. Throws SCREENSHOT_TOO_LARGE when no try fits.
 */
export async function fitToBudget(first, redo, budget = SCREENSHOT_MAX_BASE64_CHARS) {
  let shot = first;
  for (let tries = 0; shot.data.length > budget && tries < 3; tries++) {
    const ratio = Math.min(0.95, Math.sqrt(budget / shot.data.length) * 0.9);
    const next = shot.format === 'png'
      ? { format: 'jpeg', quality: 80, scale: shot.scale }
      : { format: 'jpeg', quality: Math.max(40, shot.quality - 15), scale: shot.scale * ratio };
    if (next.scale < MIN_SCALE) break;
    shot = await redo(next);
  }
  if (shot.data.length > budget) {
    const err = new Error(`SCREENSHOT_TOO_LARGE: the image is still ${Math.round(shot.data.length / 1000)} KB at ${shot.width}×${shot.height} after downscaling (limit ${Math.round(budget / 1000)} KB). Ask for a smaller region, a scale below 1 or a maxWidth.`);
    err.code = 'SCREENSHOT_TOO_LARGE';
    throw err;
  }
  return shot;
}

/** Notes for the result: what changed the picture from what was asked (the agent must know it is not 1:1). */
function shotNotes({ edgeClamped, truncatedFrom, refit, format }) {
  const notes = [];
  if (edgeClamped) notes.push(`scaled down to a ${MAX_IMAGE_EDGE} px longest side`);
  if (truncatedFrom) notes.push(`the page is ${truncatedFrom} px tall; only the first ${FULL_PAGE_MAX_HEIGHT} px were captured`);
  if (refit) notes.push(`reduced to fit the 1 MB frame limit (${format})`);
  return notes.length ? notes.join('; ') : null;
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
    const r = await withTimeout(send('Runtime.evaluate', { expression: 'window.devicePixelRatio', returnByValue: true }), 1500, 'devicePixelRatio');
    const v = Number(r?.result?.value);
    if (v > 0 && v < 16) return v;
  } catch { /* frozen or restricted page: fall back */ }
  return metrics.visualViewport?.clientWidth > 0 ? metrics.visualViewport.clientWidth / vv.clientWidth : 1;
}

/**
 * CDP capture (Page.captureScreenshot) with the debugger attached. Needed for a
 * full page and for zoom (a scale above 1 re-renders the page instead of
 * stretching pixels), and it is the only way to capture a background tab
 * without switching to it.
 */
async function cdpScreenshot(tabId, { format, quality, scale, maxWidth, fullPage, region, timeoutMs = CDP_CAPTURE_TIMEOUT_MS }) {
  return withCdp(tabId, async (send) => {
    let metrics = await send('Page.getLayoutMetrics');
    if (!(metrics?.cssVisualViewport?.clientWidth > 0)) {
      await ensureViewport(tabId);
      metrics = await send('Page.getLayoutMetrics');
    }
    const vv = metrics.cssVisualViewport;
    const content = metrics.cssContentSize || metrics.contentSize;
    // region: a viewport rectangle (CSS px, same frame as click/hover x/y) —
    // zoom into small UI with scale > 1.
    let originX = 0;
    let originY = 0;
    let width = fullPage ? Math.ceil(content.width) : vv.clientWidth;
    let height = fullPage ? Math.ceil(content.height) : vv.clientHeight;
    const pageHeight = height;
    if (fullPage && !region) height = Math.min(height, FULL_PAGE_MAX_HEIGHT);
    if (region) {
      originX = Math.max(0, Math.min(region.x, vv.clientWidth - 1));
      originY = Math.max(0, Math.min(region.y, vv.clientHeight - 1));
      width = Math.max(1, Math.min(region.width, vv.clientWidth - originX));
      height = Math.max(1, Math.min(region.height, vv.clientHeight - originY));
    }
    const fullClip = !!fullPage && !region;
    // The capture comes out at clip.scale × devicePixelRatio (device pixels).
    // The layout metrics can't be trusted for that ratio (real Chrome at DPR 2
    // reports equal device and CSS viewport widths), so ask the page.
    const dpr = await pageDpr(send, metrics, vv);
    const requested = Math.min(region ? 4 : 1, Math.max(0.05, scale ?? (region ? 2 : 1)));
    const plan = planScale({ cssW: width, cssH: height, dpr, scale: requested, maxWidth });
    const once = async ({ format: f, quality: q, scale: s }) => {
      const { data } = await withTimeout(send('Page.captureScreenshot', {
        format: f,
        ...(f === 'jpeg' ? { quality: q } : {}),
        captureBeyondViewport: fullClip,
        clip: {
          x: fullClip ? 0 : vv.pageX + originX,
          y: fullClip ? 0 : vv.pageY + originY,
          width, height, scale: s,
        },
      }), timeoutMs, 'Page.captureScreenshot');
      const size = imageSize(data) || { width: Math.round(width * s * dpr), height: Math.round(height * s * dpr) };
      return { data, format: f, quality: q, scale: s, width: size.width, height: size.height };
    };
    let shot = await once({ format, quality, scale: plan.scale });
    // maxWidth is a promise about the IMAGE: if the ratio was still off, shrink
    // by what the real image shows and capture once more.
    if (maxWidth && shot.width > maxWidth + 1) {
      shot = await once({ format, quality, scale: shot.scale * (maxWidth / shot.width) });
    }
    const beforeFit = shot;
    shot = await fitToBudget(shot, once);
    // How image pixels map to the viewport coordinates click/hover/scroll take:
    // viewportX = origin[0] + imageX / scale (fullPage: page coordinates instead).
    // The real image size is the ground truth (it includes the device pixel
    // ratio: an 800 px viewport at DPR 2 is a 1600 px image, scale 2).
    return {
      data: shot.data,
      format: shot.format,
      width: shot.width,
      height: shot.height,
      frame: {
        scale: Math.round((shot.width / width) * 1000) / 1000,
        origin: [Math.round(originX), Math.round(originY)],
        viewport: [Math.round(vv.clientWidth), Math.round(vv.clientHeight)],
        ...(fullClip ? { page: true, scrollY: Math.round(vv.pageY) } : {}),
      },
      note: shotNotes({
        edgeClamped: plan.edgeClamped,
        truncatedFrom: fullClip && pageHeight > FULL_PAGE_MAX_HEIGHT ? pageHeight : 0,
        refit: shot !== beforeFit,
        format: shot.format,
      }),
    };
  });
}

/**
 * CSS size of the page's viewport (innerWidth × innerHeight), or null when the
 * page does not answer. Without it the picture is still right, but it carries no
 * coordinate frame (no toViewport mapping is claimed).
 */
async function viewportOf(tabId) {
  try {
    const v = await safeExec(tabId, () => [window.innerWidth, window.innerHeight]);
    return Array.isArray(v) && v[0] > 0 ? { width: v[0], height: v[1] } : null;
  } catch {
    return null;
  }
}

/**
 * The visible viewport from captureVisibleTab: no debugger and no tab switch.
 * Crops (region) and downscales in the service worker, so the picture is what
 * was on screen. Callers hold windowCaptureMutex and the tab is the window's active tab.
 */
async function visibleScreenshot(tab, { format, quality, scale, maxWidth, region, protectedPage }) {
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  const [shown] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
  if (shown?.id !== tab.id) throw new Error('TAB_NOT_VISIBLE: the tab was switched away while it was captured.');
  const bmp = await createImageBitmap(b64ToBlob(dataUrl.slice(dataUrl.indexOf(',') + 1), 'image/png'));
  try {
    // Read the size now: a closed bitmap reports 0 (the GIF marker depends on it).
    const imgW = bmp.width;
    const imgH = bmp.height;
    // The page's CSS viewport gives the device pixel ratio: image px / CSS px.
    const vp = protectedPage ? null : await viewportOf(tab.id);
    if (region && !vp) throw new Error('UNSUPPORTED: the page did not report its size, so a region cannot be cropped.');
    const dpr = vp ? imgW / vp.width : 1;
    const cssW = imgW / dpr;
    const cssH = imgH / dpr;
    let originX = 0;
    let originY = 0;
    let sx = 0;
    let sy = 0;
    let sw = imgW;
    let sh = imgH;
    if (region) {
      originX = Math.max(0, Math.min(region.x, cssW - 1));
      originY = Math.max(0, Math.min(region.y, cssH - 1));
      sx = Math.round(originX * dpr);
      sy = Math.round(originY * dpr);
      sw = Math.max(1, Math.min(Math.round(region.width * dpr), imgW - sx));
      sh = Math.max(1, Math.min(Math.round(region.height * dpr), imgH - sy));
    }
    const plan = planScale({ cssW: sw / dpr, cssH: sh / dpr, dpr, scale: scale ?? 1, maxWidth });
    const encode = async ({ format: f, quality: q, scale: s }) => {
      const w = Math.max(1, Math.round(sw * s));
      const h = Math.max(1, Math.round(sh * s));
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, w, h);
      const blob = await canvas.convertToBlob(f === 'jpeg' ? { type: 'image/jpeg', quality: q / 100 } : { type: 'image/png' });
      return { data: await blobToB64(blob), format: f, quality: q, scale: s, width: w, height: h };
    };
    const first = await encode({ format, quality, scale: plan.scale });
    const shot = await fitToBudget(first, encode);
    return {
      data: shot.data,
      format: shot.format,
      width: shot.width,
      height: shot.height,
      // viewportX = origin[0] + imageX / scale, as for the CDP capture.
      ...(vp ? {
        frame: {
          scale: Math.round((shot.width / (sw / dpr)) * 1000) / 1000,
          origin: [Math.round(originX), Math.round(originY)],
          viewport: [Math.round(vp.width), Math.round(vp.height)],
        },
      } : {}),
      note: shotNotes({ edgeClamped: plan.edgeClamped, refit: shot !== first, format: shot.format }),
    };
  } finally {
    bmp.close?.();
  }
}

/**
 * Show a background tab for the capture and switch straight back. This steals
 * the user's view for a moment, so it is only the fallback for when the debugger
 * cannot capture the hidden tab.
 */
function showBriefly(tab, opts, protectedPage) {
  const needsCdp = opts.fullPage || opts.scale > 1;
  return windowCaptureMutex.run(tab.windowId, async () => {
    const [previousActive] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    await chrome.tabs.update(tab.id, { active: true });
    try {
      await new Promise((r) => setTimeout(r, 150));
      const shot = needsCdp
        ? await cdpScreenshot(tab.id, opts)
        : await visibleScreenshot(tab, { ...opts, protectedPage });
      return { ...shot, via: needsCdp ? 'cdp-activated' : 'visible-activated' };
    } finally {
      if (previousActive?.id != null && previousActive.id !== tab.id) {
        await chrome.tabs.update(previousActive.id, { active: true }).catch(() => {});
      }
    }
  });
}

/** Top-level viewport box of a ref/selector target (4 px margin), scrolled into
 * view first; `clipped` when the element does not fit the viewport.
 */
async function elementRegion(tabId, ref, selector) {
  return execDom(tabId, (_ref, _sel, _fb) => {
    const D = globalThis.__bcDom;
    if (!D) return { __needDom: true };
    const el = D.resolve(_ref, _sel, _fb).el;
    if (!el) return { success: false, error: 'Element not found' };
    el.scrollIntoView({ behavior: 'instant', block: 'nearest', inline: 'nearest' });
    const { x, y, rect } = D.centerOf(el);
    if (!(rect.width > 0 && rect.height > 0)) return { success: false, error: 'Element has no visible box (hidden or zero-size)' };
    const pad = 4;
    const left = x - rect.width / 2 - pad;
    const top = y - rect.height / 2 - pad;
    const width = rect.width + 2 * pad;
    const height = rect.height + 2 * pad;
    return {
      success: true,
      region: { x: Math.max(0, left), y: Math.max(0, top), width, height },
      clipped: left < 0 || top < 0 || left + width > innerWidth || top + height > innerHeight,
    };
  }, [ref ?? null, selector ?? null, getFallback(tabId, ref)]);
}

/**
 * How one picture is taken:
 *  - the active tab, plain viewport: captureVisibleTab (no debugger, no tab switch);
 *  - the active tab, full page or zoom: CDP;
 *  - a background tab: CDP without switching to it, else show it briefly.
 */
async function takeShot(tab, opts, protectedPage) {
  if (!tab.active) {
    // Chrome may not paint a hidden tab, so the debugger capture can hang: probe briefly.
    try {
      return { ...(await cdpScreenshot(tab.id, { ...opts, timeoutMs: BACKGROUND_PROBE_MS })), via: 'cdp' };
    } catch (err) {
      return { ...(await showBriefly(tab, opts, protectedPage)), cdpFallback: errText(err) };
    }
  }
  const needsCdp = opts.fullPage || opts.scale > 1;
  let fallback = null;
  if (needsCdp) {
    try {
      return { ...(await cdpScreenshot(tab.id, opts)), via: 'cdp' };
    } catch (err) {
      if (opts.fullPage) throw new Error(`UNSUPPORTED: a full-page screenshot needs the debugger, which failed (${errText(err)}).`, { cause: err });
      // Zoom without the debugger: the plain viewport, which is honest, not an upscaled smear.
      fallback = errText(err);
      opts = { ...opts, scale: 1 };
    }
  }
  try {
    const shot = await windowCaptureMutex.run(tab.windowId, () => visibleScreenshot(tab, { ...opts, protectedPage }));
    return { ...shot, via: 'visible', ...(fallback ? { cdpFallback: fallback } : {}) };
  } catch (err) {
    // A page the debugger can't reach (chrome://) has no other way; a picture that
    // is too big would be too big over CDP too; the rest may still be captured over CDP.
    if (needsCdp || protectedPage || err?.code === 'SCREENSHOT_TOO_LARGE') throw err;
    try {
      return { ...(await cdpScreenshot(tab.id, opts)), via: 'cdp', cdpFallback: errText(err) };
    } catch (cdpErr) {
      throw new Error(`${errText(err)}; the debugger capture also failed: ${errText(cdpErr)}`, { cause: cdpErr });
    }
  }
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
  const { tabId, format = 'png', quality = 80, maxWidth, fullPage = false, ref, selector } = params;
  let { scale, region } = params;
  const tab = await resolveTab(tabId);
  // ref / selector: just that element (an explicit region wins).
  let element = null;
  if ((ref || selector) && !region) {
    element = await elementRegion(tabId, ref, selector);
    if (!element?.success) {
      if (ref && (!element || element.error === 'Element not found')) {
        return { success: false, error: refErrorMessage(ref, getFallback(tabId, ref)) };
      }
      return element || { success: false, error: 'Element not found' };
    }
    region = element.region;
    scale = scale ?? 1; // a region zooms 2× by default; an element is shown as it is
  }
  const protectedPage = /^(chrome|chrome-extension|devtools|edge|about):/i.test(tab.url || '');
  // Effective scale: a region zooms 2× by default (up to 4); the viewport and a page are at most 1.
  const effective = Math.min(region ? 4 : 1, Math.max(0.05, scale ?? (region ? 2 : 1)));
  const opts = { format, quality, scale: effective, maxWidth, fullPage, region };
  // The shield is shown during EVERY agent action (router), not only while
  // locked — always take it out of the picture; the router restores it.
  const wasLocked = !!tabLocks.owner(tabId);
  if (!protectedPage) await hideLockShield(tabId);
  try {
    const shot = await takeShot(tab, opts, protectedPage);
    return {
      success: true,
      format: shot.format,
      via: shot.via,
      width: shot.width,
      height: shot.height,
      ...(shot.frame ? { frame: shot.frame } : {}),
      ...(shot.note ? { note: shot.note } : {}),
      ...(shot.cdpFallback ? { cdpFallback: shot.cdpFallback } : {}),
      ...(element ? { element: { clipped: element.clipped } } : {}),
      data: shot.data,
    };
  } finally {
    if (!protectedPage && wasLocked) await showLockShield(tabId);
  }
}

