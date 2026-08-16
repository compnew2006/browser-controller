/**
 * Daemon connection lifecycle (extracted from background.js): WS connect /
 * reconnect / badge / status broadcast, plus the popup's port/token/enrollment
 * setters. The tool-message handler is INJECTED via setMessageHandler by
 * background.js — this module must not import the router (that would cycle:
 * router → handlers → connection).
 */
import { tabLocks, loadSessionState } from './state.js';
import { hideLockShield } from './overlay.js';

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

let wsPort = DEFAULT_WS_PORT;
let wsToken = ''; // auth token (3.1); appended as ?token=
// Enrollment secret the daemon gates /pair behind. The popup owns the
// user-facing entry of it; the background re-reads it from storage on every
// service-worker recycle (MV3 kills the worker ~30s idle, so this re-load is
// not optional) and sends it on /pair. Without this, the background's own
// autoPairToken() 403s under the enrollment gate and reconnect dies.
let enrollmentSecret = '';
let ws = null;
let connected = false;
let reconnectAttempts = 0;
let reconnectTimeout = null;
let nextRetryMs = 0;
let connectedSince = null;
let lastError = null;
let currentActivity = null; // tool currently running (single overlay label source)

/** The router's handleMessage — injected by background.js at wiring time. */
let messageHandler = null;

export function setMessageHandler(fn) {
  messageHandler = fn;
}

export function isWsConnected() {
  return connected;
}

export function setCurrentActivity(name) {
  currentActivity = name;
}

/** Send a JSON frame to the daemon if (and only if) the socket is open. */
export function sendJson(obj) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

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

export async function initConnection() {
  try {
    const stored = await chrome.storage.local.get(['wsPort', 'wsToken', 'enrollmentSecret']);
    if (stored.wsPort) wsPort = stored.wsPort;
    if (stored.wsToken) wsToken = stored.wsToken;
    if (stored.enrollmentSecret) enrollmentSecret = stored.enrollmentSecret;
  } catch {}

  // Restore lock ownership + fallbacks BEFORE connecting: the shield sweep
  // below must honor persisted owners (architecture: MV3 state persistence),
  // and lock routing must see the real ownership when the first call arrives.
  await loadSessionState();

  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_INTERVAL_MIN });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === KEEPALIVE_ALARM && !connected) connect();
  });
  // Always try to (re)pair at startup so the WS carries a fresh token even if
  // the daemon rotated it or storage is empty.
  await autoPairToken();
  connect();

  // Best-effort: clear stale shields left on tabs whose lock state was wiped
  // by a service-worker recycle. With session persistence the owner check now
  // also skips tabs whose locks SURVIVED the recycle — only genuinely unlocked
  // tabs get their shields cleared. Swallow per-tab errors for protected /
  // closed tabs. Even if it races a fresh lock, the next onUpdated 'complete'
  // re-injects the shield (self-healing, review NOTE 7d).
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

export async function connect() {
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
      connected = true;
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
      connected = false;
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
      connected = false;
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
        if (messageHandler) await messageHandler(msg);
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

// --- Badge & status ---------------------------------------------------------

export function updateBadge(status) {
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

export function getConnectionState() {
  if (connected) return 'connected';
  if (reconnectAttempts > 0) return 'reconnecting';
  return 'disconnected';
}

export function buildStatusPayload(message, tabs) {
  return {
    type: 'status',
    connectionState: getConnectionState(),
    port: wsPort,
    reconnectAttempts,
    nextRetryMs,
    connectedSince,
    lastError,
    activity: currentActivity,
    tabLocks: tabLocks.snapshot(),
    // Open-tab snapshot so the popup can render a Pin dropdown per tab without
    // a second round-trip. undefined when the caller didn't fetch tabs (the
    // popup treats missing the same as empty — see updateUI).
    tabs: tabs || [],
    statusMessage: message || null,
  };
}

/**
 * Open tabs in the current window, each annotated with its lock owner so the
 * popup can show "Locked: {session}" and preselect it in the Pin dropdown.
 * Mirrors the shape of the `browser_tabs list` tool result (handleTabs) so the
 * popup and the agent-facing tool stay consistent.
 */
export async function getOpenTabs() {
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

export async function broadcastStatus(message) {
  // Tabs are fetched first so the popup's "Open Tabs" panel stays in sync with
  // lock changes (a lock op changes lockedBy, which the popup re-renders).
  const tabs = await getOpenTabs();
  chrome.runtime.sendMessage(buildStatusPayload(message, tabs)).catch(() => {});
}

// --- Popup setters (setPort / setToken / setEnrollment) ---------------------

/** Tear down the current WS and reconnect (shared by all three setters). */
function resetAndReconnect() {
  ws?.close();
  ws = null;
  connected = false;
  reconnectAttempts = 0;
  connect();
}

export function applyPort(port) {
  const p = parseInt(port, 10);
  if (p > 0 && p < 65536) {
    wsPort = p;
    chrome.storage.local.set({ wsPort: p });
    resetAndReconnect();
    return { success: true, port: p };
  }
  return { success: false, error: 'Invalid port' };
}

export function applyToken(token) {
  // extension popup can store the auth token (3.1) once.
  wsToken = (token || '').trim();
  chrome.storage.local.set({ wsToken });
  resetAndReconnect();
  return { success: true };
}

/**
 * The popup owns the user-facing entry of the enrollment secret. Persist it,
 * re-pair (so /pair runs under the new secret and refreshes wsToken), then
 * reconnect. Mirrors applyToken's teardown so a stale WS doesn't linger.
 * Async: the caller (events.js) keeps the respond() channel open.
 */
export async function applyEnrollment(enrollment) {
  enrollmentSecret = (enrollment || '').trim();
  chrome.storage.local.set({ enrollmentSecret });
  await autoPairToken();
  resetAndReconnect();
}
