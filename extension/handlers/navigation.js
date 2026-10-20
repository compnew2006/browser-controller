/**
 * Navigation handler (extracted from background.js): the one page tool allowed
 * to omit tabId (documented active-tab fallback).
 */
import { resolveTab, safeExec, replaceFrozenTab } from '../lib/page-exec.js';
import { isHashOnlyChange, normalizeNavigationUrl, classifyMainResponse } from '../utils/navigation.js';
import { handleSnapshot } from './inspection.js';

/** How long a load may take before the call reports the page as it is then. */
const NAVIGATE_TIMEOUT_MS = 55_000;
/** A history step that fires no load (same document, or a bfcache restore) is settled after this. */
const HISTORY_IDLE_MS = 1_500;

/** Active-tab fallback, used ONLY by navigate when the caller omits tabId. */
export async function getActiveTab() {
  // lastFocusedWindow, not currentWindow: in an MV3 service worker
  // "current window" is ill-defined (no focused window context) and can grab
  // the wrong tab. Fall back to any active tab if Chrome reports none.
  let tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tabs.length === 0) tabs = await chrome.tabs.query({ active: true });
  const tab = tabs[0];
  if (!tab) throw new Error('No active tab and no tabId given. Call browser_tabs list first.');
  return tab;
}

/**
 * Main-frame network facts for one tab while a navigation runs. webRequest is
 * the only source of the HTTP status (the manifest has no webNavigation).
 * `onSignal` fires at once for an outcome that ends the wait: a real network
 * error, a 204/205, or a download. None of those makes the tab report
 * `complete` for the new page, so waiting for it hung to the timeout.
 */
function watchMainFrame(tabId, onSignal) {
  const facts = { status: null, url: null, noContent: false, download: false, filename: null, error: null };
  const wr = globalThis.chrome?.webRequest;
  if (!wr?.onHeadersReceived?.addListener || !wr.onErrorOccurred?.addListener) {
    return { facts, stop() {} };
  }
  const filter = { urls: ['<all_urls>'], types: ['main_frame'], tabId };
  // Every redirect hop is a main-frame response: the last one seen is the final one.
  const onHeaders = (d) => {
    if (d.tabId !== tabId) return;
    const kind = classifyMainResponse(d.statusCode, d.responseHeaders);
    Object.assign(facts, {
      status: d.statusCode, url: d.url, noContent: kind.noContent, download: kind.download, filename: kind.filename,
    });
    if (kind.noContent || kind.download) onSignal();
  };
  const onError = (d) => {
    if (d.tabId !== tabId) return;
    facts.error = d.error;
    // ERR_ABORTED also follows a navigation the page superseded: only a real failure ends the wait.
    if (d.error !== 'net::ERR_ABORTED') onSignal();
  };
  wr.onHeadersReceived.addListener(onHeaders, filter, ['responseHeaders']);
  wr.onErrorOccurred.addListener(onError, filter);
  return {
    facts,
    stop() {
      wr.onHeadersReceived.removeListener(onHeaders);
      wr.onErrorOccurred.removeListener(onError);
    },
  };
}

/**
 * Load `url` in the tab and wait for the outcome. Resolves when the tab
 * completes, the network reports a failure, a 204/download ends the load, or
 * the timeout passes. Returns the watched facts and whether it timed out.
 */
async function navigateAndWait(tab, url, { waitUntil, cancelRace }) {
  let endWait = () => {};
  let timedOut = false;
  const watch = watchMainFrame(tab.id, () => endWait());
  try {
    const loaded = new Promise((resolve, reject) => {
      let settled = false;
      let pollTimer = null;
      let capTimer = null;
      // `navigated` gates the readyState probe so we never sample the OLD
      // document (which is already 'complete' and would resolve instantly
      // before the new page even commits).
      let navigated = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        chrome.tabs.onUpdated.removeListener(listener);
        if (pollTimer) clearInterval(pollTimer);
        clearTimeout(capTimer);
        resolve();
      };
      endWait = finish;
      // domcontentloaded resolves as soon as the HTML is parsed (readyState
      // reaches 'interactive') — strictly earlier than 'complete'. Chrome's
      // tabs.onUpdated only reports 'loading' and 'complete', never
      // 'interactive', so for that mode we poll readyState in the page via
      // the already-granted scripting permission (no new permission needed).
      // 'load' (default) keeps waiting for status === 'complete'.
      const wantDcl = waitUntil === 'domcontentloaded';
      const probeReady = async () => {
        if (!navigated) return; // don't probe the pre-navigation document
        try {
          const rs = await safeExec(tab.id, () => document.readyState, []);
          if (rs === 'interactive' || rs === 'complete') finish();
        } catch { /* new document not commit-able yet */ }
      };
      const listener = (tId, changeInfo) => {
        if (tId !== tab.id) return;
        if (changeInfo.status === 'loading') navigated = true;
        if (changeInfo.status === 'complete') finish();
      };
      chrome.tabs.onUpdated.addListener(listener);
      if (wantDcl) pollTimer = setInterval(probeReady, 150);
      chrome.tabs.update(tab.id, { url }).catch((err) => {
        chrome.tabs.onUpdated.removeListener(listener);
        if (pollTimer) clearInterval(pollTimer);
        clearTimeout(capTimer);
        reject(err);
      });
      capTimer = setTimeout(() => { timedOut = true; finish(); }, NAVIGATE_TIMEOUT_MS);
    });
    // Race the load wait against cancellation so a closed client doesn't pin
    // the tab mutex for up to 55s.
    await (cancelRace ? Promise.race([loaded, cancelRace]) : loaded);
  } finally {
    watch.stop();
  }
  return { facts: watch.facts, timedOut };
}

/**
 * One step back or forward in the tab's own history, through the page's
 * history.go(). chrome.tabs.goBack skips entries the user did not interact with,
 * which made back fail with "Cannot find a next page" after plain navigations
 * (audit #12). Returns { url, timedOut } or { error } when there is nowhere to go.
 */
async function stepHistory(tab, step, cancelRace) {
  const delta = step === 'back' ? -1 : 1;
  const before = tab.url;
  // navigation.canGoBack / canGoForward (Navigation API, Chrome 102+) is exact.
  const can = await safeExec(tab.id, (d) => {
    const nav = window.navigation;
    if (nav && typeof nav.canGoBack === 'boolean') return d < 0 ? nav.canGoBack : nav.canGoForward;
    return d < 0 ? history.length > 1 : null; // unknown: try the step
  }, [delta], { world: 'MAIN' });
  if (can === false) return { error: `NO_HISTORY_ENTRY: tab ${tab.id} has no page to go ${step} to.` };

  const settled = new Promise((resolve, reject) => {
    let sawLoad = false;
    let idle = null;
    let cap = null;
    const done = (timedOut) => {
      clearTimeout(idle);
      clearTimeout(cap);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve({ sawLoad, timedOut });
    };
    const listener = (id, info) => {
      if (id !== tab.id) return;
      if (info.status === 'loading') sawLoad = true;
      if (info.status === 'complete' && sawLoad) done(false);
    };
    chrome.tabs.onUpdated.addListener(listener);
    idle = setTimeout(() => { if (!sawLoad) done(false); }, HISTORY_IDLE_MS);
    cap = setTimeout(() => done(true), NAVIGATE_TIMEOUT_MS);
    safeExec(tab.id, (d) => { history.go(d); }, [delta], { world: 'MAIN' }).catch((err) => {
      clearTimeout(idle);
      clearTimeout(cap);
      chrome.tabs.onUpdated.removeListener(listener);
      reject(err);
    });
  });
  const outcome = await (cancelRace ? Promise.race([settled, cancelRace]) : settled);
  const after = await chrome.tabs.get(tab.id).catch(() => null);
  const url = after?.url || before;
  // Nothing loaded and the URL did not change, and the page did not say it could go back: nowhere to go.
  if (!outcome.sawLoad && can !== true && url === before) {
    return { error: `NO_HISTORY_ENTRY: tab ${tab.id} has no page to go ${step} to.` };
  }
  return { url, timedOut: outcome.timedOut };
}

export async function handleNavigate(params, sessionId, _agentName, signal) {
  const { waitUntil = 'load', tabId, snapshot: wantSnapshot = true } = params;
  // back / forward walk the tab's history; anything else is an address (a bare host gets a scheme).
  const historyStep = params.url === 'back' || params.url === 'forward' ? params.url : null;
  const url = historyStep ? null : normalizeNavigationUrl(params.url);
  if (!historyStep && !url) throw new Error('url is required: a web address, or "back" / "forward".');
  // navigate is the one page tool allowed to omit tabId → active tab fallback.
  let tab = tabId != null ? await resolveTab(tabId) : await getActiveTab();

  // A frozen page (TAB_WEDGED) would hold the navigation hostage: replace the tab.
  let replacedTabId = null;
  const fresh = !historyStep ? await replaceFrozenTab(tab, null, sessionId) : null;
  if (fresh) { replacedTabId = tab.id; tab = fresh; }
  const replaced = replacedTabId
    ? { replacedTabId, note: `tab ${replacedTabId} was frozen and has been replaced by tab ${tab.id}` }
    : {};
  const currentTab = await chrome.tabs.get(tab.id);
  const hashOnly = !historyStep && isHashOnlyChange(currentTab.url, url);

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

  let facts = null;
  let timedOut = false;
  if (historyStep) {
    const step = await stepHistory(tab, historyStep, cancelRace);
    if (step.error) return { success: false, error: step.error, tabId: tab.id };
    timedOut = step.timedOut;
  } else if (hashOnly) {
    // Fix #2 (hash-aware): a hash-only navigation does NOT reload the document,
    // so `chrome.tabs.onUpdated` never fires `status === 'complete'`. Apply the
    // URL (updates location.hash, no reload) and skip the wait: SPA routers
    // update synchronously on hashchange.
    await chrome.tabs.update(tab.id, { url });
  } else {
    // Fix #1 (SPA-ready): Chrome fires `complete` as soon as the HTML loads, but
    // SPAs render content via JS AFTER that; the SPA-settle delay below covers it.
    const nav = await navigateAndWait(tab, url, { waitUntil, cancelRace });
    facts = nav.facts;
    timedOut = nav.timedOut;
    if (facts.error && facts.error !== 'net::ERR_ABORTED' && !facts.noContent && !facts.download) {
      return { success: false, error: `NAVIGATION_FAILED: ${facts.error} while loading ${url}`, url, tabId: tab.id, ...replaced };
    }
    if (facts.noContent || facts.download) {
      // Nothing was loaded: the tab keeps its page (204/205) or the file was saved (download).
      const common = { tabId: tab.id, ...(typeof facts.status === 'number' ? { status: facts.status } : {}), ...replaced };
      if (facts.download) {
        return {
          success: true, download: true, url: facts.url || url,
          ...(facts.filename ? { filename: facts.filename } : {}),
          ...common, note: 'the response is a file download, so the tab did not navigate',
        };
      }
      const current = await chrome.tabs.get(tab.id).catch(() => null);
      return { success: true, noContent: true, url: current?.url || tab.url, ...common, note: 'the response had no content, so the browser kept the current page' };
    }
  }

  // SPA settle window. 500ms is a cheap, robust default that covers most
  // client-rendered apps without making navigation feel slow for static pages.
  await new Promise((r) => setTimeout(r, 500));

  // Report where the tab really landed (after redirects), not the address asked for.
  const landed = await chrome.tabs.get(tab.id).catch(() => null);
  const finalUrl = landed?.url || facts?.url || url || tab.url;
  const out = {
    success: true,
    url: finalUrl,
    // The HTTP status when webRequest saw the main-frame response (404/500: the page still loaded).
    status: typeof facts?.status === 'number' ? facts.status : 'navigated',
    tabId: tab.id,
    ...(url && finalUrl !== url ? { requestedUrl: url } : {}),
    ...(timedOut ? { warning: `the page was still loading after ${NAVIGATE_TIMEOUT_MS / 1000} s; this is its state so far` } : {}),
    ...replaced,
  };

  // Return the snapshot inline ONLY if the caller asked for it (default true).
  // Skipping it (snapshot:false) saves a large chunk of tokens when the agent
  // intends to call browser_snapshot itself or doesn't need the tree yet.
  if (!wantSnapshot) return out;
  try {
    const snap = await handleSnapshot({ tabId: tab.id, compact: true });
    const snapObj = typeof snap === 'string' ? JSON.parse(snap) : snap;
    return { ...out, snapshot: snapObj && snapObj.content ? snapObj.content : snapObj };
  } catch {
    // snapshot failed (protected page / 401 / etc) — navigation still succeeded.
    return out;
  }
}
