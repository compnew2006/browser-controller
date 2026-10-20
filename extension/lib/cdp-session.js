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
 *
 * And the Page domain, so a JavaScript dialog (alert/confirm/prompt) that opens
 * while the session is attached is known: CDP can only answer dialogs that
 * opened after Page.enable, and Page.enable itself hangs while one is open.
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

/** tabId -> { x, y }: where the agent's last mouse event was sent. */
const lastMouse = new Map();

/** The viewport point the agent's mouse is at in the tab, or null. */
export function lastMousePoint(tabId) {
  return lastMouse.get(tabId) || null;
}

/** tabId -> { type, message } of the JavaScript dialog open in the tab. */
const openDialogs = new Map();

/** The dialog open in the tab ({ type, message }), or null. */
export function openDialog(tabId) {
  return openDialogs.get(tabId) || null;
}

/** The error a call gets while a dialog blocks the tab's page. */
export function dialogOpenError(tabId, dialog) {
  const err = new Error(`DIALOG_OPEN: a ${dialog.type} dialog is open in tab ${tabId} ("${dialog.message}"). Answer it with browser_handle_dialog.`);
  err.code = 'DIALOG_OPEN';
  return err;
}

/** Forget the tab's dialog once it was answered (the close event may lag). */
export function clearDialog(tabId) {
  if (openDialogs.delete(tabId)) armIdle(tabId);
}

function armIdle(tabId) {
  const s = sessions.get(tabId);
  if (!s) return;
  clearTimeout(s.timer);
  if (s.busy > 0) return; // a long withCdp() call is still using the session
  if (s.emulation && Object.keys(s.emulation).length) return; // detaching would drop the overrides
  if (s.pins?.size) return; // a capture (response bodies…) is running on it
  if (openDialogs.has(tabId)) return; // re-attaching could not answer it any more
  s.timer = setTimeout(() => { detachCdp(tabId); }, IDLE_MS);
}

/**
 * Keep the tab's live session attached for `reason` until unpinned. The pin
 * lives on the session, so it is gone once the session detaches (banner
 * closed, tab closed): isCdpPinned() then tells the caller its capture stopped.
 */
export function pinCdp(tabId, reason) {
  const s = sessions.get(tabId);
  if (!s) return false;
  (s.pins ||= new Set()).add(reason);
  clearTimeout(s.timer);
  return true;
}

export function unpinCdp(tabId, reason) {
  const s = sessions.get(tabId);
  if (!s?.pins?.delete(reason)) return;
  armIdle(tabId);
}

/** Pinned for `reason`, or for anything when no reason is given. */
export function isCdpPinned(tabId, reason) {
  const pins = sessions.get(tabId)?.pins;
  return reason === undefined ? !!pins?.size : !!pins?.has(reason);
}

/** Overrides browser_emulate set on the tab's live session ({} when none or detached). */
export function getCdpEmulation(tabId) {
  return { ...(sessions.get(tabId)?.emulation || {}) };
}

/** Record the active overrides; while any are set the session is not idle-detached. */
export function setCdpEmulation(tabId, state) {
  const s = sessions.get(tabId);
  if (!s) return;
  s.emulation = { ...state };
  armIdle(tabId);
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
  await bounded(chrome.debugger.sendCommand(target, 'Page.enable'), 'page domain').catch(() => {});
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
  return (method, params = {}) => {
    if (method === 'Input.dispatchMouseEvent' && Number.isFinite(params.x)) lastMouse.set(tabId, { x: params.x, y: params.y });
    // Page JavaScript cannot run while a dialog is open: say so instead of queuing it.
    const dialog = openDialogs.get(tabId);
    if (dialog && method.startsWith('Runtime.')) return Promise.reject(dialogOpenError(tabId, dialog));
    const sent = chrome.debugger.sendCommand({ tabId }, method, params);
    return method.startsWith('Input.') || method.startsWith('Runtime.') ? untilDialog(tabId, sent) : sent;
  };
}

/**
 * Input or script that opens a dialog is only answered once the dialog
 * closes: resolve it as soon as a dialog is open instead of hanging the tool.
 */
function untilDialog(tabId, sent) {
  if (openDialogs.has(tabId)) return Promise.resolve({});
  let unsubscribe;
  const opened = new Promise((resolve) => {
    unsubscribe = subscribeCdpEvents(tabId, (method) => { if (method === 'Page.javascriptDialogOpening') resolve({}); });
  });
  return Promise.race([sent, opened]).finally(unsubscribe);
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
  openDialogs.delete(tabId);
  try { await chrome.debugger.detach({ tabId }); } catch { /* already gone */ }
}

export function hasCdp(tabId) {
  return sessions.has(tabId);
}

/** tabId -> Set<(method, params) => void> */
const eventSubscribers = new Map();

/**
 * Receive the tab's CDP events (method, params) until the returned function is
 * called. A subscriber that answers a Fetch.requestPaused returns true.
 */
export function subscribeCdpEvents(tabId, fn) {
  let subs = eventSubscribers.get(tabId);
  if (!subs) { subs = new Set(); eventSubscribers.set(tabId, subs); }
  subs.add(fn);
  return () => {
    subs.delete(fn);
    if (!subs.size) eventSubscribers.delete(tabId);
  };
}

if (typeof chrome !== 'undefined' && chrome.debugger?.onEvent) {
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (method === 'Page.javascriptDialogOpening') {
      openDialogs.set(source.tabId, { type: params.type, message: String(params.message ?? '').slice(0, 300) });
      clearTimeout(sessions.get(source.tabId)?.timer);
    } else if (method === 'Page.javascriptDialogClosed') {
      clearDialog(source.tabId);
    }
    const subs = eventSubscribers.get(source.tabId);
    let answered = false;
    if (subs) for (const fn of [...subs]) { try { if (fn(method, params) === true) answered = true; } catch { /* one bad subscriber must not starve the rest */ } }
    // A paused request nobody answers would hang the page for good (the worker
    // restarted and lost its mock rules, the rules were just cleared): let it
    // through and stop pausing.
    if (method === 'Fetch.requestPaused' && !answered) {
      const target = { tabId: source.tabId };
      chrome.debugger.sendCommand(target, 'Fetch.continueRequest', { requestId: params.requestId }).catch(() => {});
      chrome.debugger.sendCommand(target, 'Fetch.disable').catch(() => {});
    }
  });
}

// The user can dismiss the debugger banner, or the tab can close/navigate to a
// protected page: forget the session so the next call re-attaches cleanly.
if (typeof chrome !== 'undefined' && chrome.debugger?.onDetach) {
  chrome.debugger.onDetach.addListener((source) => {
    openDialogs.delete(source.tabId);
    const s = sessions.get(source.tabId);
    if (s) { clearTimeout(s.timer); sessions.delete(source.tabId); }
  });
}
if (typeof chrome !== 'undefined' && chrome.tabs?.onRemoved) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    openDialogs.delete(tabId);
    lastMouse.delete(tabId);
    const s = sessions.get(tabId);
    if (s) { clearTimeout(s.timer); sessions.delete(tabId); }
  });
}
