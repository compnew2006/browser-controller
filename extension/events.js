/**
 * Browser-event wiring (extracted from background.js): popup messages,
 * webRequest capture, and tab lifecycle listeners.
 * Registration is a function (not module top-level) so tests can import the
 * handler modules without a `chrome` global.
 */
import {
  networkByTab,
  tabLocks,
  tabControl,
  getTabBuffer,
  persistSessionState,
  dropTabState,
  dropDocumentState,
} from "./lib/state.js";
import { showLockShield, hideLockShield } from "./lib/overlay.js";
import { createNetworkCapture, pushNetworkEntry } from "./lib/network-capture.js";
import { lockTabUi, releaseTabUi } from "./lib/lock-ops.js";
import {
  getOpenTabs,
  buildStatusPayload,
  broadcastStatus,
  applyPort,
  applyToken,
  applyEnrollment,
} from "./lib/connection.js";

export function registerEventListeners() {
  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    // NOTE: do NOT `return true` unconditionally. Returning true tells Chrome the
    // listener will call `respond()` ASYNCHRONOUSLY; if the sender (popup) closes
    // before that, Chrome logs "message channel closed before a response was
    // received". Every branch below responds synchronously (or is fire-and-forget),
    // so we return false (or nothing) — Chrome handles it without the warning.
    if (msg.type === "getStatus") {
      // Async: fetch tabs before responding so the popup gets a full snapshot
      // (connection + locks + open tabs) in one message. Returning true signals
      // Chrome we'll call respond() asynchronously.
      getOpenTabs().then((tabs) => {
        respond(buildStatusPayload(undefined, tabs));
      });
      return true; // async response
    }
    if (msg.type === "setPort") {
      respond(applyPort(msg.port));
      return false;
    }
    if (msg.type === "setToken") {
      respond(applyToken(msg.token));
      return false;
    }
    if (msg.type === "setEnrollment") {
      // The popup owns the user-facing entry of the enrollment secret. Persist,
      // re-pair, reconnect — all inside connection.js. The onMessage listener is
      // NOT async, so we .then() and return true (Chrome keeps the respond()
      // channel open for the async reply).
      applyEnrollment(msg.enrollment).then(() => {
        respond({ success: true });
      });
      return true; // async response — respond() fires from the .then()
    }
    if (msg.type === "unlockAll") {
      // Snapshot BEFORE unlockAll() — unlockAll clears the map, so reading after
      // would lose the list of tabs whose shields need removing.
      const prev = tabLocks.snapshot();
      tabLocks.unlockAll();
      persistSessionState();
      for (const { tabId } of prev) {
        tabControl.settle(tabId); // handed back: free now, not "controlled" for the linger
        hideLockShield(tabId);
      }
      broadcastStatus("All tab locks cleared");
      respond({ success: true });
      return false;
    }
    if (msg.type === "lockTab") {
      const owner = msg.sessionId;
      if (msg.tabId == null || !owner) {
        respond({ success: false, error: "tabId and sessionId required" });
        return false;
      }
      // lockTabUi is async (it awaits the shield injection) — keep Chrome's
      // respond() channel open for the async reply.
      lockTabUi(msg.tabId, owner, `Tab ${msg.tabId} pinned to ${owner}`)
        .then((shielded) => respond({ success: true, shielded }))
        .catch((err) =>
          respond({ success: false, error: err?.message || String(err) }),
        );
      return true;
    }
    if (msg.type === "unlockTab") {
      // { tabId } — release one tab's lock (vs unlockAll which clears all).
      if (msg.tabId == null) {
        respond({ success: false, error: "tabId required" });
        return false;
      }
      const was = releaseTabUi(msg.tabId);
      broadcastStatus(`Tab ${msg.tabId} unpinned (was ${was || "-"})`);
      respond({ success: true, previousSession: was || null });
      return false;
    }
    return false; // unrecognized message — no async response promised
  });

  // Network capture: id, duration and redacted headers per request
  // (lib/network-capture.js). Requests that never completed (DNS failure,
  // blocked, aborted, CORS…) arrive through onErrorOccurred.
  const capture = createNetworkCapture({
    store: (tabId, entry) => pushNetworkEntry(getTabBuffer(networkByTab, tabId), entry),
  });
  const allUrls = { urls: ["<all_urls>"] };
  // requestBody: POST/PUT payloads reach onBeforeRequest (a bounded, redacted preview is kept).
  chrome.webRequest.onBeforeRequest.addListener(capture.onBeforeRequest, allUrls, ["requestBody"]);
  chrome.webRequest.onSendHeaders.addListener(capture.onSendHeaders, allUrls, ["requestHeaders"]);
  chrome.webRequest.onCompleted.addListener(capture.onCompleted, allUrls, ["responseHeaders"]);
  chrome.webRequest.onErrorOccurred.addListener(capture.onErrorOccurred, allUrls);

  // A tab closing should release its lock and drop its buffers.
  // NOTE: no hideLockShield here — the tab/page is already gone, so a shield
  // inject would just throw (swallowed) and there is nothing to remove.
  chrome.tabs.onRemoved.addListener((tabId) => {
    dropTabState(tabId);
    persistSessionState();
  });

  // Re-inject the lock shield after a FULL navigation on a locked tab. A full
  // navigation destroys the injected DOM (new document), so without this the
  // page would be user-controllable again even though tabLocks still holds the
  // lock. A hash-only / SPA navigation does NOT reload the document, so the
  // shield survives and onUpdated does not fire a new 'complete' for it (see
  // isHashOnlyChange in utils/navigation.js + handleNavigate). showLockShield is
  // idempotent (the __bc-lock-shield guard), so re-injecting on a tab whose
  // shield is still present is a no-op. This module-level listener is SEPARATE
  // from the short-lived per-call listener inside handleNavigate — they share no
  // state and Chrome supports multiple onUpdated listeners (review NOTE 7c).
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === "loading") {
      dropDocumentState(tabId);
      persistSessionState();
    }
    if (changeInfo.status === "complete" && tabLocks.owner(tabId)) {
      showLockShield(tabId);
    }
  });
}
