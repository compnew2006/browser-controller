/**
 * Navigation handler (extracted from background.js). browser_navigate opens a
 * tab for the calling session when the call names none, and otherwise moves
 * the tab it names: to an address, one step back or forward in its history, or
 * a reload.
 */
import { resolveTab, safeExec, replaceFrozenTab } from '../lib/page-exec.js';
import { sessionAgentNames } from '../lib/state.js';
import { lockTabUi } from '../lib/lock-ops.js';
import { showLockShield } from '../lib/overlay.js';
import { isHashOnlyChange, normalizeNavigationUrl, classifyMainResponse } from '../utils/navigation.js';
import { handleSnapshot } from './inspection.js';

/** How long a load may take before the call reports the page as it is then. */
const NAVIGATE_TIMEOUT_MS = 15_000;
/** A history step that fires no load (same document, or a bfcache restore) is settled after this. */
const HISTORY_IDLE_MS = 1_500;
/** The snapshot appended when snapshot:true, in characters. */
const SNAPSHOT_MAX_CHARS = 2_000;

/**
 * The active tab of the user's last focused window. A session's new tab opens
 * in that window; any other tab id the calls name is taken as it is.
 */
export async function getActiveTab() {
  // lastFocusedWindow, not currentWindow: in an MV3 service worker
  // "current window" is ill-defined (no focused window context) and can grab
  // the wrong tab. Fall back to any active tab if Chrome reports none.
  let tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tabs.length === 0) tabs = await chrome.tabs.query({ active: true });
  const tab = tabs[0];
  if (!tab) throw new Error('No active tab to open the new tab next to. Call browser_tabs list first.');
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
 * A tab that was just opened starts on about:blank, and that page's own
 * `complete` must not end the wait of the load that follows. Wait until it is not loading.
 */
async function settleNewTab(tabId) {
  for (let i = 0; i < 60; i += 1) {
    const now = await chrome.tabs.get(tabId).catch(() => null);
    if (!now || now.status !== 'loading') return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * The new tab for a call that names none: a background tab in the user's last
 * focused window, owned by the calling session until it closes or the session
 * ends.
 */
async function openSessionTab(sessionId) {
  const focused = await getActiveTab().catch(() => null);
  const tab = await chrome.tabs.create({
    url: 'about:blank',
    active: false,
    ...(focused ? { windowId: focused.windowId } : {}),
  });
  if (sessionId) {
    await lockTabUi(tab.id, sessionId, `Tab ${tab.id} opened and locked by ${sessionAgentNames.get(sessionId) || 'an agent'}`);
  }
  await settleNewTab(tab.id);
  return tab;
}

/**
 * A promise that rejects when the call is cancelled (client gone, or the timeout
 * forwarded from the bridge), or null without a signal. Long waits race against it so a
 * cancelled call releases the tab mutex at once. Create it only where it is raced: a
 * rejection nothing subscribes to is an unhandled one.
 */
function cancellationOf(signal) {
  if (!signal) return null;
  const cancelled = () => Object.assign(new Error('TIMEOUT: navigate cancelled by the caller'), { code: 'TIMEOUT' });
  return new Promise((_, reject) => {
    if (signal.aborted) reject(cancelled());
    else signal.addEventListener('abort', () => reject(cancelled()), { once: true });
  });
}

/**
 * Start a load in the tab (`startLoad`) and wait for the outcome. Resolves when
 * the tab completes, the network reports a failure, a 204/download ends the load,
 * or the timeout passes. Returns the watched facts and whether it timed out.
 */
async function navigateAndWait(tab, startLoad, { waitUntil, cancelRace }) {
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
      Promise.resolve().then(startLoad).catch((err) => {
        chrome.tabs.onUpdated.removeListener(listener);
        if (pollTimer) clearInterval(pollTimer);
        clearTimeout(capTimer);
        reject(err);
      });
      capTimer = setTimeout(() => { timedOut = true; finish(); }, NAVIGATE_TIMEOUT_MS);
    });
    // Race the load wait against cancellation so a closed client doesn't pin
    // the tab mutex for up to the whole timeout.
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

/** The lines the agent reads about one navigation. */
function navigationLines(out, title) {
  const lines = [`tabId: ${out.tabId}`, `url: ${out.url}`];
  if (out.status !== undefined) lines.push(`status: ${out.status}`);
  if (title) lines.push(`title: ${title}`);
  if (out.download) lines.push(`download: true${out.filename ? ` (file ${out.filename})` : ''}; the tab did not navigate`);
  if (out.noContent) lines.push('noContent: true; the response had no content, so the tab keeps its page');
  if (out.loading) lines.push(`loading: true (still loading after ${NAVIGATE_TIMEOUT_MS / 1000} s; this is its state so far)`);
  if (out.replacedTabId != null) lines.push(`note: tab ${out.replacedTabId} was frozen and has been replaced by tab ${out.tabId}`);
  return lines;
}

/** The clause that names a frozen tab's replacement in an error text (a success text says the same as `note:`). */
function replacedClause(from, to) {
  return `(tab ${from} was frozen and has been replaced by tab ${to})`;
}

/**
 * A failure after a frozen tab was replaced. A `CODE: message` keeps its code; any other
 * error becomes NAVIGATION_FAILED. The message names the replacement, because the error
 * text is all the agent reads, so it learns the new tab id from it.
 */
function replacementFailure(err, { from, to }) {
  const raw = String(err?.message || err);
  const message = /^[A-Z][A-Z0-9_]+: /.test(raw) ? raw : `NAVIGATION_FAILED: ${raw}`;
  const failure = new Error(`${message} ${replacedClause(from, to)}`);
  failure.code = message.slice(0, message.indexOf(':'));
  return failure;
}

/**
 * browser_navigate. `url` is an address (the scheme is optional), or "back",
 * "forward" or "reload". Without tabId the call opens a new background tab that
 * this session owns. Waits for the load up to 15 s; a 204 or a download ends the
 * wait at once. A network failure fails with NAVIGATION_FAILED.
 */
export async function handleNavigate(params, sessionId, _agentName, signal) {
  // Set once a frozen tab is replaced, so a failure after that can name the replacement.
  const state = { replaced: null };
  try {
    return await navigateTab(params, sessionId, signal, state);
  } catch (err) {
    if (!state.replaced) throw err;
    throw replacementFailure(err, state.replaced);
  }
}

async function navigateTab(params, sessionId, signal, state) {
  const { tabId, snapshot: wantSnapshot = false } = params;
  const { waitUntil = 'load' } = params;
  const step = params.url === 'back' || params.url === 'forward' ? params.url : null;
  const reload = params.url === 'reload';
  const url = step || reload ? null : normalizeNavigationUrl(params.url);
  if (!step && !reload && !url) {
    throw new Error('INVALID_ARGUMENT: url is required: a web address, "back", "forward" or "reload".');
  }
  if ((step || reload) && tabId == null) {
    throw new Error(`INVALID_ARGUMENT: "${params.url}" moves a tab that is already open: pass its tabId.`);
  }
  const opened = tabId == null;
  let tab = opened ? await openSessionTab(sessionId) : await resolveTab(tabId);
  const before = tab.url;
  // A navigation clears the lock shield a session's own new tab wears: put it back once the page is in.
  const reshield = async () => { if (opened && sessionId) await showLockShield(tab.id); };

  // A frozen page (TAB_WEDGED) would hold the navigation hostage: replace the tab.
  // History steps leave a frozen page alone: its replacement would have no history.
  let replacedTabId = null;
  const fresh = step ? null : await replaceFrozenTab(tab, null, sessionId);
  if (fresh) {
    replacedTabId = tab.id;
    state.replaced = { from: tab.id, to: fresh.id };
    tab = fresh;
    await settleNewTab(tab.id);
  }
  const replacedData = replacedTabId != null ? { replacedTabId } : {};
  // The address a load goes to: the typed one, or for a reload the page the tab showed.
  const target = reload ? before : url;
  // A reload of a frozen tab loads its page in the replacement; a reload otherwise reloads in place.
  const reloadInPlace = reload && !fresh;
  const currentTab = await chrome.tabs.get(tab.id);
  const hashOnly = !step && !reload && isHashOnlyChange(currentTab.url, target);

  let facts = null;
  let timedOut = false;
  if (step) {
    const walked = await stepHistory(tab, step, cancellationOf(signal));
    if (walked.error) return { success: false, error: walked.error, tabId: tab.id };
    timedOut = walked.timedOut;
  } else if (hashOnly) {
    // Fix #2 (hash-aware): a hash-only navigation does NOT reload the document,
    // so `chrome.tabs.onUpdated` never fires `status === 'complete'`. Apply the
    // URL (updates location.hash, no reload) and skip the wait: SPA routers
    // update synchronously on hashchange.
    await chrome.tabs.update(tab.id, { url: target });
  } else {
    // Fix #1 (SPA-ready): Chrome fires `complete` as soon as the HTML loads, but
    // SPAs render content via JS AFTER that; the SPA-settle delay below covers it.
    const startLoad = reloadInPlace
      ? () => chrome.tabs.reload(tab.id)
      : () => chrome.tabs.update(tab.id, { url: target });
    const nav = await navigateAndWait(tab, startLoad, { waitUntil, cancelRace: cancellationOf(signal) });
    facts = nav.facts;
    timedOut = nav.timedOut;
    if (facts.error && facts.error !== 'net::ERR_ABORTED' && !facts.noContent && !facts.download) {
      await reshield();
      // The error text is all the agent reads: name the replacement here too, as the success text does.
      const replaced = replacedTabId != null ? ` ${replacedClause(replacedTabId, tab.id)}` : '';
      return { success: false, error: `NAVIGATION_FAILED: ${facts.error} while loading ${target}${replaced}`, url: target, tabId: tab.id, ...replacedData };
    }
    if (facts.noContent || facts.download) {
      // Nothing was loaded: the tab keeps its page (204/205) or the file was saved (download).
      const current = await chrome.tabs.get(tab.id).catch(() => null);
      const out = {
        success: true,
        tabId: tab.id,
        url: facts.download ? facts.url || target : current?.url || tab.url,
        ...(typeof facts.status === 'number' ? { status: facts.status } : {}),
        ...(facts.download ? { download: true } : { noContent: true }),
        ...(facts.filename ? { filename: facts.filename } : {}),
        ...replacedData,
      };
      return { ...out, text: navigationLines(out).join('\n') };
    }
  }

  // SPA settle window. 500ms is a cheap, robust default that covers most
  // client-rendered apps without making navigation feel slow for static pages.
  await new Promise((r) => setTimeout(r, 500));
  await reshield();

  // Report where the tab really landed (after redirects), not the address asked for.
  const landed = await chrome.tabs.get(tab.id).catch(() => null);
  const finalUrl = landed?.url || facts?.url || target || tab.url;
  const out = {
    success: true,
    url: finalUrl,
    tabId: tab.id,
    ...(typeof facts?.status === 'number' ? { status: facts.status } : {}),
    ...(url && finalUrl !== url ? { requestedUrl: url } : {}),
    ...(timedOut ? { loading: true } : {}),
    ...replacedData,
  };
  const lines = navigationLines(out, landed?.title);

  // The snapshot comes inline ONLY when the caller asked for it: it costs tokens,
  // and the agent often wants the tree later, after its own checks.
  if (wantSnapshot) {
    try {
      const snap = await handleSnapshot({ tabId: tab.id, maxChars: SNAPSHOT_MAX_CHARS });
      if (snap?.success === false) lines.push(`snapshot: unavailable (${snap.error})`);
      else if (snap?.text) lines.push('', snap.text);
    } catch (err) {
      // A snapshot can fail on a protected page: the navigation itself still succeeded.
      lines.push(`snapshot: unavailable (${err?.message || err})`);
    }
  }
  return { ...out, text: lines.join('\n') };
}
