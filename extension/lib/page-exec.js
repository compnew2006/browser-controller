/**
 * Page-execution primitives (extracted from background.js): tab resolution,
 * the locator guard, and safeExec. Everything a handler needs to touch a page.
 */
import { fallbackByTab, wedgedTabs, tabLocks, tabControl, persistSessionState, refBaseFor, noteRefsShown } from './state.js';
import { highestRefIn } from './ref-errors.js';
import { PAGE_DOM_INSTALL, PAGE_DOM_VERSION } from './page-dom.js';
import { tabLockedMessage } from './tab-concurrency.js';

/**
 * Resolve a tab by id, throwing a clear, actionable error if it's gone.
 * Replaces the old getActiveTab()-style silent fallback — the root cause of
 * agents acting on the wrong page.
 */
export async function resolveTab(tabId) {
  if (tabId == null || typeof tabId !== 'number') {
    throw new Error('tabId is required. Call browser_tabs list first to get a tabId.');
  }
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab) throw new Error(`Tab ${tabId} not found, call browser_tabs list first.`);
    return tab;
  } catch (err) {
    throw new Error(`Tab ${tabId} not found, call browser_tabs list first. (${err.message || err})`, { cause: err });
  }
}

/**
 * Get the stored smart-selector fallback for a (tabId, ref). Returns null if
 * the ref was never snapshotted or the snapshot pre-dates the fallback feature.
 */
export function getFallback(tabId, ref) {
  if (tabId == null || !ref) return null;
  const map = fallbackByTab.get(tabId);
  if (!map) return null;
  return map.get(ref) || null;
}

/** Default budget for one page function (below every tool's own timeout). */
export const PAGE_EXEC_TIMEOUT_MS = 8_000;
/** Probe budget for a tab already known to be unresponsive. */
export const WEDGE_PROBE_MS = 1_500;

/** Race a promise against a timer; the timer's error comes from makeError(). */
export function withTimeout(promise, ms, makeError) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(makeError()), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function wedgedError(tabId, ms) {
  const err = new Error(`TAB_WEDGED: tab ${tabId} did not respond within ${(ms / 1000).toFixed(1)}s `
    + '(frozen main thread or a huge document). browser_navigate it elsewhere, reload it '
    + '(browser_navigate url:"reload") or close it; other tabs are unaffected.');
  err.code = 'TAB_WEDGED';
  return err;
}

/** Is a previously wedged tab answering again? Clears the mark when it is. */
export async function probeResponsive(tabId, ms = WEDGE_PROBE_MS) {
  try {
    await withTimeout(chrome.scripting.executeScript({ target: { tabId }, func: () => 1 }), ms, () => wedgedError(tabId, ms));
    wedgedTabs.delete(tabId);
    return true;
  } catch (err) {
    if (err && err.code === 'TAB_WEDGED') return false;
    wedgedTabs.delete(tabId); // a different failure (protected page, gone): not a wedge
    return true;
  }
}

/**
 * A frozen page holds every navigation/reload of its tab hostage until its
 * main thread frees up (57 s measured on a busy loop; CDP Page.crash and
 * tabs.discard don't help — discard even changes the tab id). Closing a tab
 * never waits for the page, so replace it: a new tab at the same position,
 * then close the frozen one. Returns the new tab, or null when the tab was
 * not wedged. Callers report `replacedTabId` so the agent switches ids.
 */
export async function replaceFrozenTab(tab, url, sessionId = null) {
  if (!wedgedTabs.has(tab.id)) return null;
  // Defence in depth (the router checks too): never replace another session's tab.
  const grant = tabLocks.grantOf(tab.id);
  if (grant && grant.sessionId !== sessionId) throw new Error(tabLockedMessage(tab.id, grant));
  const owner = grant?.sessionId;
  const fresh = await chrome.tabs.create({ windowId: tab.windowId, index: tab.index, url: url || 'about:blank', active: !!tab.active });
  wedgedTabs.delete(tab.id);
  // The replacement keeps the caller's lock on the tab it is replacing.
  if (owner) {
    tabLocks.release(tab.id);
    tabLocks.lock(fresh.id, owner);
    persistSessionState();
  }
  // So does the agent's control (incl. this very call): the popup must not list
  // the replacement it is navigating as "free".
  tabControl.move(tab.id, fresh.id);
  chrome.tabs.remove(tab.id).catch(() => { /* already gone */ });
  return fresh;
}

/** Fail fast when the tab is known to be frozen (one short probe, no queueing). */
export async function assertResponsive(tabId) {
  if (wedgedTabs.has(tabId) && !(await probeResponsive(tabId))) throw wedgedError(tabId, WEDGE_PROBE_MS);
}

/**
 * safeExec (task 2.5): run chrome.scripting.executeScript against a tab,
 * turning "can't access chrome:// / webstore / devtools pages" into a clear
 * error instead of a silent timeout. `opts.world: 'MAIN'` runs the function in
 * the page's own JS context, for the few functions that must see the page's own
 * globals (evaluate, and the history step of back/forward); the default ISOLATED
 * world cannot reach them.
 * A page function that throws is reported as SCRIPT_ERROR (see below). An async
 * one must catch its own errors and return { __bcScriptError: message }.
 */
export async function safeExec(tabId, func, args = [], opts = {}) {
  const tab = await resolveTab(tabId);
  if (/^(chrome|chrome-extension|devtools|edge|about):/i.test(tab.url || '')) {
    throw new Error(`INVALID_ARGUMENT: Cannot access protected page (${tab.url}). Tab ${tabId} is a browser-internal page.`);
  }
  const sanitized = args.map((a) => (a === undefined ? null : a));
  await assertResponsive(tabId);
  // An in-flight executeScript can't be aborted: without a timer a frozen page
  // pinned the tab's mutex until the caller's own timeout, and every queued
  // call after it waited too (benchmark: 2 × 125 s on one JSON page).
  const ms = opts.timeoutMs ?? PAGE_EXEC_TIMEOUT_MS;
  const startedAt = Date.now();
  let res;
  try {
    const results = await withTimeout(chrome.scripting.executeScript({
      target: { tabId },
      func,
      args: sanitized,
      ...(opts.world ? { world: opts.world } : {}),
    }), ms, () => {
      wedgedTabs.set(tabId, Date.now());
      return wedgedError(tabId, ms);
    });
    res = results[0]?.result;
  } catch (err) {
    if (err && err.code === 'TAB_WEDGED') throw err;
    const msg = err?.message || String(err);
    if (/cannot access|Cannot access|not allowed|No tab with id/i.test(msg)) {
      throw new Error(`Cannot execute on tab ${tabId}: ${msg}`, { cause: err });
    }
    throw err;
  }
  // A page function that throws comes back as a bare null (no error, no
  // rejection). Two ways it reports itself instead: an in-band
  // { __bcScriptError } object, or the uncaught error lib/page-dom.js recorded
  // in the isolated world. Either becomes a failure for every caller.
  if (res && typeof res === 'object' && typeof res.__bcScriptError === 'string') throw scriptError(res.__bcScriptError);
  if (res == null && opts.world !== 'MAIN') {
    const thrown = await takePageError(tabId, startedAt);
    if (thrown) throw scriptError(thrown);
  }
  return res;
}

function scriptError(message) {
  const err = new Error(`SCRIPT_ERROR: ${message}`);
  err.code = 'SCRIPT_ERROR';
  return err;
}

/**
 * Reads and clears the last uncaught error recorded in the page's isolated
 * world since `since` (null when none). Older errors belong to other calls.
 */
async function takePageError(tabId, since) {
  try {
    const results = await withTimeout(chrome.scripting.executeScript({
      target: { tabId },
      args: [since],
      func: (sinceMs) => {
        const recorded = globalThis.__bcPageError ?? null;
        globalThis.__bcPageError = null;
        return recorded && recorded.at >= sinceMs ? recorded.message : null;
      },
    }), WEDGE_PROBE_MS, () => new Error('page error probe timed out'));
    const message = results[0]?.result;
    return typeof message === 'string' && message ? message : null;
  } catch {
    return null; // the read itself failed: report the original result, as before
  }
}

/**
 * Run a page function that uses the shared DOM runtime (globalThis.__bcDom,
 * lib/page-dom.js). Page functions start with
 *   `if (!globalThis.__bcDom) return { __needDom: true };`
 * so the steady state costs one executeScript; the runtime is installed and
 * the call repeated only when the document doesn't have it yet.
 */
export async function execDom(tabId, func, args = [], opts = {}) {
  let res = await safeExec(tabId, func, args, opts);
  if (res && res.__needDom === true) {
    // A new document has no runtime yet. Its ref counter starts above every ref the tab's
    // earlier documents showed (lib/state.js refHighWaterByTab): a stale ref never names one of its elements.
    await safeExec(tabId, PAGE_DOM_INSTALL, [PAGE_DOM_VERSION, refBaseFor(tabId)], opts);
    res = await safeExec(tabId, func, args, opts);
  }
  // The refs this result shows the agent (a snapshot's, or an AMBIGUOUS reply's) raise the tab's mark.
  noteRefsShown(tabId, highestRefIn(res));
  return res;
}
