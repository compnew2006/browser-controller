// Browser Controller popup — fixed shell with three tabs (Tabs / Agents /
// Settings) and a collapsible activity bar. Only list panels scroll; the body
// never does. All background message types are preserved from the v1 column
// layout (getStatus / setPort / setToken / setEnrollment / lockTab / unlockTab
// / unlockAll + daemon /pair /status /kill).
import { escapeHtml, agentLabelFor, controlBadgeParts, openTabsSignature, renderOpenTabRows } from './open-tabs-view.js';
import { bindVaultOpenButton } from './popup-vault.js';
import { bindProfileLabel, updateProfileLabel } from './profile-label.js';
import { bindBooleanSetting, bindDebouncedInput } from './settings-input.js';
import { AGENT_MOUSE_MOVEMENT_LOCK_KEY } from '../lib/overlay.js';
import { authenticatedDaemonFetch, daemonFailureKind } from '../lib/daemon-auth.js';
import { bindActionActivity } from './activity-view.js';
import { bindTaskQuestions } from './question-view.js'; // Design §5: the question card, outside the shielded tab
import { bindPopupResizer } from './popup-resize.js'; // Task 9: resize grip, split out so popup.js stays under the 600-line gate
import { renderEvidenceRows, renderTaskRows, taskPanelsSignature, tasksFromQuestions } from './task-panels-view.js'; // Task 9: Tasks/Evidence panels

const dot = document.getElementById('dot');
const statusEl = document.getElementById('status');
const detailEl = document.getElementById('detail');
const portInput = document.getElementById('port');
const tokenInput = document.getElementById('token');
const enrollmentInput = document.getElementById('enrollment');
// Enrollment secret the daemon gates /pair, /status, /kill behind. Loaded from
// chrome.storage.local so the popup remembers it across reopens (the user
// pastes it once, or the background fills it from the native pairing host —
// see SECURITY.md "First-contact TOFU window").
let enrollment = '';
const versionEl = document.getElementById('version');
const unlockAllBtn = document.getElementById('unlockAll');
const agentsEl = document.getElementById('agents');
const openTabsEl = document.getElementById('openTabs');
const tabsCountEl = document.getElementById('tabsCount');
const agentsCountEl = document.getElementById('agentsCount');
const tasksCountEl = document.getElementById('tasksCount');
const taskListEl = document.getElementById('taskList');
const evidenceListEl = document.getElementById('evidenceList');
const settingsTabBtn = document.getElementById('settingsTab');
const actionActivity = bindActionActivity();
const taskQuestions = bindTaskQuestions((questionId, answer) => {
  chrome.runtime.sendMessage({ type: 'answerTaskQuestion', questionId, answer }, (resp) => {
    if (resp?.success) {
      // Evidence (Design §7): the answer joins the confirmed list with its
      // task, so the Evidence panel keeps it after the question leaves pending.
      const asked = lastTaskQuestions.find((q) => q.id === questionId);
      confirmedAnswers.push({ taskId: asked?.taskId || '', questionId, answer });
      addLog('Answer confirmed by daemon', 'ok'); refreshStatus();
    } else addLog(`Answer failed: ${resp?.error || 'unknown'}`, 'err');
  });
});

const manifest = chrome.runtime.getManifest();
versionEl.textContent = `v${manifest.version}`;

// Shared state: agents come from the daemon /status, tabs+locks come from the
// background getStatus. Each panel needs the other's data to render its
// controls (the Pin dropdown lists agents). Keep the latest snapshot of both.
let lastAgents = [];      // [{sessionId, name, connectedAt}]
let lastTabs = [];        // [{id, url, title, active, lockedBy, controlledBy, otherWindow?}]
// Task panels (Design §7): the popup sees tasks only while they wait on a
// question (state.taskQuestions); confirmed answers are recorded here, in
// this popup session only, for the Evidence panel — see task-panels-view.js.
let lastTaskQuestions = [];
const confirmedAnswers = [];
let lastTaskPanelsSig = '';

// ── Tabs shell ─────────────────────────────────────────────────────────────
const tabButtons = Array.from(document.querySelectorAll('.tabbar button[data-tab]'));
const panels = {};
for (const p of document.querySelectorAll('[data-panel]')) panels[p.dataset.panel] = p;

function switchTab(name, persist = true) {
  for (const b of tabButtons) {
    const on = b.dataset.tab === name;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
    b.tabIndex = on ? 0 : -1;
  }
  for (const [k, p] of Object.entries(panels)) p.hidden = k !== name;
  if (persist) chrome.storage.local.set({ popupTab: name });
  if (name === 'activity') actionActivity.refresh();
}
tabButtons.forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
// Roving-tabindex arrow-key navigation (tablist pattern).
document.querySelector('.tabbar').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  const idx = tabButtons.indexOf(document.activeElement);
  if (idx === -1) return;
  const next = tabButtons[(idx + (e.key === 'ArrowRight' ? 1 : tabButtons.length - 1)) % tabButtons.length];
  next.focus();
  switchTab(next.dataset.tab);
});
// Restore the last-used tab (daily use: reopen where you left off).
chrome.storage.local.get('popupTab', (s) => {
  if (s.popupTab && panels[s.popupTab]) switchTab(s.popupTab, false);
});

/** First-run hint: the Settings tab glows amber until enrollment is set. */
function setNeedsSetup() {
  settingsTabBtn.classList.toggle('needs-setup', !enrollment);
}

// ── Activity bar ───────────────────────────────────────────────────────────
const logbar = document.getElementById('logbar');
const logToggle = document.getElementById('logToggle');
const logPanel = document.getElementById('logPanel');
const logEntries = document.getElementById('logEntries');
const logBarText = document.getElementById('logBarText');

logToggle.addEventListener('click', () => {
  const open = logPanel.hidden;
  logPanel.hidden = !open;
  logbar.classList.toggle('open', open);
  logToggle.setAttribute('aria-expanded', String(open));
  if (open) logPanel.scrollTop = 0;
});
document.getElementById('logClear').addEventListener('click', () => {
  logEntries.textContent = '';
});

function addLog(text, level) {
  const entry = document.createElement('div');
  entry.className = `entry ${level || ''}`;
  const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  entry.textContent = `${time} ${text}`;
  logEntries.appendChild(entry);
  logPanel.scrollTop = logPanel.scrollHeight;
  while (logEntries.children.length > 50) logEntries.removeChild(logEntries.firstChild);
  // Collapsed bar mirrors the latest entry (level-colored).
  logBarText.textContent = text;
  logBarText.className = `logbar-text ${level || ''}`;
}
bindVaultOpenButton(addLog);

// ── Daemon HTTP (auto-pair, agents, disconnect) ────────────────────────────
// The popup talks to the daemon's HTTP endpoints (same port as the WS) to
// auto-pair the token (no fs access in MV3) and to list/kill agents.

function daemonHttpBase() {
  return `http://127.0.0.1:${portInput.value || 7225}`;
}

async function daemonFetch(pathAndQuery) {
  return authenticatedDaemonFetch({
    baseUrl: daemonHttpBase(),
    target: pathAndQuery,
    enrollmentSecret: enrollment,
  });
}

/**
 * Auto-pair: fetch the daemon's token over localhost and hand it to the
 * background worker, which proves it in the WS handshake. Runs once on popup
 * open; safe to re-run. Silent if the daemon isn't up yet (it'll retry).
 * Requires the enrollment secret — without it /pair returns 403.
 */
async function autoPairToken() {
  if (!enrollment) return; // can't pair without the enrollment secret
  try {
    const res = await daemonFetch('/pair');
    if (!res.ok) return;
    const data = await res.json();
    if (data && data.token && data.token !== tokenInput.value) {
      tokenInput.value = data.token;
      chrome.runtime.sendMessage({ type: 'setToken', token: data.token });
    }
  } catch {
    // daemon not reachable yet — the user will see "Disconnected"; no spam.
  }
}

/** Poll the daemon for connected agents and render them. */
async function refreshAgents() {
  if (!enrollment) { setAgents([]); return; } // daemon will 403 anyway
  try {
    const res = await daemonFetch('/status');
    if (!res.ok) { setAgents([]); return; }
    const data = await res.json();
    setAgents(Array.isArray(data.agents) ? data.agents : []);
  } catch (error) {
    setAgents(null, daemonFailureKind(error)); // null = daemon unreachable or refused us
  }
}

let lastAgentsDown = false;
let lastAgentsFailure = 'unreachable';

function setAgents(agents, failure = 'unreachable') {
  // null signals "daemon down" — keep an empty agent list (so the Pin dropdown
  // has nothing to list) but render the unreachable state in the agents panel.
  lastAgentsDown = agents === null;
  lastAgentsFailure = failure;
  lastAgents = Array.isArray(agents) ? agents : [];
  renderAgents();
  // tabs depend on agents (the Pin dropdown lists them) — re-render too.
  renderOpenTabs();
}

function renderAgents() {
  agentsCountEl.textContent = lastAgents.length ? String(lastAgents.length) : '';
  if (lastAgentsDown) {
    // A refused secret is a pairing problem, not a dead daemon: tell the user which.
    agentsEl.innerHTML = lastAgentsFailure === 'auth'
      ? '<div class="empty warn">daemon rejected the enrollment secret; check it in Settings</div>'
      : '<div class="empty warn">daemon not reachable</div>';
    return;
  }
  const agents = lastAgents;
  if (agents.length === 0) {
    agentsEl.innerHTML = '<div class="empty">no agents connected</div>';
    return;
  }
  agentsEl.innerHTML = agents
    .map((a) => {
      const name = escapeHtml(a.name || 'agent');
      const sid = escapeHtml(a.sessionId || '');
      const ago = a.connectedAt ? Math.round((Date.now() - a.connectedAt) / 1000) : 0;
      const dur = ago < 60 ? `${ago}s` : `${Math.round(ago / 60)}m`;
      // data-sid carries the session id to the click handler (delegation).
      return `<div class="agent-row">
        <span class="tab">${name}</span>
        <span class="who">${sid} · ${dur}</span>
        <button class="icon-btn" data-action="disconnect" data-sid="${sid}" title="Disconnect this agent">✕</button>
      </div>`;
    })
    .join('');
}

/**
 * Kick a connected agent off the daemon immediately (don't wait ~45s for the
 * heartbeat to evict it). Calls the daemon's GET /kill?sessionId=… endpoint.
 */
async function disconnectAgent(sessionId) {
  try {
    const res = await daemonFetch(`/kill?sessionId=${encodeURIComponent(sessionId)}`);
    const data = await res.json();
    if (data && data.ok) {
      addLog(`Disconnected ${sessionId}`, 'warn');
      refreshAgents(); // immediately reflect the eviction
    } else {
      addLog(`Disconnect failed: ${data?.error || 'unknown'}`, 'err');
    }
  } catch {
    addLog(`Disconnect failed: daemon not reachable`, 'err');
  }
}

// ── Open Tabs panel ────────────────────────────────────────────────────────
// Row HTML comes from open-tabs-view.js (pure, unit-tested). This side owns the
// DOM: rebuild only on a structural change, patch the control badges in place
// otherwise, and carry the user's pending Pin choice + keyboard focus across a
// rebuild (the 2s poll used to destroy an open <select> and snap it back).
let lastTabsSignature = '';
/** Pin choices made in a row's dropdown but not applied yet: tabId → sessionId ('' = none). */
const pendingPicks = new Map();

openTabsEl.addEventListener('change', (e) => {
  const select = e.target.closest('select[data-action="pickAgent"]');
  if (select) pendingPicks.set(Number(select.dataset.tab), select.value);
});

function renderOpenTabs() {
  const tabs = lastTabs;
  tabsCountEl.textContent = tabs.length ? String(tabs.length) : '';
  if (!tabs || tabs.length === 0) {
    pendingPicks.clear();
    if (lastTabsSignature !== 'empty') {
      openTabsEl.innerHTML = '<div class="empty">no tabs</div>';
      lastTabsSignature = 'empty';
    }
    return;
  }
  // A pending choice is moot once its tab is gone or got locked.
  for (const id of pendingPicks.keys()) {
    const t = tabs.find((x) => x.id === id);
    if (!t || t.lockedBy) pendingPicks.delete(id);
  }
  const sig = openTabsSignature(tabs, lastAgents);
  // GUARD 1: the user has a row's <select> focused (mid-interaction) — a rebuild
  // would close the dropdown. GUARD 2: nothing structural changed. Either way
  // keep the DOM and only refresh the running/idle badges.
  const focused = document.activeElement;
  const interacting = focused?.matches?.('select[data-action="pickAgent"]') && openTabsEl.contains(focused);
  if (interacting || sig === lastTabsSignature) {
    patchControlBadges(tabs);
    return;
  }
  lastTabsSignature = sig;
  // Keep keyboard focus on the same control (e.g. a 📌 reached with Tab).
  const focusKey = focused && openTabsEl.contains(focused) && focused.dataset.action
    ? `[data-action="${focused.dataset.action}"][data-tab="${focused.dataset.tab}"]`
    : null;
  openTabsEl.innerHTML = renderOpenTabRows(tabs, lastAgents, pendingPicks);
  if (focusKey) openTabsEl.querySelector(focusKey)?.focus();
}

/** Refresh each control badge's running/idle state without touching the row. */
function patchControlBadges(tabs) {
  for (const t of tabs) {
    if (!t.controlledBy || t.lockedBy) continue;
    const el = openTabsEl.querySelector(`.ctrl-owner[data-ctrl-tab="${t.id}"]`);
    if (!el) continue;
    const b = controlBadgeParts(t.controlledBy, lastAgents);
    el.classList.toggle('idle', b.idle);
    el.textContent = b.text;
    el.title = b.title;
  }
}

// ── Tasks / Evidence panels ──────────────────────────────────────────────
// Rendered from the status payload's pending questions plus the answers
// confirmed in this popup session; signature-guarded like the tabs list so
// the 2s poll does not rebuild the DOM when nothing changed.
function renderTaskPanels(questions) {
  const list = Array.isArray(questions) ? questions : [];
  const waiting = tasksFromQuestions(list);
  tasksCountEl.textContent = waiting.length ? String(waiting.length) : '';
  const sig = taskPanelsSignature(list, confirmedAnswers);
  if (sig === lastTaskPanelsSig) return;
  lastTaskPanelsSig = sig;
  const taskRows = renderTaskRows(list);
  taskListEl.innerHTML = taskRows || '<div class="empty">No active task</div>';
  const evidenceRows = renderEvidenceRows(list, confirmedAnswers);
  evidenceListEl.innerHTML = evidenceRows || '<div class="empty">Nothing confirmed yet</div>';
}

// ── Status rendering ───────────────────────────────────────────────────────

function updateUI(state) {
  if (!state) return;

  dot.className = `dot ${state.connectionState || 'disconnected'}`;

  const labels = {
    connected: 'Connected',
    reconnecting: 'Reconnecting…',
    disconnected: 'Disconnected',
    error: 'Connection error',
  };
  statusEl.textContent = state.activity
    ? `Active: ${state.activity.replace('browser_', '')}`
    : labels[state.connectionState] || 'Unknown';

  let detail = `ws://127.0.0.1:${state.port || '7225'}`;
  if (state.connectionState === 'reconnecting' && state.reconnectAttempts > 0) {
    detail += ` · attempt ${state.reconnectAttempts}`;
    if (state.nextRetryMs) detail += ` · retry in ${Math.round(state.nextRetryMs / 1000)}s`;
  }
  if (state.connectionState === 'connected' && state.connectedSince) {
    const ago = Math.round((Date.now() - state.connectedSince) / 1000);
    if (ago < 60) detail += ` · up ${ago}s`;
    else detail += ` · up ${Math.round(ago / 60)}m`;
  }
  detailEl.textContent = detail;

  if (state.port) portInput.value = state.port;
  updateProfileLabel(state);

  // Locks drive the Unlock-all button (per-row owners render inside the tabs
  // list — the standalone locks panel is gone; same data, no duplicate).
  const locks = Array.isArray(state.tabLocks) ? state.tabLocks : [];
  unlockAllBtn.disabled = locks.length === 0;
  unlockAllBtn.textContent = locks.length ? `Unlock all (${locks.length})` : 'Unlock all';

  // Open Tabs panel (driven by the background getStatus payload). Cache so a
  // later agents poll can re-render the Pin dropdowns with fresh agent names.
  lastTabs = Array.isArray(state.tabs) ? state.tabs : [];
  renderOpenTabs(); taskQuestions.render(state.taskQuestions);
  lastTaskQuestions = Array.isArray(state.taskQuestions) ? state.taskQuestions : [];
  renderTaskPanels(lastTaskQuestions);
}

/** Fetch connection + tabs + locks state from the background worker. */
function refreshStatus() {
  actionActivity.refresh();
  chrome.runtime.sendMessage({ type: 'getStatus' }, (response) => {
    if (chrome.runtime.lastError || !response) return;
    updateUI(response);
  });
}

// ── Polling lifecycle ──────────────────────────────────────────────────────
// PAUSE while the popup is hidden and RESUME when visible again. The v1 code
// cleared both intervals on hide but never restarted them — a hidden→visible
// cycle left the popup permanently stale (audit finding).
let agentsTimer = null;
let statusTimer = null;

function startPolling() {
  if (!agentsTimer) {
    agentsTimer = setInterval(() => {
      // only poll the daemon if we can actually auth to it
      if (enrollment) refreshAgents();
    }, 2000);
  }
  if (!statusTimer) statusTimer = setInterval(refreshStatus, 2000);
}

function stopPolling() {
  clearInterval(agentsTimer);
  clearInterval(statusTimer);
  agentsTimer = null;
  statusTimer = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    stopPolling();
  } else {
    startPolling();
    refreshStatus();
    if (enrollment) refreshAgents();
  }
});

refreshStatus();
startPolling();

// On open: recall the enrollment secret from storage before authenticating
// popup requests to the local daemon.
chrome.storage.local.get(['enrollmentSecret'], (stored) => {
  if (typeof stored.enrollmentSecret === 'string') {
    enrollment = stored.enrollmentSecret;
    enrollmentInput.value = enrollment;
  }
  setNeedsSetup();
  // Now that enrollment is restored (or known-empty), kick off pairing + polling.
  autoPairToken();
  refreshAgents();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'status') {
    updateUI(msg);
    const level = msg.connectionState === 'connected' ? 'ok'
      : msg.connectionState === 'error' ? 'err'
      : msg.connectionState === 'reconnecting' ? 'warn' : '';
    addLog(msg.statusMessage || msg.connectionState, level);
  }
});

// ── Settings inputs (shared debounced wiring — was 3 copy-pasted blocks) ───

bindDebouncedInput(portInput, 600, () => {
  chrome.runtime.sendMessage({ type: 'setPort', port: portInput.value }, (resp) => {
    if (resp?.success) {
      addLog(`Port changed to ${resp.port}`, 'warn');
      updateUI({ connectionState: 'reconnecting', port: resp.port, reconnectAttempts: 0 });
    }
  });
});

bindProfileLabel(addLog, refreshStatus);

// Token: the daemon generates token.json; the extension must present the same
// token on connect. Auto-paired normally; paste only to override.
bindDebouncedInput(tokenInput, 600, () => {
  chrome.runtime.sendMessage({ type: 'setToken', token: tokenInput.value }, (resp) => {
    if (resp?.success) addLog('Token updated, reconnecting', 'warn');
  });
});

// Enrollment secret: persists to chrome.storage.local so it survives popup
// reopens. Changing it re-attempts authenticated /pair — this is how
// the user recovers after pasting the wrong value or after rotating the
// daemon's enrollment.json.
bindDebouncedInput(enrollmentInput, 400, () => {
  enrollment = enrollmentInput.value.trim();
  setNeedsSetup();
  // Persist under the same key the background reads ('enrollmentSecret') so
  // its service-worker-recycle reload stays in sync, AND notify the background
  // via setEnrollment so it re-pairs /pair under the new secret and reconnects
  // the WS (the popup's own autoPairToken only refreshes the token field —
  // the background owns the WS lifecycle).
  chrome.storage.local.set({ enrollmentSecret: enrollment }, () => {
    addLog(enrollment ? 'Enrollment updated, pairing…' : 'Enrollment cleared', 'warn');
    chrome.runtime.sendMessage({ type: 'setEnrollment', enrollment }, (resp) => {
      // background re-paired + reconnected; refresh the popup's token view too.
      if (resp?.success && enrollment) autoPairToken();
    });
  });
});

// Agent cursor (opt-in, off by default): the background reads this key before
// every mouse action, so flipping the switch applies to the next action.
bindBooleanSetting(document.getElementById('agentCursor'), 'agentCursor', (enabled) => addLog(enabled ? 'Agent cursor on' : 'Agent cursor off'));
bindBooleanSetting(document.getElementById('agentMouseMovementLock'), AGENT_MOUSE_MOVEMENT_LOCK_KEY, (enabled) => addLog(enabled ? 'Mouse movement lock on' : 'Mouse movement lock off'));

// ── Row actions (event delegation over the re-rendered lists) ──────────────

unlockAllBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'unlockAll' }, (resp) => {
    if (resp?.success) addLog('All tab locks released', 'warn');
  });
});

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;

  if (action === 'disconnect') {
    const sid = btn.dataset.sid;
    if (sid) disconnectAgent(sid);
    return;
  }

  if (action === 'lockTab') {
    const tabId = Number(btn.dataset.tab);
    // Find this tab row's selected unique session.
    const row = btn.closest('.tab-row');
    const select = row && row.querySelector('select[data-action="pickAgent"]');
    const sessionId = select ? select.value : '';
    if (!sessionId) {
      addLog('Pick an agent first', 'warn');
      return;
    }
    chrome.runtime.sendMessage({ type: 'lockTab', tabId, sessionId }, (resp) => {
      if (resp?.success) {
        addLog(`Pinned tab ${tabId} to ${agentLabelFor(lastAgents, sessionId)}`, 'ok');
        refreshStatus();
      } else {
        addLog(`Pin failed: ${resp?.error || 'unknown'}`, 'err');
      }
    });
    return;
  }

  if (action === 'unlockTab') {
    const tabId = Number(btn.dataset.tab);
    chrome.runtime.sendMessage({ type: 'unlockTab', tabId }, (resp) => {
      if (resp?.success) {
        addLog(`Unpinned tab ${tabId}`, 'warn');
        refreshStatus();
      } else {
        addLog(`Unpin failed: ${resp?.error || 'unknown'}`, 'err');
      }
    });
    return;
  }
});

bindPopupResizer();
