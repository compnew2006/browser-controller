/**
 * Tool router (extracted from background.js): routes daemon WS messages to
 * handlers through the per-tab mutex + lock layer, and owns in-flight abort
 * controllers. The handler registry is a module-level constant — the old
 * dispatch() rebuilt a 22-entry object on every call.
 */
import { runOnTab as runOnTabLib } from './tab-concurrency.js';
import { tabLocks, tabMutex, persistSessionState } from './state.js';
import { sendJson, updateBadge, broadcastStatus, isWsConnected, setCurrentActivity } from './connection.js';
import { showOverlay, hideOverlay, hideLockShield } from './overlay.js';
import { getActiveTab, handleNavigate } from '../handlers/navigation.js';
import { handleClick, handleType, handlePressKey, handleHover, handleSelect, handleClickByText, handleDialog, handleDrag, handleFillForm } from '../handlers/interaction.js';
import { handleWait, handleScroll, handleSnapshot, handleFind, handleGetPageText, handleEvaluate } from '../handlers/inspection.js';
import { handleTabs, handleConsole, handleNetwork, handleScreenshot } from '../handlers/tabs.js';
import { handleRunAction, handleUploadFile } from '../handlers/cdp.js';

// sessionId arrives as a first-class top-level field on the WS message (audit
// M1) — the daemon no longer injects it into params. We read it here so the
// per-tab mutex + lock layer can attribute the call; it never reaches a tool
// handler. (Previously it was smuggled through params.__sessionId, which
// coupled the multiplexer to the extension's wire format.)

/**
 * In-flight call abort controllers, keyed by request id. The bridge forwards a
 * `cancel` control message when a call is aborted (client gone / timeout), and
 * the `cancel` handler aborts the matching controller so the in-flight handler
 * short-circuits and releases the tab mutex immediately. Without this, a slow
 * navigate (55s onUpdated wait) keeps the tab mutex pinned after the caller is
 * already gone, blocking every later call on the same tab. Set/cleared in
 * handleMessage's try/finally so it can't leak.
 */
const activeControllers = new Map();

// Static registry: built once at module load. Legacy wire-name aliases (find /
// get_page_text) are gone — the tool files send their canonical .name
// (browser_find / browser_text), so aliases would only mask future drift
// (audit C1).
const HANDLERS = {
  browser_navigate: handleNavigate,
  browser_click: handleClick,
  browser_type: handleType,
  browser_scroll: handleScroll,
  browser_press_key: handlePressKey,
  browser_wait: handleWait,
  browser_snapshot: handleSnapshot,
  browser_screenshot: handleScreenshot,
  browser_console: handleConsole,
  browser_network: handleNetwork,
  browser_tabs: handleTabs,
  browser_hover: handleHover,
  browser_select: handleSelect,
  browser_evaluate: handleEvaluate,
  browser_click_text: handleClickByText,
  browser_handle_dialog: handleDialog,
  browser_upload_file: handleUploadFile,
  browser_run_action: handleRunAction,
  browser_drag: handleDrag,
  browser_fill_form: handleFillForm,
  browser_find: handleFind,
  browser_text: handleGetPageText,
};

/** All tool names the router can dispatch (exported for the drift-guard test). */
export const dispatchedTools = Object.freeze(Object.keys(HANDLERS));

export async function dispatch(tool, params, sessionId, agentName, signal) {
  const handler = HANDLERS[tool];
  if (!handler) throw new Error(`Unknown tool: ${tool}`);
  return handler(params, sessionId, agentName, signal);
}

function sendResponse(id, response) {
  sendJson({ id, ...response });
}

/**
 * Unified error channel (architecture): handlers signal failure EITHER by
 * throwing OR by returning {success:false,...}. Both must reach the daemon as
 * wire-level failures so clients detect them uniformly — the in-band payload
 * (e.g. REF_GONE freshRefs) travels alongside as `result` so the tool layer
 * can surface it verbatim instead of a bare message.
 */
function sendToolResponse(id, result) {
  if (result && typeof result === 'object' && result.success === false) {
    sendResponse(id, {
      success: false,
      error: String(result.error || 'Tool failed'),
      result,
    });
  } else {
    sendResponse(id, { success: true, result });
  }
}

/** Which tabId does this call target? null = tab-agnostic (tabs list/create). */
function extractTabId(_tool, params) {
  return typeof params.tabId === 'number' ? params.tabId : null;
}

export async function handleMessage(msg) {
  // Control messages (non-tool) from the daemon. These carry a `type` and no
  // `tool`; handle them here before the tool-dispatch path assumes a tool call.
  if (msg.type === 'releaseSession') {
    // Session ids are unique even when two live clients share a display name.
    // Releasing one session therefore cannot unlock its sibling's tabs.
    const owner = msg.sessionId;
    if (owner) {
      // releaseByOwner is synchronous and returns the released tabIds before
      // any shield calls below run — no async race (review NOTE 7a).
      const released = tabLocks.releaseByOwner(owner);
      // Persist: without this, a service-worker recycle after the disconnect
      // would restore the just-released lock from session storage and
      // resurrect stale exclusivity (spec-review finding).
      persistSessionState();
      for (const tabId of released) hideLockShield(tabId);
      if (released.length) {
        broadcastStatus(`Released ${released.length} lock(s) from disconnected agent ${owner}`);
      }
    }
    return; // control message — no response expected
  }
  if (msg.type === 'cancel') {
    // The daemon/bridge aborted a call (client gone / timeout). Abort the
    // in-flight handler so it short-circuits and releases the tab mutex NOW —
    // otherwise a slow navigate (55s) blocks every later call on the same tab
    // even though the originating client is already gone. The handler's own
    // try/finally still runs (CDP detach, overlay hide), only its long await is
    // interrupted via the AbortSignal it was given.
    const cancelledId = msg.id;
    if (cancelledId && activeControllers.has(cancelledId)) {
      try { activeControllers.get(cancelledId).abort(); } catch { /* already settled */ }
    }
    return; // control message — no response expected
  }
  if (msg.type === 'ping') {
    // already handled in onmessage, but be defensive
    return;
  }

  const { id, tool, params } = msg;
  const p = { ...(params || {}) };
  const sessionId = msg.sessionId || null;
  const agentName = msg.agentName || null;

  // Resolve navigate's documented active-tab fallback before lock/mutex routing.
  // This freezes the target even if the user changes focus while the call waits.
  if (tool === 'browser_navigate' && typeof p.tabId !== 'number') {
    p.tabId = (await getActiveTab()).id;
  }
  const tabId = extractTabId(tool, p);

  // Tools without a tabId (tabs list/create, console-less) run directly.
  if (tabId == null) {
    const controller = new AbortController();
    activeControllers.set(id, controller);
    try {
      const result = await dispatch(tool, p, sessionId, agentName, controller.signal);
      sendToolResponse(id, result);
    } catch (err) {
      sendResponse(id, { success: false, error: err.message || String(err) });
    } finally {
      activeControllers.delete(id);
    }
    return;
  }

  // Acquire this tab's mutex and honor the unique session's lock ownership.
  const controller = new AbortController();
  activeControllers.set(id, controller);
  runOnTabLib(
    tabLocks,
    tabMutex,
    tabId,
    sessionId,
    async () => {
      setCurrentActivity(tool);
      updateBadge('active');
      await showOverlay(tabId, tool.replace('browser_', ''));
      try {
        const result = await dispatch(tool, p, sessionId, agentName, controller.signal);
        sendToolResponse(id, result);
      } catch (err) {
        sendResponse(id, { success: false, error: err.message || String(err) });
      } finally {
        setCurrentActivity(null);
        updateBadge(isWsConnected() ? 'connected' : 'disconnected');
        await hideOverlay(tabId);
      }
    },
  )
    .catch((err) => {
      sendResponse(id, { success: false, error: err.message || String(err) });
    })
    .finally(() => {
      activeControllers.delete(id);
    });
}
