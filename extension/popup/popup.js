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
const logEl = document.getElementById('log');
const versionEl = document.getElementById('version');
const locksEl = document.getElementById('locks');
const unlockAllBtn = document.getElementById('unlockAll');
const agentsEl = document.getElementById('agents');
const openTabsEl = document.getElementById('openTabs');

const manifest = chrome.runtime.getManifest();
versionEl.textContent = `v${manifest.version}`;

// Shared state: agents come from the daemon /status, tabs+locks come from the
// background getStatus. Each panel needs the other's data to render its
// controls (the Pin dropdown lists agents; the Disconnect rows know nothing
// about tabs). Keep the latest snapshot of both so a re-render of either panel
// has the full picture without waiting for the other poll to land.
let lastAgents = [];      // [{sessionId, name, connectedAt}]
let lastTabs = [];        // [{id, url, title, active, lockedBy}]

// Daemon HTTP base (same port as the WebSocket). The popup talks to it to
// auto-pair the token (no fs access in MV3) and to show connected agents.
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
 *
 * Requires the enrollment secret to be set first — without it /pair returns
 * 403 and there is nothing to pair. On a fresh install the user pastes the
 * secret (printed by `npx browser-controller`) once; thereafter it's recalled
 * from chrome.storage.local.
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

function setAgents(agents) {
  // null signals "daemon down" — keep an empty agent list (so the Pin dropdown
  // has nothing to list) but render the unreachable banner in the agents panel.
  lastAgentsDown = agents === null;
  lastAgents = Array.isArray(agents) ? agents : [];
  renderAgents();
  // tabs depend on agents (the Pin dropdown lists them) — re-render too.
  renderOpenTabs();
}

let lastAgentsDown = false;

function renderAgents() {
  if (lastAgentsDown) {
    agentsEl.innerHTML = '<div class="empty">daemon not reachable</div>';
    return;
  }
  const agents = lastAgents;
  if (agents.length === 0) {
    agentsEl.innerHTML = '<div class="empty">none</div>';
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
  } catch (err) {
    addLog(`Disconnect failed: daemon not reachable`, 'err');
  }
}

/** Render the Open Tabs panel with a Pin dropdown per tab. */
// Signature of the last-rendered tab set — skip the innerHTML rebuild when
// nothing material changed (avoids the 2s poll destroying an open <select> and
// resetting its value, which made the Pin dropdown close/snaps-back-to-free).
let lastTabsSignature = '';

function renderOpenTabs() {
  const tabs = lastTabs;
  if (!tabs || tabs.length === 0) {
    if (lastTabsSignature !== 'empty') {
      openTabsEl.innerHTML = '<div class="empty">none</div>';
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
  // The signature encodes tab ids, titles, lockedBy, and the agent list. Without
  // this, every 2s poll re-renders identical rows, flickering the dropdown.
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
            <span style="color:#667eea;font-size:10px;">🔒 ${escapeHtml(ownerName)}</span>
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
          <button class="icon-btn" data-action="lockTab" data-tab="${t.id}" title="Pin to selected agent" style="color:#667eea;">📌</button>
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

function updateUI(state) {
  if (!state) return;

  dot.className = `dot ${state.connectionState || 'disconnected'}`;

  const labels = {
    connected: 'Connected to daemon',
    reconnecting: 'Reconnecting...',
    disconnected: 'Disconnected',
    error: 'Connection error',
  };
  statusEl.textContent = state.activity
    ? `Active: ${state.activity}`
    : labels[state.connectionState] || 'Unknown';

  let detail = `ws://127.0.0.1:${state.port || '7225'}`;
  if (state.connectionState === 'reconnecting' && state.reconnectAttempts > 0) {
    detail += ` · attempt ${state.reconnectAttempts}`;
    if (state.nextRetryMs) detail += ` · retry in ${Math.round(state.nextRetryMs / 1000)}s`;
  }
  if (state.connectionState === 'connected' && state.connectedSince) {
    const ago = Math.round((Date.now() - state.connectedSince) / 1000);
    if (ago < 60) detail += ` · ${ago}s ago`;
    else detail += ` · ${Math.round(ago / 60)}m ago`;
  }
  detailEl.textContent = detail;

  if (state.port) portInput.value = state.port;

  // Tab locks (task 3.3) — kept as a flat list with Unlock All.
  const locks = Array.isArray(state.tabLocks) ? state.tabLocks : [];
  if (locks.length === 0) {
    locksEl.innerHTML = '<div class="empty">none</div>';
    unlockAllBtn.disabled = true;
  } else {
    locksEl.innerHTML = locks
      .map((l) => {
        const owner = agentLabelFor(l.sessionId);
        return `<div class="row"><span class="tab">tab ${l.tabId}</span><span class="who">${escapeHtml(owner)}</span></div>`;
      })
      .join('');
    unlockAllBtn.disabled = false;
  }

  // Open Tabs panel (driven by the background getStatus payload). Cache so a
  // later agents poll can re-render the Pin dropdowns with fresh agent names.
  lastTabs = Array.isArray(state.tabs) ? state.tabs : [];
  renderOpenTabs();
}

function addLog(text, level) {
  const entry = document.createElement('div');
  entry.className = `entry ${level || ''}`;
  const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  entry.textContent = `${time} ${text}`;
  logEl.appendChild(entry);
  logEl.scrollTop = logEl.scrollHeight;
  while (logEl.children.length > 50) logEl.removeChild(logEl.firstChild);
}

/** Fetch connection + tabs + locks state from the background worker. */
function refreshStatus() {
  chrome.runtime.sendMessage({ type: 'getStatus' }, (response) => {
    if (chrome.runtime.lastError || !response) return;
    updateUI(response);
  });
}

refreshStatus();

// On open: recall the enrollment secret from storage (required before any
// daemon HTTP call, since the daemon gates /pair, /status, /kill behind it).
// Until the user has entered it once, the popup shows the daemon as
// unreachable — the enrollment field is the first thing to set up.
chrome.storage.local.get(['enrollmentSecret'], (stored) => {
  if (typeof stored.enrollmentSecret === 'string') {
    enrollment = stored.enrollmentSecret;
    enrollmentInput.value = enrollment;
  }
  // Now that enrollment is restored (or known-empty), kick off pairing + polling.
  autoPairToken();
  refreshAgents();
});
let agentsTimer = setInterval(() => {
  // only poll the daemon if we can actually auth to it
  if (enrollment) refreshAgents();
}, 2000);
let statusTimer = setInterval(refreshStatus, 2000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    clearInterval(agentsTimer);
    clearInterval(statusTimer);
  }
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

// Port (debounced)
let debounce = null;
portInput.addEventListener('input', () => {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    chrome.runtime.sendMessage({ type: 'setPort', port: portInput.value }, (resp) => {
      if (resp?.success) {
        addLog(`Port changed to ${resp.port}`, 'warn');
        updateUI({ connectionState: 'reconnecting', port: resp.port, reconnectAttempts: 0 });
      }
    });
  }, 600);
});

// Token (task 3.1): the daemon generates token.json; the extension must present
// the same token on connect. Set it here once.
let tokenDebounce = null;
tokenInput.addEventListener('input', () => {
  clearTimeout(tokenDebounce);
  tokenDebounce = setTimeout(() => {
    chrome.runtime.sendMessage({ type: 'setToken', token: tokenInput.value }, (resp) => {
      if (resp?.success) addLog('Token updated, reconnecting', 'warn');
    });
  }, 600);
});

// Enrollment secret: persists to chrome.storage.local so it survives popup
// reopens. Changing it re-attempts /pair (the token is re-fetched under the
// new secret) — this is how the user recovers after pasting the wrong value
// or after rotating the daemon's enrollment.json.
let enrollmentDebounce = null;
enrollmentInput.addEventListener('input', () => {
  clearTimeout(enrollmentDebounce);
  enrollmentDebounce = setTimeout(() => {
    enrollment = enrollmentInput.value.trim();
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
  }, 400);
});

// Unlock All (task 3.3)
unlockAllBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'unlockAll' }, (resp) => {
    if (resp?.success) addLog('All tab locks released', 'warn');
  });
});

// Event delegation for the dynamic Open Tabs / Connected Agents panels.
// Rows are re-rendered on every poll (innerHTML), so attaching listeners to
// individual buttons would be lost — route all clicks through the document
// and dispatch on data-action.
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
        addLog(`Pinned tab ${tabId} to ${agentLabelFor(sessionId)}`, 'ok');
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

// --- Resizable popup -------------------------------------------------------
// Chrome extension popups are fixed-size; there's no native resize. We drive
// the document size from a draggable corner handle and persist the chosen
// width/height to chrome.storage.local so it's restored on every open.
const resizerEl = document.getElementById('resizer');
const MIN_W = 260;
const MIN_H = 220;
const MAX_W = 720;
const MAX_H = 720;
const SIZE_KEY = 'popupSize';

function applySize(w, h) {
  const cw = Math.min(MAX_W, Math.max(MIN_W, Math.round(w)));
  const ch = Math.min(MAX_H, Math.max(MIN_H, Math.round(h)));
  document.documentElement.style.width = `${cw}px`;
  document.documentElement.style.height = `${ch}px`;
  document.body.style.width = `${cw}px`;
  document.body.style.height = `${ch}px`;
  return { w: cw, h: ch };
}

// Restore last chosen size (fall back to the CSS default of 300x220-ish).
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
  startW = parseInt(cs.width, 10) || 300;
  startH = parseInt(cs.height, 10) || 220;
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
