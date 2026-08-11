/**
 * Browser Controller — background service worker.
 *
 * v2 architecture (plan tasks 1.2–1.5, 2.1–2.5):
 *   - Every page-interaction tool takes an explicit `tabId`. There is NO global
 *     "active tab" concept on the dispatch path — the user can freely switch
 *     tabs/move the mouse while an agent works. (1.2)
 *   - Element refs are stored per-tab (refsByTab), so a ref from tab 10 can never
 *     resolve against tab 20's DOM. (1.3)
 *   - console/network buffers are per-tab (capped 200). NOTE: these live in
 *     service-worker memory and are LOST when Chrome recycles the worker
 *     (~30s idle). They are debug aids, not durable state — the agent can
 *     always re-read them after the page emits new messages. (1.4)
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
// After this many reconnect attempts (≈ a few minutes of backoff), the daemon
// is genuinely down, not just recycling — surface a real 'error' badge so the
// user knows it's not a silent failure. Below this threshold, the badge stays
// grey (disconnected) to avoid crying-wolf on every transient restart.
const RECONNECT_GIVEUP_ATTEMPTS = 10;
const KEEPALIVE_ALARM = 'keepalive';
const KEEPALIVE_INTERVAL_MIN = 0.4; // ~24s, under Chrome's 30s limit
const PER_TAB_CAP = 200;

let wsPort = DEFAULT_WS_PORT;
let wsToken = ''; // auth token (3.1); appended as ?token=
// Enrollment secret the daemon gates /pair behind. The popup owns the
// user-facing entry of it; the background re-reads it from storage on every
// service-worker recycle (MV3 kills the worker ~30s idle, so this re-load is
// not optional) and sends it on /pair. Without this, the background's own
// autoPairToken() 403s under the enrollment gate and reconnect dies.
let enrollmentSecret = '';
let ws = null;
let isConnected = false;
let reconnectAttempts = 0;
let reconnectTimeout = null;
let nextRetryMs = 0;
let connectedSince = null;
let lastError = null;

import { TabMutexMap, TabLockMap, runOnTab as runOnTabLib } from './lib/tab-concurrency.js';
import { PAGE_FALLBACK_FN, PAGE_RESOLVE_FALLBACK_FN } from './utils/smart-selector.js';
import { isHashOnlyChange } from './utils/navigation.js';

// --- Per-tab state (tasks 1.3, 1.4) ---------------------------------------
// Map<tabId, Array<{level,text,timestamp,url}>> and Map<tabId, Array<req>>.
// In-memory only: Chrome recycles the service worker (~30s idle), which wipes
// these. They're debug aids; the agent re-reads after new messages arrive.
// (Audit C3: the header previously claimed chrome.storage.session persistence
//  that was never implemented. Persisting on every message would be write-
//  heavy; the honest fix is to document the in-memory behavior.)
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

/**
 * In-flight call abort controllers, keyed by request id. The bridge forwards a
 * `cancel` control message when a call is aborted (client gone / timeout), and
 * the `cancel` handler aborts the matching controller so the in-flight handler
 * short-circuits and releases the tab mutex immediately. Without this, a slow
 * navigate (55s onUpdated wait) keeps the tab mutex pinned after the caller is
 * already gone, blocking every later call on the same tab. Set/cleared in
 * handleMessage's try/finally so it can't leak.
 */
const activeControllers = new Map();

// --- Per-tab mutex (task 2.1) + per-agent tab locks (task 2.2) ------------
// Pure, unit-tested primitives in lib/tab-concurrency.js.
const tabMutex = new TabMutexMap();
const windowCaptureMutex = new TabMutexMap();
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
    // The daemon gates /pair behind the enrollment secret (X-BC-Enrollment).
    // Without this header the call 403s and we'd never pair — so this is the
    // one daemon HTTP call the background makes, and it must carry the secret.
    const headers = {};
    if (enrollmentSecret) headers['X-BC-Enrollment'] = enrollmentSecret;
    const res = await fetch(`http://127.0.0.1:${wsPort}/pair`, { cache: 'no-store', headers });
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
    const stored = await chrome.storage.local.get(['wsPort', 'wsToken', 'enrollmentSecret']);
    if (stored.wsPort) wsPort = stored.wsPort;
    if (stored.wsToken) wsToken = stored.wsToken;
    if (stored.enrollmentSecret) enrollmentSecret = stored.enrollmentSecret;
  } catch {}

  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_INTERVAL_MIN });
  // Always try to (re)pair at startup so the WS carries a fresh token even if
  // the daemon rotated it or storage is empty.
  await autoPairToken();
  connect();

  // Best-effort: clear stale shields left on tabs whose lock state was wiped
  // by a service-worker recycle (tabLocks is in-memory — see the limitation
  // note near the top of this file). Swallow per-tab errors for protected /
  // closed tabs. A lock taken during the sweep sets tabLocks.owner, so the
  // `if (!tabLocks.owner(t.id))` check skips it; even if it races, the next
  // onUpdated 'complete' re-injects the shield (self-healing, review NOTE 7d).
  try {
    const all = await chrome.tabs.query({});
    for (const t of all) {
      if (!tabLocks.owner(t.id)) {
        try { await hideLockShield(t.id); } catch {}
      }
    }
  } catch {}
}

function wsUrl() {
  // 127.0.0.1 (not 'localhost') so it matches the daemon's IPv4 bind.
  // On macOS 'localhost' can resolve to IPv6 ::1 and refuse.
  const base = `ws://127.0.0.1:${wsPort}`;
  // ?token= stays for backward-compat with a daemon that has not yet picked up
  // the subprotocol auth. The token is ALSO sent via Sec-WebSocket-Protocol
  // (see connect()), which is the preferred path because query strings leak
  // into access logs / browser history. Once all shipped daemons accept the
  // subprotocol, the query param below can be dropped.
  return wsToken ? `${base}?token=${encodeURIComponent(wsToken)}` : base;
}

/**
 * Subprotocols to offer on the WS handshake. The daemon extracts the auth token
 * from the `bc-auth.<token>` offer (kept out of the URL query string) and ACKs
 * the bare `bc-auth` in return — so we MUST offer both: the token-bearing one
 * (for the daemon to read) AND the bare prefix (for the daemon to ACK without
 * echoing the token back to the page via ws.protocol). Offering only the
 * token-bearing one makes the server's `bc-auth` reply an invalid-subprotocol
 * error on the client side.
 */
function wsSubprotocols() {
  return wsToken ? [`bc-auth.${wsToken}`, 'bc-auth'] : [];
}

/**
 * Track whether the socket closed BEFORE opening (handshake destroyed). That's
 * the signature of a bad/missing token — so the next reconnect re-pairs first.
 */
let lastWasHandshakeClose = false;

async function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  // If the last attempt died mid-handshake, the token is likely stale/empty —
  // re-fetch it before reconnecting so we don't loop on a bad token.
  if (lastWasHandshakeClose) {
    await autoPairToken();
    lastWasHandshakeClose = false;
  }

  let opened = false;
  try {
    // Pass the auth token via subprotocol (preferred) so it stays out of the
    // URL query. wsUrl() still appends ?token= for compat with older daemons.
    const subs = wsSubprotocols();
    const socket = subs.length ? new WebSocket(wsUrl(), subs) : new WebSocket(wsUrl());
    ws = socket;

    socket.onopen = () => {
      if (ws !== socket) return;
      opened = true;
      isConnected = true;
      reconnectAttempts = 0;
      connectedSince = Date.now();
      lastError = null;
      updateBadge('connected');
      broadcastStatus('Connected');
    };

    socket.onclose = () => {
      if (ws !== socket) return;
      // closed before open = the daemon destroyed the upgrade (bad/no token)
      if (!opened) lastWasHandshakeClose = true;
      isConnected = false;
      connectedSince = null;
      ws = null;
      // Grey badge (not red) — a dropped/reconnecting socket is a normal state,
      // not an extension fault. scheduleReconnect() will broadcast the
      // "Retry #N in Xs" message; broadcastStatus here tells the popup it's
      // disconnected-but-trying, not broken.
      updateBadge('disconnected');
      broadcastStatus('Disconnected');
      scheduleReconnect();
    };

    socket.onerror = () => {
      if (ws !== socket) return;
      // Do NOT flip the badge to red ('error') here. ws.onerror fires on every
      // transient connection failure — most commonly during daemon restart, MV3
      // service-worker recycle, or the first attempt of an exponential-backoff
      // reconnect sequence. Flagging it as a hard error makes a benign, self-
      // healing retry look like the extension is broken (red "!" badge).
      // `ws.onclose` fires right after this and owns the state transition:
      // it sets the disconnected (grey) badge and schedules a reconnect. We only
      // stash the reason so the popup can show "why" if the user inspects it.
      isConnected = false;
      lastError = `Connection refused on port ${wsPort}`;
      // No updateBadge('error'), no broadcastStatus — onclose handles both.
    };

    socket.onmessage = async (event) => {
      if (ws !== socket) return;
      let msgId = null;
      try {
        const msg = JSON.parse(event.data);
        msgId = msg.id ?? null;
        if (msg.type === 'ping') {
          socket.send(JSON.stringify({ type: 'pong' }));
          return;
        }
        await handleMessage(msg);
      } catch (err) {
        console.error('[BrowserController] Message error:', err);
        // Audit C4/6d: a throw inside handleMessage (e.g. bad params, a handler
        // bug) used to leave the daemon hanging until its timeout. Reply with
        // an explicit error so the agent gets an actionable message fast.
        if (msgId && ws === socket && socket.readyState === WebSocket.OPEN) {
          try {
            socket.send(JSON.stringify({ id: msgId, success: false, error: err?.message || String(err) }));
          } catch { /* ws gone — close path will reject pending on the daemon */ }
        }
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
  // Below the give-up threshold: grey 'disconnected' badge + "retry in Ns"
  // (transient — daemon restarting / SW recycling / first backoff attempt).
  // At/above the threshold: the daemon has been unreachable for minutes, so
  // flip to a real red 'error' badge — this is the one case where red is honest.
  if (reconnectAttempts >= RECONNECT_GIVEUP_ATTEMPTS) {
    updateBadge('error');
    broadcastStatus(`Daemon unreachable after ${reconnectAttempts} attempts. Is it running?`);
  } else {
    updateBadge('disconnected');
    broadcastStatus(`Retry #${reconnectAttempts} in ${Math.round(delay / 1000)}s`);
  }
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

// Lock-shield: a full-viewport transparent input-capture layer + a blue inner
// frame, shown for the lifetime of a tab lock (not the transient per-action
// badge above). It blocks REAL user input on the top frame; the agent's own
// synthetic events bypass hit-testing by construction (handleClick / handleType
// dispatch directly on the resolved element). See specs/tab-control-lock/.
async function showLockShield(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        let el = document.getElementById('__bc-lock-shield');
        if (el) return; // idempotent — no stacked duplicates
        el = document.createElement('div');
        el.id = '__bc-lock-shield';
        el.style.cssText =
          'position:fixed;inset:0;z-index:2147483647;pointer-events:auto;' +
          'background:transparent;box-shadow:inset 0 0 0 4px #2563eb;';
        const block = (e) => {
          // Agent's own synthetic events (handleType/handlePressKey dispatch
          // KeyboardEvent directly on the target) have isTrusted===false and
          // MUST pass through — otherwise the capture-phase document listener
          // would swallow them before they reach the input, breaking typing on
          // locked tabs. Real user input is isTrusted===true (DOM invariant,
          // unforgeable) and gets blocked. (Fix-loop 3: audit C2.)
          if (e.isTrusted === false) return;
          e.preventDefault();
          e.stopImmediatePropagation();
        };
        // Mouse/pointer listeners attach to `el` (the overlay is the top-most
        // hit-target for pointer events, so capture listeners on `el` fire).
        for (const type of ['pointerdown', 'click', 'mousedown', 'mouseup', 'contextmenu']) {
          el.addEventListener(type, block, { capture: true });
        }
        // Keyboard/wheel/focus listeners attach to `document` instead: these
        // events target elements INSIDE <body> (e.g. document.activeElement),
        // and `el` is a SIBLING of <body> under <html> — NOT an ancestor — so a
        // capture-phase listener on `el` would never be on the propagation path.
        // `document` IS an ancestor of everything in <body>, so capture listeners
        // there fire site-wide. wheel/keydown/keyup need passive:false so
        // preventDefault() is honored.
        const docTypes = ['keydown', 'keyup', 'focus', 'wheel'];
        for (const type of docTypes) {
          const opts = type === 'wheel' || type === 'keydown' || type === 'keyup'
            ? { capture: true, passive: false }
            : { capture: true };
          document.addEventListener(type, block, opts);
        }
        // Stash the handler + types on `el` so hideLockShield can detach the
        // document-level listeners before removing `el` (el.remove() does NOT
        // auto-remove listeners bound to `document` — they would leak + keep
        // blocking keyboard/wheel/focus on the tab after unlock).
        el.__bcShieldDocListeners = { fn: block, types: docTypes };
        // document.documentElement exists even before <body> (early injection).
        document.documentElement.appendChild(el);
      },
    });
  } catch {} // swallow chrome:// / closed-tab / protected-page errors
}

async function hideLockShield(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const el = document.getElementById('__bc-lock-shield');
        if (!el) return; // no-op if absent
        // Detach document-level listeners (mouse/pointer listeners on `el`
        // auto-remove with the element; document listeners do NOT, so detach
        // them explicitly to avoid leaking keyboard/wheel/focus blocks).
        const bound = el.__bcShieldDocListeners;
        if (bound && typeof bound.fn === 'function' && Array.isArray(bound.types)) {
          for (const type of bound.types) {
            const opts = type === 'wheel' || type === 'keydown' || type === 'keyup'
              ? { capture: true, passive: false }
              : { capture: true };
            document.removeEventListener(type, bound.fn, opts);
          }
          el.__bcShieldDocListeners = null;
        }
        el.remove();
      },
    });
  } catch {}
}

function getConnectionState() {
  if (isConnected) return 'connected';
  if (reconnectAttempts > 0) return 'reconnecting';
  return 'disconnected';
}

function buildStatusPayload(message, tabs) {
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
    // Open-tab snapshot so the popup can render a Pin dropdown per tab without
    // a second round-trip. undefined when the caller didn't fetch tabs (the
    // popup treats missing the same as empty — see updateUI).
    tabs: tabs || [],
    statusMessage: message || null,
  };
}

function tabLocksToJSON() {
  return tabLocks.snapshot();
}

/**
 * Open tabs in the current window, each annotated with its lock owner so the
 * popup can show "Locked: {session}" and preselect it in the Pin dropdown.
 * Mirrors the shape of the `browser_tabs list` tool result (handleTabs) so the
 * popup and the agent-facing tool stay consistent.
 */
async function getOpenTabs() {
  try {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    return tabs.map((t) => ({
      id: t.id,
      url: t.url,
      title: t.title,
      active: t.active,
      lockedBy: tabLocks.owner(t.id) || null,
    }));
  } catch {
    return [];
  }
}

async function broadcastStatus(message) {
  // Tabs are fetched first so the popup's "Open Tabs" panel stays in sync with
  // lock changes (a lock op changes lockedBy, which the popup re-renders).
  const tabs = await getOpenTabs();
  chrome.runtime.sendMessage(buildStatusPayload(message, tabs)).catch(() => {});
}

// --- Message Router -------------------------------------------------------
//
// sessionId arrives as a first-class top-level field on the WS message (audit
// M1) — the daemon no longer injects it into params. We read it here so the
// per-tab mutex + lock layer can attribute the call; it never reaches a tool
// handler. (Previously it was smuggled through params.__sessionId, which
// coupled the multiplexer to the extension's wire format.)

async function handleMessage(msg) {
  // Control messages (non-tool) from the daemon. These carry a `type` and no
  // `tool`; handle them here before the tool-dispatch path assumes a tool call.
  if (msg.type === 'releaseSession') {
    // Session ids are unique even when two live clients share a display name.
    // Releasing one session therefore cannot unlock its sibling's tabs.
    const owner = msg.sessionId;
    if (owner) {
      // releaseByOwner is synchronous and returns the released tabIds before
      // any shield calls below run — no async race (review NOTE 7a).
      const released = tabLocks.releaseByOwner(owner);
      for (const tabId of released) hideLockShield(tabId);
      if (released.length) {
        broadcastStatus(`Released ${released.length} lock(s) from disconnected agent ${owner}`);
      }
    }
    return; // control message — no response expected
  }
  if (msg.type === 'cancel') {
    // The daemon/bridge aborted a call (client gone / timeout). Abort the
    // in-flight handler so it short-circuits and releases the tab mutex NOW —
    // otherwise a slow navigate (55s) blocks every later call on the same tab
    // even though the originating client is already gone. The handler's own
    // try/finally still runs (CDP detach, overlay hide), only its long await is
    // interrupted via the AbortSignal it was given.
    const cancelledId = msg.id;
    if (cancelledId && activeControllers.has(cancelledId)) {
      try { activeControllers.get(cancelledId).abort(); } catch { /* already settled */ }
    }
    return; // control message — no response expected
  }
  if (msg.type === 'ping') {
    // already handled in onmessage, but be defensive
    return;
  }

  const { id, tool, params } = msg;
  const p = { ...(params || {}) };
  const sessionId = msg.sessionId || null;
  const agentName = msg.agentName || null;

  // Resolve navigate's documented active-tab fallback before lock/mutex routing.
  // This freezes the target even if the user changes focus while the call waits.
  if (tool === 'browser_navigate' && typeof p.tabId !== 'number') {
    p.tabId = (await getActiveTab()).id;
  }
  const tabId = extractTabId(tool, p);

  // Tools without a tabId (tabs list/create, console-less) run directly.
  if (tabId == null) {
    const controller = new AbortController();
    activeControllers.set(id, controller);
    try {
      const result = await dispatch(tool, p, sessionId, agentName, controller.signal);
      sendResponse(id, { success: true, result });
    } catch (err) {
      sendResponse(id, { success: false, error: err.message || String(err) });
    } finally {
      activeControllers.delete(id);
    }
    return;
  }

  // Acquire this tab's mutex and honor the unique session's lock ownership.
  const controller = new AbortController();
  activeControllers.set(id, controller);
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
        const result = await dispatch(tool, p, sessionId, agentName, controller.signal);
        sendResponse(id, { success: true, result });
      } catch (err) {
        sendResponse(id, { success: false, error: err.message || String(err) });
      } finally {
        currentActivity = null;
        updateBadge(isConnected ? 'connected' : 'disconnected');
        await hideOverlay(tabId);
      }
    },
  )
    .catch((err) => {
      sendResponse(id, { success: false, error: err.message || String(err) });
    })
    .finally(() => {
      activeControllers.delete(id);
    });
}

function sendResponse(id, response) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ id, ...response }));
  }
}

/** Which tabId does this call target? null = tab-agnostic (tabs list/create). */
function extractTabId(_tool, params) {
  return typeof params.tabId === 'number' ? params.tabId : null;
}

// --- Per-tab mutex + tab lock: see lib/tab-concurrency.js (tasks 2.1, 2.2) -
// runOnTabLib(locks, mutex, tabId, sessionId, fn) serializes per-tab work and
// makes non-owner sessions wait for the lock owner. Tested in
// tests/tab-concurrency.test.ts.

// --- Tool Dispatch --------------------------------------------------------

async function dispatch(tool, params, sessionId, agentName, signal) {
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
    // Legacy wire-name aliases (find / get_page_text) removed: the tool files
    // now send their canonical .name (browser_find / browser_text), so the
    // aliases would only mask future drift. (audit C1)
    browser_find: handleFind,
    browser_text: handleGetPageText,
  };

  const handler = handlers[tool];
  if (!handler) throw new Error(`Unknown tool: ${tool}`);
  return handler(params, sessionId, agentName, signal);
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

async function handleNavigate(params, _sessionId, _agentName, signal) {
  const { url, waitUntil = 'load', tabId, snapshot: wantSnapshot = true } = params;
  // navigate is the one page tool allowed to omit tabId → active tab fallback.
  const tab = tabId != null ? await resolveTab(tabId) : await getActiveTab();

  // Fix #2 (hash-aware): a hash-only navigation does NOT reload the document,
  // so `chrome.tabs.onUpdated` never fires `status === 'complete'` and the wait
  // below would hang for the full 55s timeout. Detect this case and skip the
  // wait entirely — the SPA router updates client-side near-instantly.
  const currentTab = await chrome.tabs.get(tab.id);
  const hashOnly = isHashOnlyChange(currentTab.url, url);

  // A promise that rejects when this call is cancelled (client gone / timeout
  // forwarded from the bridge). Handlers that await long-running operations
  // race against this so a cancelled call releases the tab mutex immediately
  // instead of blocking later calls on the same tab.
  const cancelRace = signal
    ? new Promise((_, reject) => {
        if (signal.aborted) reject(new Error('aborted'));
        else signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      })
    : null;

  // Fix #1 (SPA-ready): Chrome fires `complete` as soon as the HTML loads, but
  // SPAs (React/Vue/...) render content via JS AFTER that — so a snapshot taken
  // immediately returns an empty body. We (a) wait for `complete`, (b) give the
  // SPA ~500ms to render, then (c) return a snapshot inline so the agent doesn't
  // waste a separate browser_snapshot call on a still-empty page. On a protected
  // page (chrome://, 401 Basic auth) the snapshot will surface a clear error
  // instead of silently returning empty.
  if (!hashOnly) {
    const onUpdatedWait = new Promise((resolve, reject) => {
      const listener = (tId, changeInfo) => {
        if (tId !== tab.id) return;
        if (changeInfo.status === 'complete' || (waitUntil === 'domcontentloaded' && changeInfo.status === 'complete')) {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      chrome.tabs.update(tab.id, { url }).catch((err) => {
        chrome.tabs.onUpdated.removeListener(listener);
        reject(err);
      });
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(); // timeout — still proceed to settle + snapshot
      }, 55000);
    });
    // Race the load wait against cancellation so a closed client doesn't pin
    // the tab mutex for up to 55s.
    if (cancelRace) {
      await Promise.race([onUpdatedWait, cancelRace]);
    } else {
      await onUpdatedWait;
    }
  } else {
    // Hash-only: apply the URL (updates location.hash, no reload) and skip the
    // onUpdated wait. SPA routers update synchronously on hashchange.
    await chrome.tabs.update(tab.id, { url });
  }

  // SPA settle window. 500ms is a cheap, robust default that covers most
  // client-rendered apps without making navigation feel slow for static pages.
  await new Promise((r) => setTimeout(r, 500));

  // Return the snapshot inline ONLY if the caller asked for it (default true).
  // Skipping it (snapshot:false) saves a large chunk of tokens when the agent
  // intends to call browser_snapshot itself or doesn't need the tree yet.
  if (!wantSnapshot) {
    return { url, status: 'navigated', tabId: tab.id };
  }
  try {
    const snap = await handleSnapshot({ tabId: tab.id, compact: true });
    const snapObj = typeof snap === 'string' ? JSON.parse(snap) : snap;
    return {
      url,
      status: 'navigated',
      tabId: tab.id,
      snapshot: snapObj && snapObj.content ? snapObj.content : snapObj,
    };
  } catch {
    // snapshot failed (protected page / 401 / etc) — navigation still succeeded.
    return { url, status: 'navigated', tabId: tab.id };
  }
}

async function handleClick(params) {
  const { tabId, ref, selector, button = 'left', doubleClick = false } = params;
  await resolveTab(tabId);
  const fb = getFallback(tabId, ref);
  const resolveFallbackSrc = PAGE_RESOLVE_FALLBACK_FN.toString();

  const res = await safeExec(tabId, async (_ref, _sel, _btn, _dbl, _fb, resolveFallbackSrc) => {
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

    // Fix #2 (visibility retry): after scrollIntoView, the element may still be
    // off-screen or zero-size if layout hasn't reflowed yet. Give it one short
    // settle (200ms) and re-read the element once. This kills the common "element
    // present but click landed nowhere" failure on lazy-rendered lists. Bounded
    // to a single retry so a truly-hidden element still surfaces honestly.
    const rect0 = el.getBoundingClientRect();
    const visible0 = rect0.width > 0 && rect0.height > 0;
    if (!visible0) {
      await new Promise((r) => setTimeout(r, 200));
      // re-resolve the element (it may have been re-rendered with a new node)
      el = _ref ? document.querySelector(`[data-mcp-ref="${_ref}"]`) : el;
      if (el) el.scrollIntoView({ behavior: 'instant', block: 'center' });
    }
    if (!el) return { success: false, error: 'REF_GONE', _ref };

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

  const res = await safeExec(tabId, (_ref, _sel, _text, _clear, _fb, resolveFallbackSrc) => {
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

    const setNativeValue = (target, nextValue) => {
      const prototype = target instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (setter) setter.call(target, nextValue);
      else target.value = nextValue;
    };

    if (_clear) {
      if (el.isContentEditable) el.textContent = '';
      else setNativeValue(el, '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }

    if (el.isContentEditable) {
      document.execCommand('insertText', false, _text);
    } else {
      for (const ch of _text) {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
        setNativeValue(el, `${el.value}${ch}`);
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
  const refPrefix = `e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-`;

  return safeExec(tabId, (_sel, _compact, genFallbackSrc, _prevFingerprints, _refPrefix) => {
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

      const ref = `${_refPrefix}${refCount++}`;
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

      const ref = `${_refPrefix}${refCount++}`;
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
  }, [selector, compact, genFallbackSrc, prevFingerprints, refPrefix]).then((res) => {
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
  return windowCaptureMutex.run(tab.windowId, async () => {
    const [previousActive] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
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
        quality: format === 'jpeg' ? quality : undefined,
      });
      return { success: true, format, data: dataUrl.split(',')[1] };
    } finally {
      if (wasLocked) await showLockShield(tabId);
      if (changedActiveTab && previousActive?.id != null) {
        const [currentActive] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
        if (currentActive?.id === tabId) {
          await chrome.tabs.update(previousActive.id, { active: true }).catch(() => {});
        }
      }
    }
  });
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
        // Compact: truncate long tracking URLs, omit lockedBy when null (saves
        // tokens — a 20-tab list with full FB/Google URLs was ~3K tokens).
        tabs: tabs.map((t) => {
          const entry = { id: t.id, title: t.title, active: t.active };
          const url = String(t.url || '');
          entry.url = url.length > 80 ? url.slice(0, 77) + '...' : url;
          const owner = tabLocks.owner(t.id);
          if (owner) entry.lockedBy = owner; // omit when null — saves tokens
          return entry;
        }),
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
      hideLockShield(tabId); // defensive — onRemoved will also fire, but explicit is cheap
      return { success: true, closed: tabId };
    }
    case 'focus': {
      if (!tabId) throw new Error('tabId required');
      await chrome.tabs.update(tabId, { active: true });
      return { success: true, focused: tabId };
    }
    case 'lock': {
      if (!tabId) throw new Error('tabId required');
      const owner = sessionId;
      if (!owner) throw new Error('lock requires an authenticated session');
      tabLocks.lock(tabId, owner);
      showLockShield(tabId); // show blue frame + input block for the lock lifetime
      broadcastStatus(`Tab ${tabId} locked by ${owner}`);
      return { success: true, locked: tabId, owner };
    }
    case 'unlock': {
      if (!tabId) throw new Error('tabId required');
      if (!sessionId) throw new Error('unlock requires an authenticated session');
      const was = tabLocks.owner(tabId);
      tabLocks.unlock(tabId, sessionId);
      if (tabLocks.owner(tabId)) {
        throw new Error(`Tab ${tabId} is locked by another session`);
      }
      hideLockShield(tabId);
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
  const refPrefix = `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-`;

  return safeExec(tabId, (_q, _lim, _refPrefix) => {
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

      const ref = `${_refPrefix}${rc++}`;
      node.setAttribute('data-mcp-ref', ref);
      matches.push({
        ref, role: r, name: n.slice(0, 100), tag: node.tagName.toLowerCase(), score,
        bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      });
    }

    matches.sort((a, b) => b.score - a.score);
    return { success: true, query: _q, matches: matches.slice(0, _lim) };
  }, [query, limit, refPrefix]);
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

  // Wrap the user expression in an async IIFE so `await` works, then run it in
  // the MAIN world (page's own JS context). We serialize the result to a JSON
  // string INSIDE the page and parse it back here, because Manifest V3's
  // chrome.scripting.executeScript loses the resolved value of an async IIFE
  // across the world boundary (it comes back as null — crbug 1304272). A plain
  // string survives the structured clone reliably.
  const wrapped = `(async () => { ${expression} })()`;
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async (code) => {
      try {
        // eslint-disable-next-line no-eval
        const value = await eval(code);
        return { ok: true, json: JSON.stringify(value) };
      } catch (err) {
        return { ok: false, error: String(err && err.message || err) };
      }
    },
    args: [wrapped],
  });
  const out = results?.[0]?.result;
  if (!out) return { success: false, error: 'evaluate returned no result' };
  if (out.ok === false) return { success: false, error: out.error };
  let value;
  try {
    value = out.json === undefined ? undefined : JSON.parse(out.json);
  } catch {
    // JSON.stringify can fail for values it can't represent (functions, etc.);
    // fall back to the raw string so the caller still gets something useful.
    value = out.json;
  }
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

async function handleRunAction(params, _sessionId, _agentName, signal) {
  const { tabId, code, actionParams = {} } = params;
  if (!code) throw new Error('code is required');
  const tab = await resolveTab(tabId);

  // run_action stays on CDP (plan decision: CDP-only, can't be scripted —
  // it bypasses page CSP via the debugger protocol, unlike browser_evaluate).
  await chrome.debugger.attach({ tabId: tab.id }, '1.3');
  try {
    const paramsJson = JSON.stringify(actionParams);
    // Dual mode: accept EITHER a {execute:function()} tool wrapper (legacy
    // skill syntax) OR a plain JS expression/statement (simple usage like
    // "document.title" or "var x=...; JSON.stringify(x)"). Previously only
    // the wrapper worked; any plain expression returned "No execute function
    // found", making the tool unusable for simple extraction tasks.
    const expression = `(async function() {
      try {
        var result = await (${code});
        if (result && typeof result.execute === "function") {
          result = await result.execute(${paramsJson});
        }
        if (result && Array.isArray(result.content)) {
          return result;
        }
        var raw = (typeof result === 'object' && result !== null) ? JSON.stringify(result) : String(result);
        return { content: [{ type: 'text', text: raw }] };
      } catch(e) {
        return { error: e.message, stack: e.stack };
      }
    })()`;

    const { result, exceptionDetails } = await chrome.debugger.sendCommand(
      { tabId: tab.id },
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
    );

    // Cancellation: if the caller (daemon/bridge) aborted while the page was
    // evaluating (e.g. a long IIFE), the result is now useless — drop it so the
    // tab mutex releases immediately and the next caller isn't queued behind a
    // dead request.
    if (signal?.aborted) {
      return { success: false, error: 'aborted' };
    }
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
    // Async: fetch tabs before responding so the popup gets a full snapshot
    // (connection + locks + open tabs) in one message. Returning true signals
    // Chrome we'll call respond() asynchronously.
    getOpenTabs().then((tabs) => {
      respond(buildStatusPayload(undefined, tabs));
    });
    return true; // async response
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
  if (msg.type === 'setEnrollment') {
    // The popup owns the user-facing entry of the enrollment secret. Persist
    // it, re-pair (so /pair runs under the new secret and refreshes wsToken),
    // then reconnect. Mirrors setToken's teardown so a stale WS doesn't linger.
    // NOTE: the onMessage listener is NOT async, so we .then() the re-pair and
    // return true (Chrome keeps the respond() channel open for the async reply).
    enrollmentSecret = (msg.enrollment || '').trim();
    chrome.storage.local.set({ enrollmentSecret });
    autoPairToken().then(() => {
      ws?.close();
      ws = null;
      isConnected = false;
      reconnectAttempts = 0;
      connect();
      respond({ success: true });
    });
    return true; // async response — respond() fires from the .then()
  }
  if (msg.type === 'unlockAll') {
    // Snapshot BEFORE unlockAll() — unlockAll clears the map, so reading after
    // would lose the list of tabs whose shields need removing.
    const prev = tabLocks.snapshot();
    tabLocks.unlockAll();
    for (const { tabId } of prev) hideLockShield(tabId);
    broadcastStatus('All tab locks cleared');
    respond({ success: true });
    return false;
  }
  if (msg.type === 'lockTab') {
    const owner = msg.sessionId;
    if (msg.tabId == null || !owner) {
      respond({ success: false, error: 'tabId and sessionId required' });
      return false;
    }
    try {
      tabLocks.lock(msg.tabId, owner);
      showLockShield(msg.tabId);
      broadcastStatus(`Tab ${msg.tabId} pinned to ${owner}`);
      respond({ success: true });
    } catch (err) {
      respond({ success: false, error: err?.message || String(err) });
    }
    return false;
  }
  if (msg.type === 'unlockTab') {
    // { tabId } — release one tab's lock (vs unlockAll which clears all).
    if (msg.tabId == null) {
      respond({ success: false, error: 'tabId required' });
      return false;
    }
    const was = tabLocks.owner(msg.tabId);
    tabLocks.release(msg.tabId);
    hideLockShield(msg.tabId);
    broadcastStatus(`Tab ${msg.tabId} unpinned (was ${was || '-'})`);
    respond({ success: true, previousSession: was || null });
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
// NOTE: no hideLockShield here — the tab/page is already gone, so a shield
// inject would just throw (swallowed) and there is nothing to remove.
chrome.tabs.onRemoved.addListener((tabId) => {
  tabLocks.release(tabId);
  consoleByTab.delete(tabId);
  networkByTab.delete(tabId);
  fallbackByTab.delete(tabId);
  lastSnapshotFingerprints.delete(tabId);
});

// Re-inject the lock shield after a FULL navigation on a locked tab. A full
// navigation destroys the injected DOM (new document), so without this the
// page would be user-controllable again even though tabLocks still holds the
// lock. A hash-only / SPA navigation does NOT reload the document, so the
// shield survives and onUpdated does not fire a new 'complete' for it (see
// isHashOnlyChange in utils/navigation.js + handleNavigate). showLockShield is
// idempotent (the __bc-lock-shield guard), so re-injecting on a tab whose
// shield is still present is a no-op. This module-level listener is SEPARATE
// from the short-lived per-call listener inside handleNavigate — they share no
// state and Chrome supports multiple onUpdated listeners (review NOTE 7c).
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete' && tabLocks.owner(tabId)) {
    showLockShield(tabId);
  }
});

initConnection();
