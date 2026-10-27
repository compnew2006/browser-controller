/**
 * Daemon connection lifecycle (extracted from background.js): WS connect /
 * reconnect / badge / status broadcast, plus the popup's port/token/enrollment
 * setters. The tool-message handler is INJECTED via setMessageHandler by
 * background.js — this module must not import the router (that would cycle:
 * router → handlers → connection).
 */
import {
  tabLocks,
  tabControl,
  loadSessionState,
  persistSessionState,
  getAdoptedDaemonInstance,
  setAdoptedDaemonInstance,
} from './state.js';
import { hideLockShield } from './overlay.js';
import { buildExtensionHelloAck, OLDER_DAEMON_REASON, validateDaemonHello } from './protocol.js';
import { daemonWebSocketUrl, defaultBrowserLabel, isDaemonListening, withTimeout } from './connection-transport.js';
import {
  authenticatedDaemonFetch,
  createWebSocketClientProof,
  DaemonAuthenticationError,
  newAuthNonce,
  verifyWebSocketDaemonProof,
} from './daemon-auth.js';
import { restoreVaultRuntimeState } from './vault-actions.js';
import { VaultConnectionChannel } from './vault-connection.js';
import {
  DEFAULT_WS_PORT,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  RECONNECT_GIVEUP_ATTEMPTS,
  KEEPALIVE_ALARM,
  KEEPALIVE_INTERVAL_MIN,
  HANDSHAKE_TIMEOUT_MS,
  PROBE_TIMEOUT_MS,
} from './connection-policy.js';

let wsPort = DEFAULT_WS_PORT;
let wsToken = ''; // auth token used only to prove the extension's WebSocket handshake
// Enrollment secret is re-read after each MV3 service-worker recycle and used
// locally to verify daemon proofs; it is never sent over HTTP or WebSocket.
let enrollmentSecret = '';
/** The user set the port in the popup: the pairing host's port must not override it. */
let portFromUser = false;
/** HTTP status of the last /pair call (0 = daemon unreachable). */
let lastPairStatus = 0;
// Zero-touch pairing (`npm run setup:pairing`): a native messaging host hands
// over the enrollment secret from ~/.browser-controller. Chrome lets only the
// extension IDs in the host manifest start it, so the secret stays
// out-of-band (never over the daemon's HTTP channel). Spawning it costs a
// process, so it is asked at most once per NATIVE_PAIR_RETRY_MS.
const NATIVE_PAIRING_HOST = 'com.browser_controller.pairing';
const NATIVE_PAIR_RETRY_MS = 30000;
let nativePairAt = 0;
let lastPairingNote = '';
let ws = null;
let connected = false;
const vaultChannel = new VaultConnectionChannel({ getSocket: () => ws, isConnected: () => connected });
let reconnectAttempts = 0;
let reconnectTimeout = null;
let nextRetryMs = 0;
let connectedSince = null;
let lastError = null;
let currentActivity = null; // tool currently running (single overlay label source)
let handshakeTimeout = null;
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

export function sendVaultProtectionTabRemoved(removal) {
  vaultChannel.sendProtectionTabRemoved(removal);
}

export function sendVaultUiClosed() {
  vaultChannel.sendUiClosed();
}

export function requestVaultUi(payload) {
  return vaultChannel.requestUi(payload);
}

/**
 * Auto-pair: fetch the daemon's auth token over localhost. The background
 * service worker can fetch() (it has host_permissions for 127.0.0.1:7225), and
 * it MUST own this — the popup only exists while open, but the WS connection is
 * driven by the background at startup and via the keepalive alarm. Returns the
 * token, or '' if the daemon isn't up yet (caller retries via reconnect loop).
 */
async function autoPairToken() {
  if (!enrollmentSecret) {
    lastPairStatus = 403;
    return '';
  }
  try {
    // Bounded: connect() holds its attempt guard through pairing.
    const { res, data } = await withTimeout(async (signal) => {
      const res = await authenticatedDaemonFetch({ baseUrl: `http://127.0.0.1:${wsPort}`, target: '/pair', enrollmentSecret, signal });
      return { res, data: res.ok ? await res.json() : null };
    });
    lastPairStatus = res.status;
    if (!res.ok) return '';
    if (data && typeof data.token === 'string' && data.token) {
      if (data.token !== wsToken) {
        wsToken = data.token;
        chrome.storage.local.set({ wsToken });
      }
      return data.token;
    }
  } catch (err) {
    // daemon not reachable yet
    lastPairStatus = err instanceof DaemonAuthenticationError ? -1 : 0;
  }
  return '';
}

/** Tell the popup's activity log how pairing went (each distinct note once). */
function notePairing(message) {
  if (message === lastPairingNote) return;
  lastPairingNote = message;
  broadcastStatus(message).catch(() => {});
}

/** Actionable text for chrome.runtime.sendNativeMessage failures. */
function nativePairingHint(message) {
  if (/not found/i.test(message)) {
    return 'Auto-pairing is not set up: run `npm run setup:pairing` in the browser-controller folder, then reload the extension (or paste the enrollment secret in Settings).';
  }
  if (/forbidden/i.test(message)) {
    return 'The pairing host does not allow this extension ID: run `npm run setup:pairing` again (see `npm run pairing:status`).';
  }
  return `Auto-pairing failed: ${message}`;
}

/**
 * Ask the native pairing host for the enrollment secret. Returns true when it
 * changed something (secret or port), i.e. when /pair is worth retrying.
 */
async function nativePair() {
  if (!chrome.runtime?.sendNativeMessage) return false;
  if (Date.now() - nativePairAt < NATIVE_PAIR_RETRY_MS) return false;
  nativePairAt = Date.now();
  let reply;
  try {
    reply = await withTimeout(() => chrome.runtime.sendNativeMessage(NATIVE_PAIRING_HOST, { type: 'pairing' }));
  } catch (err) {
    notePairing(nativePairingHint(err?.message || String(err)));
    return false;
  }
  if (!reply?.ok || typeof reply.enrollmentSecret !== 'string' || !reply.enrollmentSecret) {
    notePairing(`Auto-pairing: ${reply?.error || 'the pairing host returned no secret.'}`);
    return false;
  }
  let changed = false;
  if (!portFromUser && Number.isInteger(reply.port) && reply.port > 0 && reply.port < 65536 && reply.port !== wsPort) {
    wsPort = reply.port;
    changed = true;
  }
  if (reply.enrollmentSecret !== enrollmentSecret) {
    enrollmentSecret = reply.enrollmentSecret;
    chrome.storage.local.set({ enrollmentSecret });
    changed = true;
  }
  return changed;
}

/**
 * Get a token. Fetch the enrollment secret from the pairing host when needed,
 * and refresh it after an authentication failure. An unreachable daemon is
 * left to the reconnect loop.
 */
export async function ensurePairing() {
  const pairedFromHost = !enrollmentSecret && await nativePair();
  if (!enrollmentSecret) return '';
  const token = await autoPairToken();
  if (token) {
    if (pairedFromHost) notePairing('Paired automatically (enrollment secret from the local pairing host).');
    return token;
  }
  if (lastPairStatus !== 403 && lastPairStatus !== -1) return '';
  if (!(await nativePair())) return '';
  const retried = await autoPairToken();
  if (retried) notePairing('Paired automatically (enrollment secret from the local pairing host).');
  return retried;
}

/** This browser profile's identity for multi-browser routing (persisted). */
let browserIdentity = {};

export async function initConnection() {
  await restoreVaultRuntimeState();
  try {
    const stored = await chrome.storage.local.get(['wsPort', 'wsToken', 'enrollmentSecret', 'bcBrowserId', 'bcBrowserLabel']);
    if (stored.wsPort) { wsPort = stored.wsPort; portFromUser = true; }
    if (stored.wsToken) wsToken = stored.wsToken;
    if (stored.enrollmentSecret) enrollmentSecret = stored.enrollmentSecret;
    let id = stored.bcBrowserId;
    if (!id) {
      id = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)).replace(/-/g, '').slice(0, 12);
      chrome.storage.local.set({ bcBrowserId: id });
    }
    browserIdentity = { browserId: id, browserLabel: stored.bcBrowserLabel || defaultBrowserLabel(id) };
  } catch {}

  // Restore lock ownership + fallbacks BEFORE connecting: lock routing must see
  // the real ownership when the first call arrives (architecture: MV3 state persistence).
  await loadSessionState();

  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_INTERVAL_MIN });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === KEEPALIVE_ALARM && !connected) connect();
  });
  // Always try to (re)pair at startup so the WS carries a fresh token even if
  // the daemon rotated it or storage is empty (then the pairing host is asked).
  await ensurePairing();
  connect();

  // Best-effort sweep of shields a service-worker death mid-call left behind.
  // The frame exists only during a tool call, so every tab gets a removal,
  // locked or not. hideLockShield swallows per-tab errors (protected / closed tabs).
  try {
    const all = await chrome.tabs.query({});
    for (const t of all) await hideLockShield(t.id);
  } catch {}
}

/**
 * Locks, control entries and shields belong to the daemon instance that granted
 * them. A hello from a DIFFERENT instance means the daemon restarted, so every
 * agent session of the old one is gone and its locks are stale: release them,
 * forget the control entries and take the shields down. The adopted instance
 * is persisted with the locks, so the check also holds across a service-worker
 * recycle. A hello with no instance id (a daemon from before instance ids)
 * changes nothing. Returns how many locks were released.
 * @param {string|undefined} instanceId
 * @returns {number}
 */
export function adoptDaemonInstance(instanceId) {
  if (typeof instanceId !== 'string' || !instanceId) return 0;
  if (getAdoptedDaemonInstance() === instanceId) return 0;
  setAdoptedDaemonInstance(instanceId);
  const stale = tabLocks.snapshot();
  tabLocks.unlockAll();
  tabControl.clear();
  persistSessionState();
  // hideLockShield never throws (it is bounded and swallows per-tab errors).
  for (const { tabId } of stale) hideLockShield(tabId);
  if (stale.length) broadcastStatus(`Released ${stale.length} tab lock(s) left by a previous daemon`);
  return stale.length;
}

/**
 * Track whether the socket closed BEFORE opening (handshake destroyed). That's
 * the signature of a bad/missing token — so the next reconnect re-pairs first.
 */
let lastWasHandshakeClose = false;

/** One attempt at a time: a second connect() while probing or pairing would open a second socket. */
let probing = false;

export async function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  if (probing) return;
  probing = true;
  try {
    if (!(await isDaemonListening(wsPort, PROBE_TIMEOUT_MS))) {
      lastError = `Daemon not running on port ${wsPort}`;
      scheduleReconnect();
      return;
    }

    // If the last attempt died mid-handshake, the token is likely stale/empty —
    // re-fetch it before reconnecting so we don't loop on a bad token.
    if (lastWasHandshakeClose) {
      await ensurePairing();
      lastWasHandshakeClose = false;
    }
    if (!enrollmentSecret || !wsToken) {
      await ensurePairing();
      if (!enrollmentSecret || !wsToken) {
        lastError = 'Pairing is required before connecting to the daemon';
        scheduleReconnect();
        return;
      }
    }
  } finally { probing = false; }

  let opened = false;
  let daemonAuthenticated = false;
  let acknowledged = false;
  const clientNonce = newAuthNonce();
  try {
    const socket = new WebSocket(daemonWebSocketUrl(wsPort));
    ws = socket;

    socket.onopen = () => {
      if (ws !== socket) return;
      opened = true;
      connected = false;
      lastError = null;
      updateBadge('disconnected');
      broadcastStatus('Connected transport; negotiating protocol');
      socket.send(JSON.stringify({ type: 'authInit', clientNonce }));
      clearTimeout(handshakeTimeout);
      handshakeTimeout = setTimeout(() => {
        if (ws !== socket || socket.readyState !== WebSocket.OPEN || connected) return;
        refuseDaemon(socket, OLDER_DAEMON_REASON);
      }, HANDSHAKE_TIMEOUT_MS);
    };

    socket.onclose = (event) => {
      if (ws !== socket) return;
      // closed before open = the daemon destroyed the upgrade; a 1002 after our
      // helloAck = the daemon refused its proof (stale token). Either way re-pair first.
      if (!opened || (acknowledged && event?.code === 1002)) lastWasHandshakeClose = true;
      connected = false;
      vaultChannel.setSupported(false);
      vaultChannel.failUiRequests();
      clearTimeout(handshakeTimeout);
      handshakeTimeout = null;
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
        if (msg.type === 'hello') {
          const compatibility = validateDaemonHello(msg);
          if (!compatibility.ok) {
            refuseDaemon(socket, compatibility.reason || 'Incompatible daemon protocol');
            return;
          }
          const verified = await verifyWebSocketDaemonProof(enrollmentSecret, msg, clientNonce);
          // The proof is checked asynchronously: the socket may have closed meanwhile.
          if (ws !== socket || socket.readyState !== WebSocket.OPEN) return;
          if (!verified) {
            lastWasHandshakeClose = true;
            refuseDaemon(socket, 'Daemon authentication failed. Check the local pairing and restart the daemon.');
            return;
          }
          const acknowledgement = buildExtensionHelloAck(chrome.runtime.getManifest().version, browserIdentity, {
            clientNonce,
            instanceId: msg.instanceId,
          });
          acknowledgement.authProof = await createWebSocketClientProof(wsToken, msg, {
            ...browserIdentity,
            capabilities: acknowledgement.capabilities,
          });
          if (ws !== socket || socket.readyState !== WebSocket.OPEN) return;
          socket.send(JSON.stringify(acknowledgement));
          acknowledged = true;
          daemonAuthenticated = true;
          // Only a proven daemon may cause state adoption or vault negotiation.
          adoptDaemonInstance(msg.instanceId);
          vaultChannel.setSupported(msg.capabilities.includes('credential-vault-v1'));
          clearTimeout(handshakeTimeout);
          handshakeTimeout = null;
          connected = true;
          reconnectAttempts = 0;
          connectedSince = Date.now();
          lastError = null;
          updateBadge('connected');
          broadcastStatus('Connected');
          vaultChannel.sendProtectionState();
          return;
        }
        if (!daemonAuthenticated) {
          refuseDaemon(socket, 'Daemon authentication is required before messages are accepted.');
          return;
        }
        if (msg.type === 'ping') {
          socket.send(JSON.stringify({ type: 'pong' }));
          return;
        }
        if (vaultChannel.handleMessage(msg)) return;
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

/**
 * Refuse the daemon on this socket: its reason becomes the status, and the
 * socket closes. The reconnect loop retries later, since a restarted daemon
 * may be 3.0.
 */
function refuseDaemon(socket, reason) {
  clearTimeout(handshakeTimeout);
  handshakeTimeout = null;
  connected = false;
  lastError = reason;
  updateBadge('error');
  broadcastStatus(reason);
  socket.close(1002, 'incompatible protocol');
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
 * Tabs for the popup's Open Tabs panel: every tab of the current window, then
 * any tab in ANOTHER window that is locked or agent-controlled (flagged
 * `otherWindow`) — an agent often works in a window the popup wasn't opened
 * from, and such a tab must not be invisible. Each tab carries its lock owner
 * (`lockedBy`) and the agent currently acting on it (`controlledBy`: session,
 * name, running/idle; no lock needed) so a driven tab is not shown as "free".
 * The agent-facing `browser_tabs list` (handleTabs) reports the same two facts
 * more compactly: bare session ids, controlledBy only for OTHER sessions.
 */
export async function getOpenTabs() {
  try {
    const [current, all] = await Promise.all([
      chrome.tabs.query({ currentWindow: true }),
      chrome.tabs.query({}),
    ]);
    const here = new Set(current.map((t) => t.id));
    const row = (t, otherWindow) => ({
      id: t.id,
      url: t.url,
      title: t.title,
      active: t.active,
      lockedBy: tabLocks.owner(t.id) || null,
      controlledBy: tabControl.controller(t.id) || null,
      ...(otherWindow ? { otherWindow: true } : {}),
    });
    const elsewhere = all
      .filter((t) => !here.has(t.id))
      .map((t) => row(t, true))
      .filter((r) => r.lockedBy || r.controlledBy);
    return [...current.map((t) => row(t, false)), ...elsewhere];
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
    portFromUser = true;
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
