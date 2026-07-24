const dot = document.getElementById('dot');
const statusEl = document.getElementById('status');
const detailEl = document.getElementById('detail');
const portInput = document.getElementById('port');
const tokenInput = document.getElementById('token');
const logEl = document.getElementById('log');
const versionEl = document.getElementById('version');
const locksEl = document.getElementById('locks');
const unlockAllBtn = document.getElementById('unlockAll');
const agentsEl = document.getElementById('agents');

const manifest = chrome.runtime.getManifest();
versionEl.textContent = `v${manifest.version}`;

// Daemon HTTP base (same port as the WebSocket). The popup talks to it to
// auto-pair the token (no fs access in MV3) and to show connected agents.
function daemonHttpBase() {
  return `http://127.0.0.1:${portInput.value || 7225}`;
}

/**
 * Auto-pair: fetch the daemon's token over localhost and hand it to the
 * background worker so the WS connection carries ?token=. Runs once on popup
 * open; safe to re-run. Silent if the daemon isn't up yet (it'll retry).
 */
async function autoPairToken() {
  try {
    const res = await fetch(`${daemonHttpBase()}/pair`, { cache: 'no-store' });
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
  try {
    const res = await fetch(`${daemonHttpBase()}/status`, { cache: 'no-store' });
    if (!res.ok) { renderAgents([]); return; }
    const data = await res.json();
    renderAgents(Array.isArray(data.agents) ? data.agents : []);
  } catch {
    renderAgents(null); // null = daemon down
  }
}

function renderAgents(agents) {
  if (agents === null) {
    agentsEl.innerHTML = '<div class="empty">daemon not reachable</div>';
    return;
  }
  if (agents.length === 0) {
    agentsEl.innerHTML = '<div class="empty">none</div>';
    return;
  }
  agentsEl.innerHTML = agents
    .map((a) => {
      const name = a.name || 'agent';
      const ago = a.connectedAt ? Math.round((Date.now() - a.connectedAt) / 1000) : 0;
      const dur = ago < 60 ? `${ago}s` : `${Math.round(ago / 60)}m`;
      return `<div class="row"><span class="tab">${escapeHtml(name)}</span><span class="who">${a.sessionId || ''} · ${dur}</span></div>`;
    })
    .join('');
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

  // Tab locks (task 3.3)
  const locks = Array.isArray(state.tabLocks) ? state.tabLocks : [];
  if (locks.length === 0) {
    locksEl.innerHTML = '<div class="empty">none</div>';
    unlockAllBtn.disabled = true;
  } else {
    locksEl.innerHTML = locks
      .map((l) => `<div class="row"><span class="tab">tab ${l.tabId}</span><span class="who">${l.sessionId}</span></div>`)
      .join('');
    unlockAllBtn.disabled = false;
  }
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

chrome.runtime.sendMessage({ type: 'getStatus' }, (response) => {
  if (response) {
    updateUI(response);
    addLog(`Status: ${response.connectionState || 'unknown'}`, response.connectionState === 'connected' ? 'ok' : '');
  }
});

// On open: auto-pair the token (so the WS carries ?token=) and start polling
// the daemon for connected agents. The poll stops when the popup closes.
autoPairToken();
refreshAgents();
let agentsTimer = setInterval(refreshAgents, 2000);
// popup unload: clear the poll so we don't leak timers across reopens
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') clearInterval(agentsTimer);
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

// Unlock All (task 3.3)
unlockAllBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'unlockAll' }, (resp) => {
    if (resp?.success) addLog('All tab locks released', 'warn');
  });
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
