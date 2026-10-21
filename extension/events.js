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
import { hideLockShield } from "./lib/overlay.js";
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
      try {
        lockTabUi(msg.tabId, owner, `Tab ${msg.tabId} pinned to ${owner}`);
        respond({ success: true });
      } catch (err) {
        respond({ success: false, error: err?.message || String(err) });
      }
      return false;
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

  watchOpenedTabs();

  // A loading tab drops its per-document state. No shield is re-injected after
  // a navigation: the shield exists only while a tool call runs, and that call
  // removes it when it ends.
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === "loading") {
      dropDocumentState(tabId);
      persistSessionState();
    }
  });
}

/**
 * A tab that an agent's own tab opens (a target=_blank link, window.open) is that agent's
 * tab too, so browser_tabs lists it as [own]. Chrome makes such a tab the active one, which
 * took the user away from the tab they were on: when that tab was not the source itself (the
 * user was not looking at the agent's tab), it is made active again. The source comes from
 * webNavigation: a tab's openerTabId is the window's active tab when the source is in the
 * background, not the tab that opened it.
 */
function watchOpenedTabs() {
  // The active tab of each window, and the one before it (the new tab is activated before it is reported).
  const active = new Map();
  // A worker that just started has seen no activation yet: it starts from the tabs active now.
  chrome.tabs.query({ active: true }).then((tabs) => {
    for (const t of tabs) if (!active.has(t.windowId)) active.set(t.windowId, { current: t.id, previous: null });
  }).catch(() => {});
  chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
    const was = active.get(windowId);
    active.set(windowId, { current: tabId, previous: was?.current ?? null });
  });
  chrome.webNavigation.onCreatedNavigationTarget.addListener(async ({ sourceTabId, tabId }) => {
    const owner = tabLocks.owner(sourceTabId);
    if (owner === undefined) return;
    try {
      lockTabUi(tabId, owner, `Tab ${tabId} opened by tab ${sourceTabId}, locked to its owner`);
    } catch {
      return; // already another session's
    }
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const seen = tab && active.get(tab.windowId);
    const userTab = seen && (seen.current === tabId ? seen.previous : seen.current);
    if (tab?.active && userTab != null && userTab !== sourceTabId) chrome.tabs.update(userTab, { active: true }).catch(() => {});
  });
}
