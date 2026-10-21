/**
 * Main-frame requests of one tab, watched for the length of one call: what browser_navigate
 * waits on, and how a click learns that it started a download instead of a navigation.
 */
import { classifyMainResponse } from '../utils/navigation.js';

/**
 * Main-frame network facts for one tab while a navigation runs. webRequest is
 * the only source of the HTTP status (webNavigation has none).
 * `onSignal` fires at once for an outcome that ends the wait: a real network
 * error, a 204/205, or a download. None of those makes the tab report
 * `complete` for the new page, so waiting for it hung to the timeout.
 * `started` is set when a main-frame request begins, before any response.
 */
export function watchMainFrame(tabId, onSignal) {
  const facts = { started: false, status: null, url: null, noContent: false, download: false, filename: null, error: null };
  const wr = globalThis.chrome?.webRequest;
  if (!wr?.onHeadersReceived?.addListener || !wr.onErrorOccurred?.addListener) {
    return { facts, stop() {} };
  }
  const filter = { urls: ['<all_urls>'], types: ['main_frame'], tabId };
  const onStart = (d) => {
    if (d.tabId === tabId) facts.started = true;
  };
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
  wr.onBeforeRequest?.addListener?.(onStart, filter);
  wr.onHeadersReceived.addListener(onHeaders, filter, ['responseHeaders']);
  wr.onErrorOccurred.addListener(onError, filter);
  return {
    facts,
    stop() {
      wr.onBeforeRequest?.removeListener?.(onStart);
      wr.onHeadersReceived.removeListener(onHeaders);
      wr.onErrorOccurred.removeListener(onError);
    },
  };
}

/** How long a click waits for the response of the main-frame request it started (is it a download?). */
export const RESPONSE_WAIT_MS = 2_000;

/** Resolve once the watched request has a response or an error, or after `ms`. */
export async function untilResponse(facts, ms = RESPONSE_WAIT_MS) {
  const deadline = Date.now() + ms;
  while (facts.started && facts.status == null && !facts.error && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** The result line of a download a click started (browser_navigate words its own the same way). */
export function downloadLine(facts) {
  return `download: true (${facts.filename ? `file ${facts.filename}` : facts.url}); Chrome saves it to the Downloads folder, the tab did not navigate`;
}
