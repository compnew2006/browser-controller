/**
 * Navigation handler (extracted from background.js): the one page tool allowed
 * to omit tabId (documented active-tab fallback).
 */
import { resolveTab, safeExec, replaceFrozenTab } from '../lib/page-exec.js';
import { isHashOnlyChange } from '../utils/navigation.js';
import { networkByTab } from '../lib/state.js';
import { handleSnapshot } from './inspection.js';

/** The tab's main-document request that ended at or after `since` (webRequest capture), if any. */
function mainFrameSince(tabId, since) {
  const buf = networkByTab.get(tabId) || [];
  for (let i = buf.length - 1; i >= 0; i--) {
    const e = buf[i];
    if (e.timestamp < since) return null;
    if (e.type === 'main_frame') return e;
  }
  return null;
}

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

export async function handleNavigate(params, sessionId, _agentName, signal) {
  let { url } = params;
  const { waitUntil = 'load', tabId, snapshot: wantSnapshot = true } = params;
  // navigate is the one page tool allowed to omit tabId → active tab fallback.
  let tab = tabId != null ? await resolveTab(tabId) : await getActiveTab();

  // Fix #2 (hash-aware): a hash-only navigation does NOT reload the document,
  // so `chrome.tabs.onUpdated` never fires `status === 'complete'` and the wait
  // below would hang for the full 55s timeout. Detect this case and skip the
  // wait entirely — the SPA router updates client-side near-instantly.
  // "back"/"forward" walk the tab's history instead of being treated as a
  // relative URL (which used to land on chrome-extension://<id>/back).
  const historyStep = url === 'back' || url === 'forward' ? url : null;
  const go = () => historyStep === 'back' ? chrome.tabs.goBack(tab.id)
    : historyStep === 'forward' ? chrome.tabs.goForward(tab.id)
    : chrome.tabs.update(tab.id, { url });

  // A frozen page (TAB_WEDGED) would hold the navigation hostage: replace the tab.
  let replacedTabId = null;
  const fresh = !historyStep ? await replaceFrozenTab(tab, null, sessionId) : null;
  if (fresh) { replacedTabId = tab.id; tab = fresh; }
  const currentTab = await chrome.tabs.get(tab.id);
  const hashOnly = !historyStep && isHashOnlyChange(currentTab.url, url);
  const navStart = Date.now();

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

  // Fix #1 (SPA-ready): Chrome fires `complete` as soon as the HTML loads, but
  // SPAs (React/Vue/...) render content via JS AFTER that — so a snapshot taken
  // immediately returns an empty body. We (a) wait for `complete`, (b) give the
  // SPA ~500ms to render, then (c) return a snapshot inline so the agent doesn't
  // waste a separate browser_snapshot call on a still-empty page. On a protected
  // page (chrome://, 401 Basic auth) the snapshot will surface a clear error
  // instead of silently returning empty.
  if (!hashOnly) {
    const onUpdatedWait = new Promise((resolve, reject) => {
      let settled = false;
      let pollTimer = null;
      let endTimer = null;
      // `navigated` gates the readyState probe so we never sample the OLD
      // document (which is already 'complete' and would resolve instantly
      // before the new page even commits).
      let navigated = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        chrome.tabs.onUpdated.removeListener(listener);
        if (pollTimer) clearInterval(pollTimer);
        clearInterval(endTimer);
        resolve();
      };
      // A download or a 204 ends the request without a new page, so 'complete'
      // never comes: stop once the request is over and the tab is idle again.
      endTimer = setInterval(async () => {
        if (!mainFrameSince(tab.id, navStart)) return;
        const now = await chrome.tabs.get(tab.id).catch(() => null);
        if (now && now.status === 'complete' && !now.pendingUrl) finish();
      }, 250);
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
      go().catch((err) => {
        chrome.tabs.onUpdated.removeListener(listener);
        if (pollTimer) clearInterval(pollTimer);
        clearInterval(endTimer);
        reject(err);
      });
      setTimeout(finish, 55000); // timeout — still proceed to settle + snapshot
    });
    // Race the load wait against cancellation so a closed client doesn't pin
    // the tab mutex for up to 55s.
    if (cancelRace) {
      await Promise.race([onUpdatedWait, cancelRace]);
    } else {
      await onUpdatedWait;
    }
  } else {
    // Hash-only: apply the URL (updates location.hash, no reload) and skip the
    // onUpdated wait. SPA routers update synchronously on hashchange.
    await chrome.tabs.update(tab.id, { url });
  }

  // SPA settle window. 500ms is a cheap, robust default that covers most
  // client-rendered apps without making navigation feel slow for static pages.
  await new Promise((r) => setTimeout(r, 500));

  // Return the snapshot inline ONLY if the caller asked for it (default true).
  // Skipping it (snapshot:false) saves a large chunk of tokens when the agent
  // intends to call browser_snapshot itself or doesn't need the tree yet.
  // Report where the tab landed (redirects, back/forward), and what the server said.
  url = (await chrome.tabs.get(tab.id)).url || url;
  const main = mainFrameSince(tab.id, navStart);
  if (main?.error && !/ERR_ABORTED/.test(main.error)) {
    return { success: false, error: `Navigation failed: ${main.error}`, url: main.url, tabId: tab.id };
  }
  if (main && url === currentTab.url && main.url !== currentTab.url) {
    return { url, status: 'not-navigated', note: 'The server answered with a download or no content: the page did not change.', tabId: tab.id };
  }
  const httpStatus = main?.status >= 400 ? { httpStatus: main.status } : {};

  if (!wantSnapshot) {
    return { url, status: 'navigated', ...httpStatus, tabId: tab.id, ...(replacedTabId ? { replacedTabId, note: `tab ${replacedTabId} was frozen and has been replaced by tab ${tab.id}` } : {}) };
  }
  try {
    const snap = await handleSnapshot({ tabId: tab.id });
    return {
      url,
      status: 'navigated',
      ...httpStatus,
      tabId: tab.id,
      ...(replacedTabId ? { replacedTabId, note: `tab ${replacedTabId} was frozen and has been replaced by tab ${tab.id}` } : {}),
      ...(typeof snap?.snapshot === 'string' ? { title: snap.title, snapshot: snap.snapshot, ...(snap.truncated ? { truncated: true, hint: snap.hint } : {}) } : {}),
    };
  } catch {
    // snapshot failed (protected page / 401 / etc) — navigation still succeeded.
    return { url, status: 'navigated', ...httpStatus, tabId: tab.id, ...(replacedTabId ? { replacedTabId } : {}) };
  }
}
