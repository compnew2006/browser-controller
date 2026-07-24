/**
 * Browser Controller — background service worker.
 *
 * v2 architecture (plan tasks 1.2–1.5, 2.1–2.5):
 *   - Every page-interaction tool takes an explicit `tabId`. There is NO global
 *     "active tab" concept on the dispatch path — the user can freely switch
 *     tabs/move the mouse while an agent works. (1.2)
 *   - Element refs are stored per-tab (refsByTab), so a ref from tab 10 can never
 *     resolve against tab 20's DOM. (1.3)
 *   - console/network buffers are per-tab (capped 200), persisted to
 *     chrome.storage.session so they survive service-worker death. (1.4)
 *   - browser_evaluate runs via chrome.scripting MAIN world — no debugger banner. (1.5)
 *   - Per-tab mutex: only one tool runs against a given tab at a time; different
 *     tabs run in parallel. (2.1)
 *   - Per-agent sessionId + tab lock: browser_tabs lock claims a tab so other
 *     agents queue behind it instead of racing. (2.2)
 *   - Snapshot traverses shadow DOM + iframes. (2.4)
 *   - safeExec turns "can't touch chrome:// pages" into a clear error. (2.5)
 */
const DEFAULT_WS_PORT = 7225;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const KEEPALIVE_ALARM = 'keepalive';
const KEEPALIVE_INTERVAL_MIN = 0.4; // ~24s, under Chrome's 30s limit
const PER_TAB_CAP = 200;

let wsPort = DEFAULT_WS_PORT;
let wsToken = ''; // auth token (3.1); appended as ?token=
let ws = null;
let isConnected = false;
let reconnectAttempts = 0;
let reconnectTimeout = null;
let nextRetryMs = 0;
let connectedSince = null;
let lastError = null;

import { TabMutexMap, TabLockMap, runOnTab as runOnTabLib } from './lib/tab-concurrency.js';
import { PAGE_FALLBACK_FN, PAGE_RESOLVE_FALLBACK_FN } from './utils/smart-selector.js';

// --- Per-tab state (tasks 1.3, 1.4) ---------------------------------------
// Map<tabId, Array<{level,text,timestamp,url}>> and Map<tabId, Array<req>>
// Kept in chrome.storage.session so a service-worker restart doesn't wipe them.
const consoleByTab = new Map();
const networkByTab = new Map();
/**
 * Smart-selector fallbacks (plan tasks 2–4). Map<tabId, Map<ref, fallback>>.
 * Populated at snapshot time; consumed by click/type when a ref no longer
 * resolves. Never sent to the agent — it keeps payloads token-cheap.
 */
const fallbackByTab = new Map();
/**
 * isNew feature (borrowed from Page-Agent's *[index] idea): Map<tabId, Set<string>>
 * of "fingerprints" (role|name) from the PREVIOUS snapshot. The next snapshot marks
 * any ref whose fingerprint isn't in this set as `isNew: true`, so the agent can
 * focus on what changed (e.g. an overlay that appeared after a click) instead of
 * re-reading the whole tree — a big token saver on dynamic sites.
 */
const lastSnapshotFingerprints = new Map();
let currentActivity = null; // tool currently running (single overlay label source)

// --- Per-tab mutex (task 2.1) + per-agent tab locks (task 2.2) ------------
// Pure, unit-tested primitives in lib/tab-concurrency.js.
const tabMutex = new TabMutexMap();
const tabLocks = new TabLockMap();

// --- Connection Management ------------------------------------------------

/**
 * Auto-pair: fetch the daemon's auth token over localhost. The background
 * service worker can fetch() (it has host_permissions for 127.0.0.1:7225), and
 * it MUST own this — the popup only exists while open, but the WS connection is
 * driven by the background at startup and via the keepalive alarm. Returns the
 * token, or '' if the daemon isn't up yet (caller retries via reconnect loop).
 */
async function autoPairToken() {
  try {
    const res = await fetch(`http://127.0.0.1:${wsPort}/pair`, { cache: 'no-store' });
    if (!res.ok) return '';
    const data = await res.json();
    if (data && typeof data.token === 'string' && data.token) {
      if (data.token !== wsToken) {
        wsToken = data.token;
        chrome.storage.local.set({ wsToken });
      }
      return data.token;
    }
  } catch {
    // daemon not reachable yet
  }
  return '';
}

async function initConnection() {
  try {
    const stored = await chrome.storage.local.get(['wsPort', 'wsToken']);
    if (stored.wsPort) wsPort = stored.wsPort;
    if (stored.wsToken) wsToken = stored.wsToken;
  } catch {}

  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_INTERVAL_MIN });
  // Always try to (re)pair at startup so the WS carries a fresh token even if
  // the daemon rotated it or storage is empty.
  await autoPairToken();
  connect();
}

function wsUrl() {
  // 127.0.0.1 (not 'localhost') so it matches the daemon's IPv4 bind.
  // On macOS 'localhost' can resolve to IPv6 ::1 and refuse.
  const base = `ws://127.0.0.1:${wsPort}`;
  return wsToken ? `${base}?token=${encodeURIComponent(wsToken)}` : base;
}

/**
 * Track whether the socket closed BEFORE opening (handshake destroyed). That's
 * the signature of a bad/missing token — so the next reconnect re-pairs first.
 */
let lastWasHandshakeClose = false;

async function connect() {
  if (ws && ws.readyState === WebSocket.OPEN) return;

  // If the last attempt died mid-handshake, the token is likely stale/empty —
  // re-fetch it before reconnecting so we don't loop on a bad token.
  if (lastWasHandshakeClose) {
    await autoPairToken();
    lastWasHandshakeClose = false;
  }

  let opened = false;
  try {
    ws = new WebSocket(wsUrl());

    ws.onopen = () => {
      opened = true;
      isConnected = true;
      reconnectAttempts = 0;
      connectedSince = Date.now();
      lastError = null;
      updateBadge('connected');
      broadcastStatus('Connected');
    };

    ws.onclose = () => {
      // closed before open = the daemon destroyed the upgrade (bad/no token)
      if (!opened) lastWasHandshakeClose = true;
      isConnected = false;
      connectedSince = null;
      ws = null;
      updateBadge('disconnected');
      broadcastStatus('Disconnected');
      scheduleReconnect();
    };

    ws.onerror = () => {
      isConnected = false;
      lastError = `Connection refused on port ${wsPort}`;
      updateBadge('error');
      broadcastStatus(lastError);
    };

    ws.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
          return;
        }
        await handleMessage(msg);
      } catch (err) {
        console.error('[BrowserController] Message error:', err);
      }
    };
  } catch {
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (reconnectTimeout) clearTimeout(reconnectTimeout);
  const jitter = Math.random() * 500;
  const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts) + jitter, RECONNECT_MAX_MS);
  reconnectAttempts++;
  nextRetryMs = delay;
  broadcastStatus(`Retry #${reconnectAttempts} in ${Math.round(delay / 1000)}s`);
  reconnectTimeout = setTimeout(connect, delay);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM && !isConnected) connect();
});

// --- Badge & Overlay (unchanged behavior) ---------------------------------

function updateBadge(status) {
  const config = {
    connected: { color: '#22c55e', text: 'ON' },
    active: { color: '#3b82f6', text: '...' },
    disconnected: { color: '#6b7280', text: '' },
    error: { color: '#ef4444', text: '!' },
  };
  const c = config[status] || config.disconnected;
  chrome.action.setBadgeBackgroundColor({ color: c.color });
  chrome.action.setBadgeText({ text: c.text });
}

async function showOverlay(tabId, label) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (lbl) => {
        let el = document.getElementById('__bc-overlay');
        if (!el) {
          el = document.createElement('div');
          el.id = '__bc-overlay';
          el.style.cssText =
            'position:fixed;top:12px;right:12px;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;' +
            'padding:6px 14px;border-radius:16px;font:500 13px system-ui,sans-serif;z-index:2147483647;' +
            'display:flex;align-items:center;gap:6px;box-shadow:0 4px 12px rgba(0,0,0,.15);' +
            'animation:rbIn .2s ease-out';
          const s = document.createElement('style');
          s.textContent = '@keyframes rbIn{from{transform:translateX(80px);opacity:0}to{transform:none;opacity:1}}';
          document.head.appendChild(s);
          document.body.appendChild(el);
        }
        el.textContent = lbl;
      },
      args: [label],
    });
  } catch {}
}

async function hideOverlay(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => document.getElementById('__bc-overlay')?.remove(),
    });
  } catch {}
}

function getConnectionState() {
  if (isConnected) return 'connected';
  if (reconnectAttempts > 0) return 'reconnecting';
  return 'disconnected';
}

function buildStatusPayload(message) {
  return {
    type: 'status',
    connectionState: getConnectionState(),
    port: wsPort,
    reconnectAttempts,
    nextRetryMs,
    connectedSince,
    lastError,
    activity: currentActivity,
    tabLocks: tabLocksToJSON(),
    statusMessage: message || null,
  };
}

function tabLocksToJSON() {
  return tabLocks.snapshot();
}

function broadcastStatus(message) {
  chrome.runtime.sendMessage(buildStatusPayload(message)).catch(() => {});
}

// --- Message Router -------------------------------------------------------
//
// The daemon injects `__sessionId` into params (see daemon.ts routeCall). We
// pull it out here so it never reaches a tool handler, then route the call
// through the per-tab mutex + lock layer.

async function handleMessage(msg) {
  const { id, tool, params } = msg;
  const p = params || {};
  const sessionId = p.__sessionId || null;
  delete p.__sessionId;

  const tabId = extractTabId(tool, p);

  // Tools without a tabId (tabs list/create, console-less) run directly.
  if (tabId == null) {
    try {
      const result = await dispatch(tool, p, sessionId);
      sendResponse(id, { success: true, result });
    } catch (err) {
      sendResponse(id, { success: false, error: err.message || String(err) });
    }
    return;
  }

  // Acquire this tab's mutex (2.1) and honor per-agent locks (2.2).
  runOnTabLib(
    tabLocks,
    tabMutex,
    tabId,
    sessionId,
    async () => {
      currentActivity = tool;
      updateBadge('active');
      await showOverlay(tabId, tool.replace('browser_', ''));
      try {
        const result = await dispatch(tool, p, sessionId);
        sendResponse(id, { success: true, result });
      } catch (err) {
        sendResponse(id, { success: false, error: err.message || String(err) });
      } finally {
        currentActivity = null;
        updateBadge(isConnected ? 'connected' : 'disconnected');
        await hideOverlay(tabId);
      }
    },
  ).catch((err) => {
    sendResponse(id, { success: false, error: err.message || String(err) });
  });
}

function sendResponse(id, response) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ id, ...response }));
  }
}

/** Which tabId does this call target? null = tab-agnostic (tabs list/create). */
function extractTabId(tool, params) {
  if (typeof params.tabId === 'number') return params.tabId;
  // navigate allows omitting tabId → falls back to active tab inside its handler.
  if (tool === 'browser_navigate') return null; // handled in-handler
  if (tool === 'browser_tabs') return null; // create/list don't target; close/focus read their own tabId
  return null;
}

// --- Per-tab mutex + tab lock: see lib/tab-concurrency.js (tasks 2.1, 2.2) -
// runOnTabLib(locks, mutex, tabId, sessionId, fn) serializes per-tab work and
// makes non-owner sessions wait for the lock owner. Tested in
// tests/tab-concurrency.test.ts.

// --- Tool Dispatch --------------------------------------------------------

async function dispatch(tool, params, sessionId) {
  const handlers = {
    browser_navigate: handleNavigate,
    browser_click: handleClick,
    browser_type: handleType,
    browser_scroll: handleScroll,
    browser_press_key: handlePressKey,
    browser_wait: handleWait,
    browser_snapshot: handleSnapshot,
    browser_screenshot: handleScreenshot,
    browser_console: handleConsole,
    browser_network: handleNetwork,
    browser_tabs: handleTabs,
    browser_hover: handleHover,
    browser_select: handleSelect,
    browser_evaluate: handleEvaluate,
    browser_click_text: handleClickByText,
    browser_handle_dialog: handleDialog,
    browser_upload_file: handleUploadFile,
    browser_run_action: handleRunAction,
    browser_drag: handleDrag,
    browser_fill_form: handleFillForm,
    find: handleFind,
    browser_find: handleFind,
    get_page_text: handleGetPageText,
    browser_text: handleGetPageText,
  };

  const handler = handlers[tool];
  if (!handler) throw new Error(`Unknown tool: ${tool}`);
  return handler(params, sessionId);
}

// --- Tab resolution (task 1.2) -------------------------------------------

/**
 * Resolve a tab by id, throwing a clear, actionable error if it's gone.
 * Replaces the old getActiveTab() which silently grabbed whatever tab was
 * focused — the root cause of agents acting on the wrong page.
 */
async function resolveTab(tabId) {
  if (tabId == null || typeof tabId !== 'number') {
    throw new Error('tabId is required. Call browser_tabs list first to get a tabId.');
  }
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab) throw new Error(`Tab ${tabId} not found, call browser_tabs list first.`);
    return tab;
  } catch (err) {
    throw new Error(`Tab ${tabId} not found, call browser_tabs list first. (${err.message || err})`);
  }
}

/**
 * Get the stored smart-selector fallback for a (tabId, ref). Returns null if the
 * ref was never snapshotted or the snapshot pre-dates the fallback feature.
 */
function getFallback(tabId, ref) {
  if (tabId == null || !ref) return null;
  const map = fallbackByTab.get(tabId);
  if (!map) return null;
  return map.get(ref) || null;
}

/**
 * Auto-re-snapshot helper (Facebook/Instagram virtualization recovery).
 *
 * On virtualized sites (FB/IG/Twitter feeds), scrolling can REMOVE a post from
 * the DOM entirely — so a stale `ref` + every in-page fallback all return null.
 * Rather than forcing the agent to do a full round-trip (error → snapshot →
 * retry), we snapshot the tab HERE and embed the fresh refs in the error so the
 * agent can retry in one step using the new refs.
 *
 * Returns a compact summary (refs + names) suitable for an error payload — NOT
 * the full tree (keeps it token-cheap). null if the re-snapshot itself failed.
 */
async function autoReSnapshot(tabId) {
  try {
    const res = await handleSnapshot({ tabId, compact: true });
    if (!res || !res.success || !res.tree) return null;
    // Flatten ref → {role, name} so the agent can pick the right new ref.
    const refs = [];
    const walk = (n) => {
      if (!n) return;
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (n.ref) refs.push({ ref: n.ref, role: n.role || '', name: (n.name || '').slice(0, 60) });
      if (n.children) walk(n.children);
    };
    walk(res.tree);
    return { refs: refs.slice(0, 40), url: res.url, title: res.title };
  } catch {
    return null;
  }
}

/**
 * safeExec (task 2.5): run chrome.scripting.executeScript against a tab,
 * turning "can't access chrome:// / webstore / devtools pages" into a clear
 * error instead of a silent timeout.
 */
async function safeExec(tabId, func, args = []) {
  const tab = await resolveTab(tabId);
  if (/^(chrome|chrome-extension|devtools|edge|about):/i.test(tab.url || '')) {
    throw new Error(`Cannot access protected page (${tab.url}). Tab ${tabId} is a browser-internal page.`);
  }
  const sanitized = args.map((a) => (a === undefined ? null : a));
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId }, func, args: sanitized });
    return results[0]?.result;
  } catch (err) {
    const msg = err?.message || String(err);
    if (/cannot access|Cannot access|not allowed|No tab with id/i.test(msg)) {
      throw new Error(`Cannot execute on tab ${tabId}: ${msg}`);
    }
    throw err;
  }
}

// --- Per-tab console/network storage (task 1.4) --------------------------

function getTabBuffer(map, tabId) {
  let arr = map.get(tabId);
  if (!arr) {
    arr = [];
    map.set(tabId, arr);
  }
  return arr;
}

function pushCapped(arr, item, cap = PER_TAB_CAP) {
  arr.push(item);
  if (arr.length > cap) arr.splice(0, arr.length - cap);
}

// --- Tool Handlers -------------------------------------------------------

/** Active-tab fallback, used ONLY by navigate when the caller omits tabId. */
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab and no tabId given. Call browser_tabs list first.');
  return tab;
}

async function handleNavigate(params) {
  const { url, waitUntil = 'load', tabId } = params;
  // navigate is the one page tool allowed to omit tabId → active tab fallback.
  const tab = tabId != null ? await resolveTab(tabId) : await getActiveTab();

  return new Promise((resolve, reject) => {
    const listener = (tId, changeInfo) => {
      if (tId !== tab.id) return;
      if (changeInfo.status === 'complete' || (waitUntil === 'domcontentloaded' && changeInfo.status === 'complete')) {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve({ url, status: 'navigated', tabId: tab.id });
      }
    };

    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.update(tab.id, { url }).catch(reject);

    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve({ url, status: 'timeout', tabId: tab.id });
    }, 55000);
  });
}

async function handleClick(params) {
  const { tabId, ref, selector, button = 'left', doubleClick = false } = params;
  await resolveTab(tabId);
  const fb = getFallback(tabId, ref);
  const resolveFallbackSrc = PAGE_RESOLVE_FALLBACK_FN.toString();

  return safeExec(tabId, (_ref, _sel, _btn, _dbl, _fb, resolveFallbackSrc) => {
    let el = _ref ? document.querySelector(`[data-mcp-ref="${_ref}"]`) : null;
    let via = 'ref';
    if (!el && _sel) { el = document.querySelector(_sel); via = 'selector'; }
    // Rebuild the resolver from its source (chrome.scripting can't serialize fns).
    let resolveFallback = null;
    try { resolveFallback = eval('(' + resolveFallbackSrc + ')'); } catch {}
    // Smart-selector fallback (plan task 3): ref broke → try robust selector,
    // then text+role+tag scan. The agent doesn't request this; it's automatic.
    if (!el && _fb && resolveFallback) { el = resolveFallback(_fb); if (el) via = 'fallback'; }
    if (!el) {
      // Element is gone (likely virtualized away on scroll). Abort WITHOUT
      // clicking — the background auto-re-snapshots and embeds fresh refs.
      return { success: false, error: 'REF_GONE', _ref };
    }

    el.scrollIntoView({ behavior: 'instant', block: 'center' });

    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const btnVal = _btn === 'left' ? 0 : _btn === 'right' ? 2 : 1;
    const init = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: btnVal };

    el.dispatchEvent(new MouseEvent('mouseover', init));
    el.dispatchEvent(new MouseEvent('mousedown', init));
    if (el.focus) el.focus();
    el.dispatchEvent(new MouseEvent('mouseup', init));
    el.dispatchEvent(new MouseEvent('click', init));

    if (_dbl) {
      el.dispatchEvent(new MouseEvent('mousedown', init));
      el.dispatchEvent(new MouseEvent('mouseup', init));
      el.dispatchEvent(new MouseEvent('click', init));
      el.dispatchEvent(new MouseEvent('dblclick', init));
    }

    return { success: true, ...(via !== 'ref' ? { via } : {}) };
  }, [ref, selector, button, doubleClick, fb, resolveFallbackSrc]);

  // The page function returns REF_GONE when the element (and all fallbacks)
  // can't be found — typical of virtualized feeds (FB/IG) after scrolling.
  // Auto-re-snapshot and embed fresh refs so the agent retries in ONE step.
  // We do NOT auto-retry the click: it's non-idempotent and the element that
  // re-appears may be a different post after the scroll shifted the feed.
  if (res && res.success === false && res.error === 'REF_GONE') {
    const fresh = await autoReSnapshot(tabId);
    return {
      success: false,
      error: `Element ${res._ref || ref} is gone from the DOM (feed scrolled/virtualized). Fresh refs captured — retry with a new ref.`,
      freshRefs: fresh,
    };
  }
  return res;
}

async function handleType(params) {
  const { tabId, ref, selector, text, clear = false } = params;
  await resolveTab(tabId);
  const fb = getFallback(tabId, ref);
  const resolveFallbackSrc = PAGE_RESOLVE_FALLBACK_FN.toString();

  return safeExec(tabId, (_ref, _sel, _text, _clear, _fb, resolveFallbackSrc) => {
    let el = _ref ? document.querySelector(`[data-mcp-ref="${_ref}"]`) : null;
    let via = 'ref';
    if (!el && _sel) { el = document.querySelector(_sel); via = 'selector'; }
    let resolveFallback = null;
    try { resolveFallback = eval('(' + resolveFallbackSrc + ')'); } catch {}
    if (!el && _fb && resolveFallback) { el = resolveFallback(_fb); if (el) via = 'fallback'; }
    if (!el) {
      // Element gone (virtualized feed) — abort WITHOUT typing; background
      // auto-re-snapshots and embeds fresh refs for a one-step retry.
      return { success: false, error: 'REF_GONE', _ref };
    }

    el.focus();

    if (_clear) {
      if (el.isContentEditable) {
        el.textContent = '';
      } else {
        el.value = '';
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }

    if (el.isContentEditable) {
      document.execCommand('insertText', false, _text);
    } else {
      for (const ch of _text) {
        el.value += ch;
        el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
      }
    }

    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { success: true, typed: _text, ...(via !== 'ref' ? { via } : {}) };
  }, [ref, selector, text, clear, fb, resolveFallbackSrc]);

  // Virtualization recovery (same as click): type target is gone, so
  // auto-re-snapshot and embed fresh refs. No auto-retry (non-idempotent).
  if (res && res.success === false && res.error === 'REF_GONE') {
    const fresh = await autoReSnapshot(tabId);
    return {
      success: false,
      error: `Element ${res._ref || ref} is gone from the DOM (feed scrolled/virtualized). Fresh refs captured — retry with a new ref.`,
      freshRefs: fresh,
    };
  }
  return res;
}

async function handleScroll(params) {
  const { tabId, direction = 'down', amount = 500, selector, toElement, position } = params;
  await resolveTab(tabId);

  return safeExec(tabId, (_dir, _amt, _sel, _toEl, _pos) => {
    if (_toEl) {
      const el = document.querySelector(`[data-mcp-ref="${_toEl}"]`) || document.querySelector(_toEl);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return { success: true, scrolledTo: 'element' };
      }
      return { success: false, error: 'Element not found' };
    }

    const target = _sel ? document.querySelector(_sel) : window;
    if (!target) return { success: false, error: 'Scroll container not found' };

    if (_pos === 'top') {
      if (target === window) window.scrollTo({ top: 0, behavior: 'smooth' });
      else target.scrollTop = 0;
      return { success: true, scrolledTo: 'top' };
    }
    if (_pos === 'bottom') {
      if (target === window) window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
      else target.scrollTop = target.scrollHeight;
      return { success: true, scrolledTo: 'bottom' };
    }

    const scrollOpts = { behavior: 'smooth' };
    if (_dir === 'down') scrollOpts.top = _amt;
    else if (_dir === 'up') scrollOpts.top = -_amt;
    else if (_dir === 'right') scrollOpts.left = _amt;
    else if (_dir === 'left') scrollOpts.left = -_amt;

    if (target === window) window.scrollBy(scrollOpts);
    else target.scrollBy(scrollOpts);

    return { success: true, direction: _dir, amount: _amt };
  }, [direction, amount, selector, toElement, position]).then((res) => {
    // Scrolling a virtualized feed (FB/IG/Twitter) recycles DOM nodes, so any
    // refs the agent holds are now likely stale. Hint it to re-snapshot. We
    // don't auto-snapshot here (every scroll would be expensive); the hint is
    // enough for a well-behaved agent to snapshot before its next interaction.
    if (res && res.success) res.refsMayBeStale = true;
    return res;
  });
}

async function handlePressKey(params) {
  const { tabId, key, modifiers = [], ref, selector } = params;
  await resolveTab(tabId);

  return safeExec(tabId, (_key, _mods, _ref, _sel) => {
    let target = document.activeElement || document.body;
    if (_ref) {
      const el = document.querySelector(`[data-mcp-ref="${_ref}"]`);
      if (el) { el.focus(); target = el; }
    } else if (_sel) {
      const el = document.querySelector(_sel);
      if (el) { el.focus(); target = el; }
    }

    const init = {
      key: _key,
      code: _key.length === 1 ? `Key${_key.toUpperCase()}` : _key,
      bubbles: true,
      cancelable: true,
      ctrlKey: _mods.includes('ctrl'),
      altKey: _mods.includes('alt'),
      shiftKey: _mods.includes('shift'),
      metaKey: _mods.includes('meta'),
    };

    target.dispatchEvent(new KeyboardEvent('keydown', init));
    target.dispatchEvent(new KeyboardEvent('keypress', init));
    target.dispatchEvent(new KeyboardEvent('keyup', init));

    return { success: true, key: _key };
  }, [key, modifiers, ref, selector]);
}

async function handleWait(params) {
  const { tabId, selector, state = 'visible', timeout = 10000, delay } = params;

  if (delay) {
    await new Promise((r) => setTimeout(r, Math.min(delay, 30000)));
    return { success: true, waited: delay };
  }

  if (!selector) return { success: false, error: 'Need selector or delay' };
  await resolveTab(tabId);
  const start = Date.now();

  while (Date.now() - start < timeout) {
    const found = await safeExec(tabId, (_sel, _state) => {
      const el = document.querySelector(_sel);
      if (_state === 'hidden') return !el || el.offsetParent === null;
      if (_state === 'attached') return !!el;
      return el && el.offsetParent !== null;
    }, [selector, state]);

    if (found) return { success: true, selector, state, elapsed: Date.now() - start };
    await new Promise((r) => setTimeout(r, 200));
  }

  return { success: false, error: `Timeout waiting for ${selector} to be ${state}` };
}

async function handleHover(params) {
  const { tabId, ref, selector } = params;
  await resolveTab(tabId);

  return safeExec(tabId, (_ref, _sel) => {
    let el = _ref ? document.querySelector(`[data-mcp-ref="${_ref}"]`) : null;
    if (!el && _sel) el = document.querySelector(_sel);
    if (!el) return { success: false, error: 'Element not found' };

    el.scrollIntoView({ behavior: 'instant', block: 'center' });
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const init = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };

    el.dispatchEvent(new MouseEvent('mouseenter', { ...init, bubbles: false }));
    el.dispatchEvent(new MouseEvent('mouseover', init));
    el.dispatchEvent(new MouseEvent('mousemove', init));

    return { success: true };
  }, [ref, selector]);
}

async function handleSelect(params) {
  const { tabId, ref, selector, value, label, index } = params;
  await resolveTab(tabId);

  return safeExec(tabId, (_ref, _sel, _val, _lbl, _idx) => {
    let el = _ref ? document.querySelector(`[data-mcp-ref="${_ref}"]`) : null;
    if (!el && _sel) el = document.querySelector(_sel);
    if (!el) return { success: false, error: 'Element not found' };
    if (el.tagName !== 'SELECT') return { success: false, error: 'Not a select element' };

    if (_val !== null) el.value = _val;
    else if (_lbl !== null) {
      const opt = Array.from(el.options).find((o) => o.textContent.trim() === _lbl);
      if (opt) el.value = opt.value;
      else return { success: false, error: `Option "${_lbl}" not found` };
    } else if (_idx !== null) {
      if (_idx >= 0 && _idx < el.options.length) el.selectedIndex = _idx;
      else return { success: false, error: `Index ${_idx} out of range` };
    }

    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return { success: true, selected: el.value };
  }, [ref, selector, value, label, index]);
}

/**
 * Snapshot (task 2.4): builds an accessibility tree INCLUDING shadow DOM and
 * same-origin iframes. Refs are stamped via data-mcp-ref and are valid only for
 * the tab that produced them (enforced by resolveTab in the consuming tools).
 */
async function handleSnapshot(params) {
  const { tabId, selector, compact = true } = params;
  await resolveTab(tabId);

  // chrome.scripting cannot serialize functions across the service worker
  // boundary, so pass the fallback generator as its SOURCE STRING and eval it
  // in the page to rebuild the live function.
  const genFallbackSrc = PAGE_FALLBACK_FN.toString();
  // isNew feature: pass the fingerprints seen in the PREVIOUS snapshot so the
  // page function can mark newly-appeared elements. Array is serializable.
  const prevFingerprints = lastSnapshotFingerprints.get(tabId) || [];

  return safeExec(tabId, (_sel, _compact, genFallbackSrc, _prevFingerprints) => {
    let refCount = 0;
    /** @type {Record<string, object>} ref -> fallback, returned to background */
    const fallbacks = {};
    /** @type {string[]} fingerprints of THIS snapshot (role|name), returned to background */
    const fingerprints = [];
    const prevSet = new Set(_prevFingerprints);
    // Rebuild the live function from its source string (see comment at call site).
    let genFallback = null;
    try { genFallback = eval('(' + genFallbackSrc + ')'); } catch {}
    const skipTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'PATH', 'BR', 'HR', 'WBR', 'META', 'LINK']);

    function vis(el) {
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }

    function role(el) {
      const r = el.getAttribute('role');
      if (r) return r;
      const map = {
        A: 'link', BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox', IMG: 'img',
        H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading',
        NAV: 'navigation', MAIN: 'main', HEADER: 'banner', FOOTER: 'contentinfo', FORM: 'form',
        TABLE: 'table', UL: 'list', OL: 'list', LI: 'listitem',
      };
      if (el.tagName === 'INPUT') {
        const t = el.type?.toLowerCase();
        if (t === 'checkbox') return 'checkbox';
        if (t === 'radio') return 'radio';
        return 'textbox';
      }
      return map[el.tagName] || 'generic';
    }

    function elName(el) {
      const raw = (
        el.getAttribute('aria-label') || el.getAttribute('alt') ||
        el.getAttribute('title') || el.getAttribute('placeholder') ||
        ''
      ).trim();
      if (raw) return raw.slice(0, 80);
      const text = el.innerText;
      if (!text) return '';
      const first = text.split('\n')[0].trim();
      return first.slice(0, 80);
    }

    function isInteractive(el) {
      const tags = ['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'];
      return tags.includes(el.tagName) || el.onclick || el.getAttribute('tabindex') !== null ||
        el.getAttribute('role') === 'button' || el.getAttribute('role') === 'link' ||
        el.getAttribute('role') === 'tab' || el.getAttribute('role') === 'menuitem' ||
        el.getAttribute('role') === 'option' || el.getAttribute('role') === 'switch' ||
        el.getAttribute('contenteditable') === 'true';
    }

    const landmarkRoles = new Set(['navigation', 'main', 'banner', 'contentinfo', 'form', 'search', 'complementary', 'region']);

    // Children including shadow DOM (open roots) and same-origin iframes.
    function childrenOf(el) {
      const out = [];
      for (const c of el.children) out.push(c);
      if (el.shadowRoot) {
        for (const c of el.shadowRoot.children) out.push(c);
      }
      // same-origin iframes: expose their document body children too.
      if (el.tagName === 'IFRAME') {
        try {
          const doc = el.contentDocument;
          if (doc && doc.body) for (const c of doc.body.children) out.push(c);
        } catch { /* cross-origin: skip */ }
      }
      return out;
    }

    function buildCompact(el) {
      if (!el || el.nodeType !== 1) return null;
      if (skipTags.has(el.tagName)) return null;
      if (!vis(el)) return null;

      const ia = isInteractive(el);
      const r = role(el);
      const isLandmark = landmarkRoles.has(r);

      const kids = [];
      for (const c of childrenOf(el)) {
        const cn = buildCompact(c);
        if (cn) Array.isArray(cn) ? kids.push(...cn) : kids.push(cn);
      }

      if (!ia && !isLandmark && r !== 'heading') {
        return kids.length === 0 ? null : kids.length === 1 ? kids[0] : kids;
      }

      const ref = `e${refCount++}`;
      el.setAttribute('data-mcp-ref', ref);
      const n = elName(el);
      try { if (genFallback) fallbacks[ref] = genFallback(el); } catch {}

      // isNew: mark elements whose (role|name) wasn't in the previous snapshot.
      const fp = `${r}|${n}`;
      fingerprints.push(fp);
      const isNew = !prevSet.has(fp);

      const node = { ref, role: r };
      if (n) node.name = n;
      if (isNew) node.isNew = true;
      if (el.value !== undefined && el.value !== '') node.value = String(el.value);
      if (el.checked !== undefined) node.checked = el.checked;
      if (el.disabled) node.disabled = true;
      if (el.href && el.tagName === 'A') node.href = el.href;
      if (kids.length) node.children = kids;

      return node;
    }

    function buildFull(el, depth) {
      if (!el || el.nodeType !== 1) return null;
      if (skipTags.has(el.tagName)) return null;
      if (!vis(el)) return null;

      const r = role(el);
      const n = elName(el);
      const ia = isInteractive(el);

      if (r === 'generic' && !n && !ia && depth > 1) {
        const kids = [];
        for (const c of childrenOf(el)) {
          const cn = buildFull(c, depth + 1);
          if (cn) Array.isArray(cn) ? kids.push(...cn) : kids.push(cn);
        }
        return kids.length === 0 ? null : kids.length === 1 ? kids[0] : kids;
      }

      const ref = `e${refCount++}`;
      el.setAttribute('data-mcp-ref', ref);
      try { if (genFallback) fallbacks[ref] = genFallback(el); } catch {}

      // isNew: mark elements whose (role|name) wasn't in the previous snapshot.
      const fp = `${r}|${n}`;
      fingerprints.push(fp);
      const isNew = !prevSet.has(fp);

      const node = { ref, role: r };
      if (r === 'generic') node.tag = el.tagName.toLowerCase();
      if (n) node.name = n;
      if (isNew) node.isNew = true;
      if (el.value !== undefined && el.value !== '') node.value = String(el.value);
      if (el.checked !== undefined) node.checked = el.checked;
      if (el.disabled) node.disabled = true;
      if (el.href && el.tagName === 'A') node.href = el.href;

      const kids = [];
      for (const c of childrenOf(el)) {
        const cn = buildFull(c, depth + 1);
        if (cn) Array.isArray(cn) ? kids.push(...cn) : kids.push(cn);
      }
      if (kids.length) node.children = kids;

      return node;
    }

    const root = _sel ? document.querySelector(_sel) : document.body;
    if (!root) return { success: false, error: 'Root element not found' };

    const tree = _compact ? buildCompact(root) : buildFull(root, 0);
    return {
      success: true,
      url: location.href,
      title: document.title,
      compact: _compact,
      tree,
      // internal: background stores these per-tab; never sent to the agent.
      __fallbacks: fallbacks,
      __fingerprints: fingerprints,
    };
  }, [selector, compact, genFallbackSrc, prevFingerprints]).then((res) => {
    // Store the fallbacks per-tab so click/type can resolve stale refs.
    if (res && res.__fallbacks) {
      const map = new Map(Object.entries(res.__fallbacks));
      fallbackByTab.set(tabId, map);
      delete res.__fallbacks; // keep it out of the agent-visible payload
    }
    // Store THIS snapshot's fingerprints so the next snapshot can compute isNew.
    if (res && res.__fingerprints) {
      lastSnapshotFingerprints.set(tabId, res.__fingerprints);
      delete res.__fingerprints;
    }
    return res;
  });
}

async function handleScreenshot(params) {
  const { tabId, format = 'png', quality = 80 } = params;
  const tab = await resolveTab(tabId);
  // captureVisibleTab is window-scoped: ensure the tab is the active one in its
  // window first (a no-op if it already is).
  if (!tab.active) {
    await chrome.tabs.update(tabId, { active: true }).catch(() => {});
    await new Promise((r) => setTimeout(r, 150)); // let the paint settle
  }
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format,
    quality: format === 'jpeg' ? quality : undefined,
  });
  return { success: true, format, data: dataUrl.split(',')[1] };
}

async function handleConsole(params) {
  const { tabId, clear = false } = params;
  const buf = getTabBuffer(consoleByTab, tabId);
  const msgs = [...buf];
  if (clear) consoleByTab.set(tabId, []);
  return { success: true, messages: msgs };
}

async function handleNetwork(params) {
  const { tabId, filter, clear = false } = params;
  let reqs = [...getTabBuffer(networkByTab, tabId)];
  if (filter) {
    const re = new RegExp(filter);
    reqs = reqs.filter((r) => re.test(r.url));
  }
  if (clear) networkByTab.set(tabId, []);
  return { success: true, requests: reqs };
}

async function handleTabs(params, sessionId) {
  const { action, tabId, url } = params;
  switch (action) {
    case 'list': {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      return {
        success: true,
        tabs: tabs.map((t) => ({
          id: t.id,
          url: t.url,
          title: t.title,
          active: t.active,
          lockedBy: tabLocks.owner(t.id) || null,
        })),
      };
    }
    case 'create': {
      const t = await chrome.tabs.create({ url: url || 'about:blank' });
      return { success: true, tabId: t.id, url: t.url };
    }
    case 'close': {
      if (!tabId) throw new Error('tabId required');
      await chrome.tabs.remove(tabId);
      tabLocks.release(tabId);
      return { success: true, closed: tabId };
    }
    case 'focus': {
      if (!tabId) throw new Error('tabId required');
      await chrome.tabs.update(tabId, { active: true });
      return { success: true, focused: tabId };
    }
    case 'lock': {
      if (!tabId) throw new Error('tabId required');
      if (!sessionId) throw new Error('lock requires a session (called outside daemon?)');
      tabLocks.lock(tabId, sessionId);
      broadcastStatus(`Tab ${tabId} locked by ${sessionId}`);
      return { success: true, locked: tabId, sessionId };
    }
    case 'unlock': {
      if (!tabId) throw new Error('tabId required');
      const was = tabLocks.owner(tabId);
      tabLocks.release(tabId);
      broadcastStatus(`Tab ${tabId} unlocked (was ${was || '-'})`);
      return { success: true, unlocked: tabId, previousSession: was || null };
    }
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

async function handleFind(params) {
  const { tabId, query, limit = 10 } = params;
  await resolveTab(tabId);

  return safeExec(tabId, (_q, _lim) => {
    const qLow = _q.toLowerCase();
    const matches = [];

    function aName(el) {
      return (el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title') ||
        el.getAttribute('placeholder') || el.innerText?.slice(0, 200) || '').trim();
    }

    function aRole(el) {
      const r = el.getAttribute('role');
      if (r) return r;
      const map = { A: 'link', BUTTON: 'button', INPUT: 'input', SELECT: 'combobox', TEXTAREA: 'textbox', IMG: 'image' };
      return map[el.tagName] || el.tagName.toLowerCase();
    }

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let rc = 0;
    let node;
    while ((node = walker.nextNode()) && matches.length < _lim * 3) {
      const s = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      if (s.display === 'none' || s.visibility === 'hidden' || rect.width === 0) continue;

      const n = aName(node).toLowerCase();
      const r = aRole(node).toLowerCase();
      const id = (node.id || '').toLowerCase();
      let score = 0;
      if (n.includes(qLow)) score += 10;
      if (r.includes(qLow)) score += 5;
      if (id.includes(qLow)) score += 3;
      if (score === 0) continue;

      const ref = `f${rc++}`;
      node.setAttribute('data-mcp-ref', ref);
      matches.push({
        ref, role: r, name: n.slice(0, 100), tag: node.tagName.toLowerCase(), score,
        bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      });
    }

    matches.sort((a, b) => b.score - a.score);
    return { success: true, query: _q, matches: matches.slice(0, _lim) };
  }, [query, limit]);
}

async function handleGetPageText(params) {
  const { tabId, selector, maxLength = 50000 } = params;
  await resolveTab(tabId);
  const args = selector === undefined ? [null, maxLength] : [selector, maxLength];

  return safeExec(tabId, (_sel, _max) => {
    const root = _sel ? document.querySelector(_sel) : document.body;
    if (!root) return { success: false, error: 'Element not found' };

    let text = root.innerText || root.textContent || '';
    text = text.replace(/\t/g, ' ').replace(/\n\s*\n/g, '\n\n').replace(/ +/g, ' ').trim();
    const truncated = text.length > _max;
    if (truncated) text = text.slice(0, _max) + '...';

    return { success: true, url: location.href, title: document.title, text, length: text.length, truncated };
  }, args);
}

/**
 * evaluate (task 1.5): runs in the page's MAIN world via chrome.scripting — no
 * chrome.debugger, so no yellow "is being debugged" banner. Replaces the old
 * CDP Runtime.evaluate path.
 */
async function handleEvaluate(params) {
  const { tabId, expression } = params;
  await resolveTab(tabId);
  const tab = await chrome.tabs.get(tabId);
  if (/^(chrome|chrome-extension|devtools|edge|about):/i.test(tab.url || '')) {
    throw new Error(`Cannot evaluate on protected page (${tab.url}).`);
  }

  // Wrap the user expression in an async IIFE so `await` works, then stringify
  // the function and run it in the MAIN world (page's own JS context).
  const wrapped = `(async () => { ${expression} })()`;
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async (code) => {
      // eslint-disable-next-line no-eval
      return await eval(code);
    },
    args: [wrapped],
  });
  const value = results?.[0]?.result;
  return { success: true, result: value };
}

async function handleClickByText(params) {
  const { tabId, text, index = 0, exact = false } = params;
  await resolveTab(tabId);

  return safeExec(tabId, (_text, _index, _exact) => {
    const textLower = _text.toLowerCase();
    const candidates = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let node;
    while ((node = walker.nextNode())) {
      const s = getComputedStyle(node);
      if (s.display === 'none' || s.visibility === 'hidden') continue;
      const r = node.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;

      const nodeText = (node.innerText || node.textContent || '').trim();
      const firstLine = nodeText.split('\n')[0].trim();
      const match = _exact
        ? firstLine === _text
        : firstLine.toLowerCase().includes(textLower);

      if (match) {
        candidates.push({ el: node, text: firstLine, depth: getDepth(node) });
      }
    }

    function getDepth(el) { let d = 0; let p = el; while ((p = p.parentElement)) d++; return d; }

    candidates.sort((a, b) => b.depth - a.depth);

    if (candidates.length === 0) return { success: false, error: `No element found with text "${_text}"` };
    if (_index >= candidates.length) return { success: false, error: `Only ${candidates.length} matches, index ${_index} out of range` };

    const target = candidates[_index].el;
    target.scrollIntoView({ behavior: 'instant', block: 'center' });
    const rect = target.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const init = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 };

    target.dispatchEvent(new MouseEvent('mouseover', init));
    target.dispatchEvent(new MouseEvent('mousedown', init));
    if (target.focus) target.focus();
    target.dispatchEvent(new MouseEvent('mouseup', init));
    target.dispatchEvent(new MouseEvent('click', init));

    return { success: true, clicked: candidates[_index].text, matchCount: candidates.length };
  }, [text, index, exact]);
}

async function handleDialog(params) {
  const { tabId, action = 'accept', promptText } = params;
  await resolveTab(tabId);

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
  }, [action, promptText]);
}

async function handleRunAction(params) {
  const { tabId, code, actionParams = {} } = params;
  if (!code) throw new Error('code is required');
  const tab = await resolveTab(tabId);

  // run_action stays on CDP (plan decision: CDP-only, can't be scripted).
  await chrome.debugger.attach({ tabId: tab.id }, '1.3');
  try {
    const paramsJson = JSON.stringify(actionParams);
    const expression = `(async function() { try { var tool = (${code}); if (tool && typeof tool.execute === "function") { return await tool.execute(${paramsJson}); } return { error: "No execute function found" }; } catch(e) { return { error: e.message, stack: e.stack }; } })()`;

    const { result, exceptionDetails } = await chrome.debugger.sendCommand(
      { tabId: tab.id },
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
    );

    if (exceptionDetails) {
      return { success: false, error: exceptionDetails.exception?.description || exceptionDetails.text };
    }
    return { success: true, result: result.value };
  } finally {
    try { await chrome.debugger.detach({ tabId: tab.id }); } catch {}
  }
}

async function handleUploadFile(params) {
  const { tabId, ref, selector, filePath, files: fileList } = params;
  const tab = await resolveTab(tabId);
  const filePaths = fileList || (filePath ? [filePath] : []);
  if (filePaths.length === 0) throw new Error('filePath or files required');

  // upload_file stays on CDP (DOM.setFileInputFiles is CDP-only).
  await chrome.debugger.attach({ tabId: tab.id }, '1.3');
  try {
    await chrome.debugger.sendCommand({ tabId: tab.id }, 'DOM.enable', {});
    const { root } = await chrome.debugger.sendCommand({ tabId: tab.id }, 'DOM.getDocument', {});

    let sel = 'input[type="file"]';
    if (ref) sel = `[data-mcp-ref="${ref}"]`;
    else if (selector) sel = selector;

    const { nodeId } = await chrome.debugger.sendCommand({ tabId: tab.id }, 'DOM.querySelector', {
      nodeId: root.nodeId,
      selector: sel,
    });

    if (!nodeId) throw new Error(`File input not found with selector: ${sel}`);

    await chrome.debugger.sendCommand({ tabId: tab.id }, 'DOM.setFileInputFiles', {
      files: filePaths,
      nodeId,
    });

    return { success: true, files: filePaths, selector: sel };
  } finally {
    try { await chrome.debugger.detach({ tabId: tab.id }); } catch {}
  }
}

async function handleDrag(params) {
  const { tabId, startRef, startSelector, endRef, endSelector, startX, startY, endX, endY, steps = 10 } = params;
  const tab = await resolveTab(tabId);

  let sx = startX, sy = startY, ex = endX, ey = endY;

  if (sx == null || sy == null || ex == null || ey == null) {
    const coords = await safeExec(tabId, (_sRef, _sSel, _eRef, _eSel) => {
      function find(ref, sel) {
        let el = ref ? document.querySelector(`[data-mcp-ref="${ref}"]`) : null;
        if (!el && sel) el = document.querySelector(sel);
        if (!el) return null;
        el.scrollIntoView({ behavior: 'instant', block: 'center' });
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
      return { start: find(_sRef, _sSel), end: find(_eRef, _eSel) };
    }, [startRef, startSelector, endRef, endSelector]);

    if (coords.start) { sx = coords.start.x; sy = coords.start.y; }
    if (coords.end) { ex = coords.end.x; ey = coords.end.y; }
  }

  if (sx == null || sy == null || ex == null || ey == null) {
    throw new Error('Could not determine drag coordinates. Provide refs/selectors or explicit x,y coordinates.');
  }

  // drag stays on CDP (Input.dispatchMouseEvent is CDP-only).
  await chrome.debugger.attach({ tabId: tab.id }, '1.3');
  try {
    await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchMouseEvent', {
      type: 'mousePressed', x: sx, y: sy, button: 'left', clickCount: 1,
    });

    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(sx + (ex - sx) * t),
        y: Math.round(sy + (ey - sy) * t),
        button: 'left',
      });
    }

    await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: ex, y: ey, button: 'left', clickCount: 1,
    });

    return { success: true, from: { x: sx, y: sy }, to: { x: ex, y: ey } };
  } finally {
    try { await chrome.debugger.detach({ tabId: tab.id }); } catch {}
  }
}

async function handleFillForm(params) {
  const { tabId, fields, submit } = params;
  if (!fields || !Array.isArray(fields) || fields.length === 0) {
    throw new Error('fields array is required');
  }
  await resolveTab(tabId);

  return safeExec(tabId, (_fields, _submit) => {
    const results = [];
    for (const field of _fields) {
      const { ref, selector, value, clear } = field;
      let el = ref ? document.querySelector(`[data-mcp-ref="${ref}"]`) : null;
      if (!el && selector) el = document.querySelector(selector);
      if (!el) {
        results.push({ selector: selector || ref, success: false, error: 'Not found' });
        continue;
      }

      el.focus();

      if (clear !== false) {
        if (el.isContentEditable) {
          el.textContent = '';
        } else {
          el.value = '';
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }

      if (el.tagName === 'SELECT') {
        el.value = value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (el.type === 'checkbox' || el.type === 'radio') {
        if (el.checked !== !!value) el.click();
      } else if (el.isContentEditable) {
        document.execCommand('insertText', false, value);
      } else {
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }

      el.dispatchEvent(new Event('change', { bubbles: true }));
      results.push({ selector: selector || ref, success: true, value });
    }

    if (_submit) {
      const form = document.querySelector('form');
      if (form) {
        const submitBtn = form.querySelector('[type="submit"]') || form.querySelector('button:not([type="button"])');
        if (submitBtn) submitBtn.click();
        else form.submit();
      }
    }

    return { success: true, fields: results };
  }, [fields, submit]);
}

// --- Events (per-tab console/network capture: task 1.4) ------------------

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  // NOTE: do NOT `return true` unconditionally. Returning true tells Chrome the
  // listener will call `respond()` ASYNCHRONOUSLY; if the sender (popup) closes
  // before that, Chrome logs "message channel closed before a response was
  // received". Every branch below responds synchronously (or is fire-and-forget),
  // so we return false (or nothing) — Chrome handles it without the warning.
  if (msg.type === 'console' && sender.tab?.id != null) {
    const buf = getTabBuffer(consoleByTab, sender.tab.id);
    pushCapped(buf, { level: msg.level, text: msg.text, timestamp: Date.now(), url: sender.tab.url });
    return false; // fire-and-forget; no response expected
  }
  if (msg.type === 'getStatus') {
    respond(buildStatusPayload());
    return false;
  }
  if (msg.type === 'setPort') {
    const p = parseInt(msg.port, 10);
    if (p > 0 && p < 65536) {
      wsPort = p;
      chrome.storage.local.set({ wsPort: p });
      ws?.close();
      ws = null;
      isConnected = false;
      reconnectAttempts = 0;
      connect();
      respond({ success: true, port: p });
    } else {
      respond({ success: false, error: 'Invalid port' });
    }
    return false;
  }
  if (msg.type === 'setToken') {
    // extension popup can store the auth token (3.1) once.
    wsToken = (msg.token || '').trim();
    chrome.storage.local.set({ wsToken });
    ws?.close();
    ws = null;
    isConnected = false;
    reconnectAttempts = 0;
    connect();
    respond({ success: true });
    return false;
  }
  if (msg.type === 'unlockAll') {
    tabLocks.unlockAll();
    broadcastStatus('All tab locks cleared');
    respond({ success: true });
    return false;
  }
  return false; // unrecognized message — no async response promised
});

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (details.tabId == null || details.tabId < 0) return; // not a real tab
    const buf = getTabBuffer(networkByTab, details.tabId);
    pushCapped(buf, {
      method: details.method,
      url: details.url,
      status: details.statusCode,
      type: details.type,
      timestamp: details.timeStamp,
    });
  },
  { urls: ['<all_urls>'] },
);

// A tab closing should release its lock and drop its buffers.
chrome.tabs.onRemoved.addListener((tabId) => {
  tabLocks.release(tabId);
  consoleByTab.delete(tabId);
  networkByTab.delete(tabId);
  fallbackByTab.delete(tabId);
  lastSnapshotFingerprints.delete(tabId);
});

initConnection();
