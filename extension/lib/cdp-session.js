/**
 * Shared chrome.debugger session per tab.
 *
 * Trusted input (clicks/keys the page sees as isTrusted:true), background-tab
 * screenshots and REPL evaluate all go through CDP. Attaching per call costs a
 * round-trip and flashes the "is being debugged" banner on every action, and two
 * handlers attaching the same tab at once fail with "Another debugger is already
 * attached". So one session is kept per tab and detached after IDLE_MS without use.
 *
 * Every session also enables focus emulation: the page believes it has focus
 * even while its window is in the background, so focus/blur/focusin/focusout
 * fire as they would for a real user (legacy grids and lookups depend on them).
 */

export const IDLE_MS = 30_000;
/** A CDP command on a frozen renderer never answers: bound the setup probes. */
const SETUP_MS = 5_000;

function bounded(promise, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`CDP ${what} timed out (page not responding)`)), SETUP_MS); }),
  ]).finally(() => clearTimeout(timer));
}

/** tabId -> { ready: Promise<void>, timer } */
const sessions = new Map();

function armIdle(tabId) {
  const s = sessions.get(tabId);
  if (!s) return;
  clearTimeout(s.timer);
  if (s.busy > 0) return; // a long withCdp() call is still using the session
  s.timer = setTimeout(() => { detachCdp(tabId); }, IDLE_MS);
}

async function attach(tabId) {
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, '1.3');
  } catch (err) {
    // A service-worker restart forgets the map but Chrome may keep our
    // attachment: probe it and reuse instead of failing.
    if (!/already attached/i.test(String(err?.message || err))) throw err;
    await bounded(chrome.debugger.sendCommand(target, 'Runtime.evaluate', { expression: '1' }), 'attach probe');
  }
  await bounded(chrome.debugger.sendCommand(target, 'Emulation.setFocusEmulationEnabled', { enabled: true }), 'focus emulation').catch(() => {});
  // Can fail while the page is still loading; locateTarget retries it.
  await ensureViewport(tabId).catch(() => {});
}

/**
 * A tab opened in the background and never shown has a 0x0 viewport: nothing
 * is laid out, so every element sits at negative coordinates and mouse input
 * or screenshots hit nothing. Give it its window's size for the session
 * (emulation overrides are dropped automatically on detach).
 */
export async function ensureViewport(tabId) {
  const target = { tabId };
  const { result } = await bounded(chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
    expression: 'innerWidth * innerHeight', returnByValue: true,
  }), 'viewport probe');
  if (result?.value > 0) return;
  const tab = await chrome.tabs.get(tabId);
  const win = await chrome.windows.get(tab.windowId);
  await chrome.debugger.sendCommand(target, 'Emulation.setDeviceMetricsOverride', {
    width: Math.max(800, (win.width || 1280) - 16),
    height: Math.max(600, (win.height || 900) - 140), // minus tab strip + toolbar
    deviceScaleFactor: 0,
    mobile: false,
  });
}

/** Attach (or reuse) the tab's session and return a `send(method, params)` helper. */
export async function ensureCdp(tabId) {
  let s = sessions.get(tabId);
  if (!s) {
    s = { ready: attach(tabId), timer: null, busy: 0 };
    sessions.set(tabId, s);
    try {
      await s.ready;
    } catch (err) {
      sessions.delete(tabId);
      throw err;
    }
  } else {
    await s.ready;
  }
  armIdle(tabId);
  return (method, params = {}) => chrome.debugger.sendCommand({ tabId }, method, params);
}

/** Run fn(send) with the tab's session; no idle detach while fn runs. */
export async function withCdp(tabId, fn) {
  const send = await ensureCdp(tabId);
  const s = sessions.get(tabId);
  if (s) { s.busy++; clearTimeout(s.timer); }
  try {
    return await fn(send);
  } finally {
    if (s) s.busy--;
    armIdle(tabId);
  }
}

export async function detachCdp(tabId) {
  const s = sessions.get(tabId);
  if (!s) return;
  clearTimeout(s.timer);
  sessions.delete(tabId);
  try { await chrome.debugger.detach({ tabId }); } catch { /* already gone */ }
}

export function hasCdp(tabId) {
  return sessions.has(tabId);
}

// The user can dismiss the debugger banner, or the tab can close/navigate to a
// protected page: forget the session so the next call re-attaches cleanly.
if (typeof chrome !== 'undefined' && chrome.debugger?.onDetach) {
  chrome.debugger.onDetach.addListener((source) => {
    const s = sessions.get(source.tabId);
    if (s) { clearTimeout(s.timer); sessions.delete(source.tabId); }
  });
}
if (typeof chrome !== 'undefined' && chrome.tabs?.onRemoved) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    const s = sessions.get(tabId);
    if (s) { clearTimeout(s.timer); sessions.delete(tabId); }
  });
}
