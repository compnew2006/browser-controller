/**
 * Tab + debug-capture handlers (extracted from background.js): tabs
 * lifecycle (list/create/close/focus/lock/unlock), console/network reads,
 * screenshot.
 */
import { resolveTab, replaceFrozenTab, safeExec } from '../lib/page-exec.js';
import {
  tabLocks,
  wedgedTabs,
  windowCaptureMutex,
  consoleByTab,
  networkByTab,
  getTabBuffer,
  persistSessionState,
} from "../lib/state.js";
import { showLockShield, hideLockShield } from "../lib/overlay.js";
import { broadcastStatus } from "../lib/connection.js";
import { lockTabUi, releaseTabUi } from "../lib/lock-ops.js";
import { withCdp, ensureViewport } from '../lib/cdp-session.js';

const CDP_CAPTURE_TIMEOUT_MS = 4000;

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
 * CDP capture (Page.captureScreenshot): works on a tab that is NOT the active
 * one in its window, so the user's view is never switched, and can downscale
 * (`scale`) or cap the width (`maxWidth`) to save image tokens.
 */
/** Device pixels per CSS pixel: window.devicePixelRatio, else the layout-metrics ratio. */
async function pageDpr(send, metrics, vv) {
  try {
    const r = await withTimeout(send('Runtime.evaluate', { expression: 'window.devicePixelRatio', returnByValue: true }), 1500, 'devicePixelRatio');
    const v = Number(r?.result?.value);
    if (v > 0 && v < 16) return v;
  } catch { /* frozen or restricted page: fall back */ }
  return metrics.visualViewport?.clientWidth > 0 ? metrics.visualViewport.clientWidth / vv.clientWidth : 1;
}

async function cdpScreenshot(tabId, { format, quality, scale, maxWidth, fullPage, region }) {
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
    let height = fullPage ? Math.min(Math.ceil(content.height), 16_000) : vv.clientHeight;
    if (region) {
      originX = Math.max(0, Math.min(region.x, vv.clientWidth - 1));
      originY = Math.max(0, Math.min(region.y, vv.clientHeight - 1));
      width = Math.max(1, Math.min(region.width, vv.clientWidth - originX));
      height = Math.max(1, Math.min(region.height, vv.clientHeight - originY));
    }
    let s = Math.min(region ? 4 : 1, Math.max(0.05, scale ?? (region ? 2 : 1)));
    // The capture comes out at clip.scale × devicePixelRatio (device pixels).
    // The layout metrics can't be trusted for that ratio (real Chrome at DPR 2
    // reports equal device and CSS viewport widths), so ask the page.
    const dpr = await pageDpr(send, metrics, vv);
    if (maxWidth && width * s * dpr > maxWidth) s = maxWidth / (width * dpr);
    const capture = (clipScale) => withTimeout(send('Page.captureScreenshot', {
      format,
      ...(format === 'jpeg' ? { quality } : {}),
      captureBeyondViewport: !!fullPage && !region,
      clip: {
        x: fullPage && !region ? 0 : vv.pageX + originX,
        y: fullPage && !region ? 0 : vv.pageY + originY,
        width, height, scale: clipScale,
      },
    }), CDP_CAPTURE_TIMEOUT_MS, 'Page.captureScreenshot');
    let { data } = await capture(s);
    let size = imageSize(data);
    // maxWidth is a promise about the IMAGE: if the ratio was still off, shrink
    // by what the real image shows and capture once more.
    if (maxWidth && size?.width > maxWidth + 1) {
      s = s * (maxWidth / size.width);
      ({ data } = await capture(s));
      size = imageSize(data);
    }
    // How image pixels map to the viewport coordinates click/hover/scroll take:
    // viewportX = origin[0] + imageX / scale (fullPage: page coordinates instead).
    // The real image size is the ground truth (it includes the device pixel
    // ratio: an 800 px viewport at DPR 2 is a 1600 px image, scale 2).
    const imgW = size?.width || Math.round(width * s * dpr);
    const imgH = size?.height || Math.round(height * s * dpr);
    const frame = {
      scale: Math.round((imgW / width) * 1000) / 1000,
      origin: [Math.round(originX), Math.round(originY)],
      viewport: [Math.round(vv.clientWidth), Math.round(vv.clientHeight)],
      ...(fullPage && !region ? { page: true, scrollY: Math.round(vv.pageY) } : {}),
    };
    return { data, width: imgW, height: imgH, frame };
  });
}

export async function handleScreenshot(params) {
  const { tabId, format = 'png', quality = 80, scale, maxWidth, fullPage = false, region } = params;
  const tab = await resolveTab(tabId);
  const protectedPage = /^(chrome|chrome-extension|devtools|edge|about):/i.test(tab.url || '');
  let cdpError = null;
  if (!protectedPage) {
    // The shield is shown during EVERY agent action (router), not only while
    // locked — always take it out of the picture; the router restores it.
    const wasLocked = !!tabLocks.owner(tabId);
    await hideLockShield(tabId);
    const opts = { format, quality, scale, maxWidth, fullPage, region };
    const done = (shot, via) => ({ success: true, format, via, width: shot.width, height: shot.height, frame: shot.frame, data: shot.data });
    try {
      if (tab.active) {
        const shot = await cdpScreenshot(tabId, opts);
        if (shot?.data) return done(shot, 'cdp');
      } else {
        // A background tab produces no compositor frames (Page.captureScreenshot
        // just hangs, fromSurface:false too), so show it for a moment, capture
        // over CDP (keeps scale/maxWidth/fullPage) and switch straight back.
        const fg = await windowCaptureMutex.run(tab.windowId, async () => {
          const [previousActive] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
          await chrome.tabs.update(tabId, { active: true });
          try {
            await new Promise((r) => setTimeout(r, 150));
            return await cdpScreenshot(tabId, opts);
          } finally {
            if (previousActive?.id != null && previousActive.id !== tabId) {
              await chrome.tabs.update(previousActive.id, { active: true }).catch(() => {});
            }
          }
        });
        if (fg?.data) return done(fg, 'cdp-activated');
      }
    } catch (err) {
      // debugger unavailable or the hidden tab would not paint: fall back below
      cdpError = String(err?.message || err).slice(0, 200);
    } finally {
      if (wasLocked) await showLockShield(tabId);
    }
  }
  return windowCaptureMutex.run(tab.windowId, async () => {
    const [previousActive] = await chrome.tabs.query({
      active: true,
      windowId: tab.windowId,
    });
    const changedActiveTab = previousActive?.id !== tabId;
    if (changedActiveTab) {
      await chrome.tabs.update(tabId, { active: true });
      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    const wasLocked = !!tabLocks.owner(tabId);
    if (wasLocked) await hideLockShield(tabId);
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
        format,
        quality: format === "jpeg" ? quality : undefined,
      });
      return { success: true, format, data: dataUrl.split(",")[1], ...(cdpError ? { cdpFallback: cdpError } : {}) };
    } finally {
      if (wasLocked) await showLockShield(tabId);
      if (changedActiveTab && previousActive?.id != null) {
        const [currentActive] = await chrome.tabs.query({
          active: true,
          windowId: tab.windowId,
        });
        if (currentActive?.id === tabId) {
          await chrome.tabs
            .update(previousActive.id, { active: true })
            .catch(() => {});
        }
      }
    }
  });
}

export async function handleConsole(params) {
  const { tabId, clear = false, pattern, level, limit } = params;
  // Validate the tab (audit finding, seen live): a wrong tabId used to return
  // an empty success instead of an actionable error.
  await resolveTab(tabId);
  const buf = getTabBuffer(consoleByTab, tabId);
  let msgs = [...buf];
  const total = msgs.length;
  if (level) {
    const want = new Set((Array.isArray(level) ? level : [level]).map((l) => String(l).toLowerCase()));
    msgs = msgs.filter((m) => want.has(String(m.level).toLowerCase()));
  }
  if (pattern) {
    let re;
    try { re = new RegExp(pattern, 'i'); } catch (err) { throw new Error(`Invalid pattern regex: ${err?.message || err}`, { cause: err }); }
    msgs = msgs.filter((m) => re.test(m.text));
  }
  if (Number.isInteger(limit) && limit > 0 && msgs.length > limit) msgs = msgs.slice(-limit);
  if (clear) consoleByTab.set(tabId, []);
  return { success: true, messages: msgs, ...(msgs.length !== total ? { total } : {}) };
}

export async function handleNetwork(params) {
  const { tabId, clear = false, limit, filter, urlPattern, failed } = params;
  await resolveTab(tabId); // same as handleConsole — no empty fake successes
  let reqs = [...getTabBuffer(networkByTab, tabId)];
  // urlPattern: plain substring (Claude-in-Chrome style); filter: regex.
  if (urlPattern) reqs = reqs.filter((r) => String(r.url).includes(urlPattern));
  // failed:true = only requests that errored (DNS, blocked, aborted…) or got a 4xx/5xx.
  if (failed === true) reqs = reqs.filter((r) => r.error || (typeof r.status === 'number' && r.status >= 400));
  if (filter) {
    // An invalid pattern used to throw a raw SyntaxError out of the handler;
    // surface it as an actionable error instead.
    let re;
    try {
      re = new RegExp(filter);
    } catch (err) {
      throw new Error(`Invalid filter regex: ${err?.message || err}`, { cause: err });
    }
    reqs = reqs.filter((r) => re.test(r.url));
  }
  if (limit && Number.isInteger(limit) && limit > 0) {
    reqs = reqs.slice(-limit); // most recent N
  }
  if (clear) networkByTab.set(tabId, []);
  return { success: true, requests: reqs };
}

export async function handleTabs(params, sessionId) {
  const { action, tabId, url } = params;
  switch (action) {
    case "list": {
      // ALL windows, not {currentWindow:true}: "current window" is ill-defined
      // in an MV3 service worker, and tabs in other windows were invisible and
      // unfocusable. windowId disambiguates duplicates across windows.
      const tabs = await chrome.tabs.query({});
      return {
        success: true,
        // Compact: truncate long tracking URLs, omit lockedBy when null (saves
        // tokens — a 20-tab list with full FB/Google URLs was ~3K tokens).
        tabs: tabs.map((t) => {
          const entry = { id: t.id, windowId: t.windowId, title: t.title, active: t.active };
          const url = String(t.url || '');
          entry.url = params.fullUrls || url.length <= 80 ? url : url.slice(0, 77) + '...';
          const owner = tabLocks.owner(t.id);
          if (owner) entry.lockedBy = owner; // omit when null — saves tokens
          return entry;
        }),
      };
    }
    case 'create': {
      // active:false opens it in the background: the user's current tab stays in front.
      const t = await chrome.tabs.create({ url: url || 'about:blank', ...(params.active === false ? { active: false } : {}) });
      return { success: true, tabId: t.id, url: t.url || t.pendingUrl || url || 'about:blank', ...(params.active === false ? { active: false } : {}) };
    }
    case 'reload': {
      if (!tabId) throw new Error('tabId required');
      const reloadOwner = tabLocks.owner(tabId);
      if (reloadOwner && reloadOwner !== sessionId) {
        throw new Error(`Tab ${tabId} is locked by ${reloadOwner} — unlock it from that session before reloading.`);
      }
      const current = await resolveTab(tabId);
      // A frozen page would block the reload until it frees up: replace the tab.
      const fresh = await replaceFrozenTab(current, current.url, sessionId);
      if (fresh) {
        return { success: true, reloaded: fresh.id, replacedTabId: tabId, url: current.url, note: `tab ${tabId} was frozen and has been replaced by tab ${fresh.id}` };
      }
      const done = new Promise((resolve) => {
        const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(false); }, 30_000);
        function listener(id, info) {
          if (id === tabId && info.status === 'complete') {
            clearTimeout(timer);
            chrome.tabs.onUpdated.removeListener(listener);
            resolve(true);
          }
        }
        chrome.tabs.onUpdated.addListener(listener);
      });
      await chrome.tabs.reload(tabId, { bypassCache: params.bypassCache === true });
      const loaded = await done;
      wedgedTabs.delete(tabId);
      const t = await chrome.tabs.get(tabId);
      return {
        success: true, reloaded: tabId, url: t.url,
        ...(loaded ? {} : { warning: 'load did not complete within 30s' }),
      };
    }
    case "close": {
      if (!tabId) throw new Error("tabId required");
      // A locked tab belongs to its owner session — closing it from another
      // session (or from an anonymous no-session caller) would destroy the
      // work the lock exists to protect.
      const closerOwner = tabLocks.owner(tabId);
      if (closerOwner && closerOwner !== sessionId) {
        throw new Error(`Tab ${tabId} is locked by ${closerOwner} — unlock it from that session before closing.`);
      }
      await chrome.tabs.remove(tabId);
      releaseTabUi(tabId); // release + persist + shield removal
      return { success: true, closed: tabId };
    }
    case "focus": {
      if (!tabId) throw new Error("tabId required");
      const focusOwner = tabLocks.owner(tabId);
      if (focusOwner && focusOwner !== sessionId) {
        throw new Error(`Tab ${tabId} is locked by ${focusOwner} — unlock it from that session before focusing.`);
      }
      const focusedTab = await chrome.tabs.update(tabId, { active: true });
      // window:true also brings its window to the front (OS focus).
      if (params.window === true && focusedTab?.windowId != null) {
        await chrome.windows.update(focusedTab.windowId, { focused: true }).catch(() => {});
      }
      return { success: true, focused: tabId, ...(params.window === true ? { windowFocused: true } : {}) };
    }
    case "lock": {
      if (!tabId) throw new Error("tabId required");
      const owner = sessionId;
      if (!owner) throw new Error("lock requires an authenticated session");
      // Validate the tab exists — locking a phantom id would create an entry
      // that onRemoved never cleans (it only fires for real tabs).
      await resolveTab(tabId);
      const shielded = await lockTabUi(
        tabId,
        owner,
        `Tab ${tabId} locked by ${owner}`,
      );
      return { success: true, locked: tabId, owner, shielded };
    }
    case "unlock": {
      if (!tabId) throw new Error("tabId required");
      if (!sessionId)
        throw new Error("unlock requires an authenticated session");
      const was = tabLocks.owner(tabId);
      tabLocks.unlock(tabId, sessionId);
      if (tabLocks.owner(tabId)) {
        throw new Error(`Tab ${tabId} is locked by another session`);
      }
      persistSessionState();
      hideLockShield(tabId);
      broadcastStatus(`Tab ${tabId} unlocked (was ${was || "-"})`);
      return { success: true, unlocked: tabId, previousSession: was || null };
    }
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

/** Resize / change the state of the window that holds a tab. */
export async function handleResizeWindow(params, sessionId) {
  const { tabId, width, height, state } = params;
  const tab = await resolveTab(tabId);
  const owner = tabLocks.owner(tabId);
  if (owner && owner !== sessionId) throw new Error(`Tab ${tabId} is locked by ${owner} — unlock it from that session first.`);
  const update = {};
  if (width != null) update.width = Math.round(width);
  if (height != null) update.height = Math.round(height);
  if (state) update.state = state;
  // Sizes only apply to a normal window; a maximized one must be restored first.
  if (update.width != null || update.height != null) {
    if (update.state && update.state !== 'normal') { delete update.width; delete update.height; }
    else update.state = 'normal';
  }
  if (Object.keys(update).length === 0) throw new Error('width, height or state is required');
  const win = await chrome.windows.update(tab.windowId, update);
  await new Promise((r) => setTimeout(r, 200)); // let the page re-layout
  let viewport = null;
  try { viewport = await safeExec(tabId, () => [window.innerWidth, window.innerHeight], [], { timeoutMs: 2000 }); } catch { /* protected page */ }
  return {
    success: true, windowId: win.id, state: win.state, width: win.width, height: win.height,
    ...(Array.isArray(viewport) ? { viewport: { width: viewport[0], height: viewport[1] } } : {}),
  };
}
