// Browser Controller popup — fixed shell with three tabs (Tabs / Agents /
// Settings) and a collapsible activity bar. Only list panels scroll; the body
// never does. All background message types are preserved from the v1 column
// layout (getStatus / setPort / setToken / setEnrollment / lockTab / unlockTab
// / unlockAll + daemon /pair /status /kill).

const dot = document.getElementById('dot');
const statusEl = document.getElementById('status');
const detailEl = document.getElementById('detail');
const portInput = document.getElementById('port');
const tokenInput = document.getElementById('token');
const enrollmentInput = document.getElementById('enrollment');
// Enrollment secret the daemon gates /pair, /status, /kill behind. Loaded from
// chrome.storage.local so the popup remembers it across reopens (the user
// pastes it once on first setup — see SECURITY.md "First-contact TOFU window").
let enrollment = '';
const versionEl = document.getElementById('version');
const unlockAllBtn = document.getElementById('unlockAll');
const agentsEl = document.getElementById('agents');
const openTabsEl = document.getElementById('openTabs');
const tabsCountEl = document.getElementById('tabsCount');
const agentsCountEl = document.getElementById('agentsCount');
const settingsTabBtn = document.getElementById('settingsTab');

const manifest = chrome.runtime.getManifest();
versionEl.textContent = `v${manifest.version}`;

// Shared state: agents come from the daemon /status, tabs+locks come from the
// background getStatus. Each panel needs the other's data to render its
// controls (the Pin dropdown lists agents). Keep the latest snapshot of both.
let lastAgents = [];      // [{sessionId, name, connectedAt}]
let lastTabs = [];        // [{id, url, title, active, lockedBy}]

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

// ── Daemon HTTP (auto-pair, agents, disconnect) ────────────────────────────
// The popup talks to the daemon's HTTP endpoints (same port as the WS) to
// auto-pair the token (no fs access in MV3) and to list/kill agents.

function daemonHttpBase() {
  return `http://127.0.0.1:${portInput.value || 7225}`;
}

/**
 * Authenticated fetch wrapper: sends the enrollment secret in the
 * X-BC-Enrollment header on every daemon HTTP call. Without this, /pair
 * (and /status, /kill) return 403 — the daemon gates all HTTP behind the
 * secret to stop a co-installed hostile extension from obtaining the token
 * even if it wins the Origin-pin race. See SECURITY.md.
 */
async function daemonFetch(pathAndQuery) {
  return fetch(`${daemonHttpBase()}${pathAndQuery}`, {
    cache: 'no-store',
    headers: { 'X-BC-Enrollment': enrollment },
  });
}

/**
 * Auto-pair: fetch the daemon's token over localhost and hand it to the
 * background worker so the WS connection carries ?token=. Runs once on popup
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
  } catch {
    setAgents(null); // null = daemon down
  }
}

let lastAgentsDown = false;

function setAgents(agents) {
  // null signals "daemon down" — keep an empty agent list (so the Pin dropdown
  // has nothing to list) but render the unreachable state in the agents panel.
  lastAgentsDown = agents === null;
  lastAgents = Array.isArray(agents) ? agents : [];
  renderAgents();
  // tabs depend on agents (the Pin dropdown lists them) — re-render too.
  renderOpenTabs();
}

function renderAgents() {
  agentsCountEl.textContent = lastAgents.length ? String(lastAgents.length) : '';
  if (lastAgentsDown) {
    agentsEl.innerHTML = '<div class="empty warn">daemon not reachable</div>';
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
// Signature of the last-rendered tab set — skip the innerHTML rebuild when
// nothing material changed (avoids the 2s poll destroying an open <select> and
// resetting its value, which made the Pin dropdown close/snaps-back-to-free).
let lastTabsSignature = '';

function renderOpenTabs() {
  const tabs = lastTabs;
  tabsCountEl.textContent = tabs.length ? String(tabs.length) : '';
  if (!tabs || tabs.length === 0) {
    if (lastTabsSignature !== 'empty') {
      openTabsEl.innerHTML = '<div class="empty">no tabs</div>';
      lastTabsSignature = 'empty';
    }
    return;
  }
  // GUARD 1: if the user has a <select> open (mid-interaction), do NOT rebuild —
  // replacing innerHTML closes the dropdown and loses the in-progress selection.
  const openSelect = openTabsEl.querySelector('select[data-action="pickAgent"]');
  if (openSelect && openSelect === document.activeElement) {
    return; // user is interacting with a dropdown; leave the DOM alone
  }
  // GUARD 2: only rebuild if the tab set + lock state + agent roster changed.
  const agents = (lastAgents || []).filter(Boolean);
  const sig = JSON.stringify({
    tabs: tabs.map(t => ({ id: t.id, title: t.title, lockedBy: t.lockedBy })),
    agents: agents.map(a => a.sessionId),
  });
  if (sig === lastTabsSignature) return; // nothing changed — keep the DOM stable
  lastTabsSignature = sig;

  openTabsEl.innerHTML = tabs
    .map((t) => {
      const title = escapeHtml(t.title || t.url || `tab ${t.id}`);
      const cls = t.active ? 'tab-title active' : 'tab-title';
      const lockedBy = t.lockedBy;
      if (lockedBy) {
        // Locked: show owner + an unpin (✕) button. No dropdown.
        const ownerName = agentLabelFor(lockedBy);
        return `<div class="tab-row" data-tab="${t.id}">
          <span class="${cls}" title="${escapeHtml(t.url || '')}">${title}</span>
          <span class="tab-pin">
            <span class="lock-owner">🔒 ${escapeHtml(ownerName)}</span>
            <button class="icon-btn unpin" data-action="unlockTab" data-tab="${t.id}" title="Unpin this tab">✕</button>
          </span>
        </div>`;
      }
      // Unlocked: the unique session id is the lock identity. Display names
      // are not unique when multiple clients run from the same IDE.
      const opts = ['<option value="">— free —</option>']
        .concat(agents.map((a) => {
          const name = a.name || 'agent';
          const label = escapeHtml(`${name} · ${a.sessionId}`);
          const val = escapeHtml(a.sessionId);
          return `<option value="${val}">${label}</option>`;
        }))
        .join('');
      return `<div class="tab-row" data-tab="${t.id}">
        <span class="${cls}" title="${escapeHtml(t.url || '')}">${title}</span>
        <span class="tab-pin">
          <select data-action="pickAgent" data-tab="${t.id}">${opts}</select>
          <button class="icon-btn" data-action="lockTab" data-tab="${t.id}" title="Pin to selected agent">📌</button>
        </span>
      </div>`;
    })
    .join('');
}

/** Human label for a sessionId, falling back to the bare id. */
function agentLabelFor(sessionId) {
  const a = (lastAgents || []).find((x) => x.sessionId === sessionId);
  return a ? `${a.name || 'agent'} · ${sessionId}` : sessionId;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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

  // Locks drive the Unlock-all button (per-row owners render inside the tabs
  // list — the standalone locks panel is gone; same data, no duplicate).
  const locks = Array.isArray(state.tabLocks) ? state.tabLocks : [];
  unlockAllBtn.disabled = locks.length === 0;
  unlockAllBtn.textContent = locks.length ? `Unlock all (${locks.length})` : 'Unlock all';

  // Open Tabs panel (driven by the background getStatus payload). Cache so a
  // later agents poll can re-render the Pin dropdowns with fresh agent names.
  lastTabs = Array.isArray(state.tabs) ? state.tabs : [];
  renderOpenTabs();
}

/** Fetch connection + tabs + locks state from the background worker. */
function refreshStatus() {
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

// On open: recall the enrollment secret from storage (required before any
// daemon HTTP call, since the daemon gates /pair, /status, /kill behind it).
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

function bindDebouncedInput(el, ms, onChange) {
  let timer = null;
  el.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(onChange, ms);
  });
}

bindDebouncedInput(portInput, 600, () => {
  chrome.runtime.sendMessage({ type: 'setPort', port: portInput.value }, (resp) => {
    if (resp?.success) {
      addLog(`Port changed to ${resp.port}`, 'warn');
      updateUI({ connectionState: 'reconnecting', port: resp.port, reconnectAttempts: 0 });
    }
  });
});

// Token: the daemon generates token.json; the extension must present the same
// token on connect. Auto-paired normally; paste only to override.
bindDebouncedInput(tokenInput, 600, () => {
  chrome.runtime.sendMessage({ type: 'setToken', token: tokenInput.value }, (resp) => {
    if (resp?.success) addLog('Token updated, reconnecting', 'warn');
  });
});

// Enrollment secret: persists to chrome.storage.local so it survives popup
// reopens. Changing it re-attempts /pair under the new secret — this is how
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
        addLog(`Pinned tab ${tabId} to ${agentLabelFor(sessionId)}${resp.shielded === false ? ' (shield failed — protected page)' : ''}`, resp.shielded === false ? 'warn' : 'ok');
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

// ── Resizable popup ────────────────────────────────────────────────────────
// Chrome extension popups are fixed-size; there's no native resize. We drive
// the document size from a draggable corner handle and persist the chosen
// width/height to chrome.storage.local so it's restored on every open.
const resizerEl = document.getElementById('resizer');
const MIN_W = 320;
const MIN_H = 380;
const MAX_W = 760;
const MAX_H = 760;
const SIZE_KEY = 'popupSize';

function applySize(w, h) {
  const cw = Math.min(MAX_W, Math.max(MIN_W, Math.round(w)));
  const ch = Math.min(MAX_H, Math.max(MIN_H, Math.round(h)));
  document.documentElement.style.width = `${cw}px`;
  document.documentElement.style.height = `${ch}px`;
  return { w: cw, h: ch };
}

// Restore last chosen size (fall back to the CSS default of 380x540).
chrome.storage.local.get(SIZE_KEY, (saved) => {
  if (saved && saved[SIZE_KEY]) {
    applySize(saved[SIZE_KEY].w, saved[SIZE_KEY].h);
  }
});

let dragging = false;
// Anchor deltas in SCREEN coordinates. clientX/clientY are relative to the
// popup viewport, and Chrome slides the whole viewport as the popup resizes
// (it keeps the right edge pinned to the toolbar icon). Reading clientX during
// a resize therefore feeds back into the width math and produces visible jitter
// (grow → slide → clientX jumps → shrink → slide back → repeat). screenX is
// anchored to the physical monitor and never moves, so it's jitter-free.
let startScreenX = 0;
let startScreenY = 0;
let startW = 0;
let startH = 0;
let saveTimer = null;
// Coalesce multiple mousemove events into one layout write per animation frame.
let pendingTargetW = 0;
let pendingTargetH = 0;
let rafHandle = 0;

function flushResize() {
  rafHandle = 0;
  applySize(pendingTargetW, pendingTargetH);
}

resizerEl.addEventListener('mousedown', (e) => {
  dragging = true;
  startScreenX = e.screenX;
  startScreenY = e.screenY;
  const cs = getComputedStyle(document.documentElement);
  startW = parseInt(cs.width, ) || 380;
  startH = parseInt(cs.height, ) || 540;
  pendingTargetW = startW;
  pendingTargetH = startH;
  e.preventDefault();
});

document.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  // The grip is at bottom-LEFT and Chrome anchors the popup to the top-right.
  // Fixed edges are top + right. With the cursor in screen space:
  //   - down  → height grows  (startH + Δy)
  //   - right → width SHRINKS (startW - Δx) — cursor approaches the fixed right edge
  //   - left  → width grows                    — cursor pulls the left edge out
  pendingTargetW = startW - (e.screenX - startScreenX);
  pendingTargetH = startH + (e.screenY - startScreenY);
  // One write per frame: collapsing a burst of mousemove events avoids layout
  // thrash and keeps the resize smooth under fast cursor movement.
  if (!rafHandle) {
    rafHandle = requestAnimationFrame(flushResize);
  }
});

function endDrag() {
  if (!dragging) return;
  dragging = false;
  // Apply the very last mousemove target synchronously so the persisted size
  // matches what the user actually sees, even if a scheduled raf hadn't fired.
  const final = applySize(pendingTargetW, pendingTargetH);
  if (rafHandle) {
    // cancel the now-redundant frame so it doesn't overwrite the final size
    cancelAnimationFrame(rafHandle);
    rafHandle = 0;
  }
  // debounce storage write in case the browser fires several mouseups
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    chrome.storage.local.set({ [SIZE_KEY]: { w: final.w, h: final.h } });
  }, 150);
}
document.addEventListener('mouseup', endDrag);
document.addEventListener('mouseleave', endDrag);
