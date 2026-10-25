/**
 * Tool router (extracted from background.js): routes daemon WS messages to
 * handlers through the per-tab mutex + lock layer, and owns in-flight abort
 * controllers. The handler registry is a module-level constant — the old
 * dispatch() rebuilt the tool map on every call.
 */
import { runOnTab as runOnTabLib, tabLockedMessage } from '../lib/tab-concurrency.js';
import {
  tabLocks, tabMutex, tabControl, persistSessionState, wedgedTabs, sessionAgentNames,
  releaseSessionSettings, claimTabSetting, releaseBodyCapture,
} from '../lib/state.js';
import { sendJson, updateBadge, broadcastStatus, isWsConnected, setCurrentActivity } from '../lib/connection.js';
import { showLockShield, hideLockShield } from '../lib/overlay.js';
import { getOpenDialog, dialogLabel } from '../lib/cdp-session.js';
import { handleNavigate } from '../handlers/navigation.js';
import { handleClick, handleType } from '../handlers/interaction.js';
import { handleFill, handleDialog } from '../handlers/interaction-advanced.js';
import { handleWait, handleScroll, handleSnapshot, handleGetPageText } from '../handlers/inspection.js';
import { handleEvaluate } from '../handlers/evaluate.js';
import { handleTabs } from '../handlers/tabs.js';
import { handleScreenshot } from '../handlers/screenshot.js';
import { handleEmulate, clearEmulation } from '../handlers/emulate.js';
import { handleLogs } from '../handlers/logs.js';
import { handleMock, releaseMock } from '../handlers/mock.js';
import { handleInspectElement } from '../handlers/inspect.js';
import { handleClassifyAction } from '../handlers/action-safety.js';
import { handleVaultAction, isPrivateVaultTab } from '../lib/vault-actions.js';

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
const activeVaultActions = new Map();

// Static registry: built once at module load. Legacy wire-name aliases are gone:
// the tool files send their canonical .name, so aliases would only mask future drift
// (audit C1).
const HANDLERS = {
  browser_navigate: handleNavigate,
  browser_tabs: handleTabs,
  browser_snapshot: handleSnapshot,
  browser_text: handleGetPageText,
  browser_screenshot: handleScreenshot,
  browser_click: handleClick,
  browser_type: handleType,
  browser_fill: handleFill,
  browser_scroll: handleScroll,
  browser_wait: handleWait,
  browser_evaluate: handleEvaluate,
  browser_handle_dialog: handleDialog,
  browser_emulate: handleEmulate,
  browser_logs: handleLogs,
  browser_mock: handleMock,
  browser_inspect_element: handleInspectElement,
  browser_classify_action: handleClassifyAction,
};

/** Public wire tools (exported for the drift-guard test); internal preflight stays private. */
export const dispatchedTools = Object.freeze(Object.keys(HANDLERS).filter((name) => name !== 'browser_classify_action'));

export async function dispatch(tool, params, sessionId, agentName, signal) {
  const handler = HANDLERS[tool];
  if (!handler) throw new Error(`Unknown tool: ${tool}`);
  return withDialogLine(params?.tabId, await handler(params, sessionId, agentName, signal));
}

/**
 * A success on a tab whose JavaScript dialog is open gets the `dialog:` line the input tools
 * give (a navigate whose page calls alert on load, say), unless its text already names the dialog.
 */
function withDialogLine(tabId, result) {
  const open = tabId == null ? null : getOpenDialog(tabId);
  const text = typeof result?.text === 'string' ? result.text : '';
  if (!open || !result || result.success === false || /^dialog: /m.test(text)) return result;
  const line = `dialog: ${dialogLabel(open)}`;
  return { ...result, text: text ? `${text}\n${line}` : line, dialog: open };
}

const OVERLAY_MS = 1_500;
function overlayStep(promise) {
  let timer;
  return Promise.race([promise, new Promise((r) => { timer = setTimeout(r, OVERLAY_MS); })])
    .catch(() => {})
    .finally(() => clearTimeout(timer));
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
  if (result && typeof result === "object" && result.success === false) {
    sendResponse(id, {
      success: false,
      error: String(result.error || "Tool failed"),
      result,
    });
  } else {
    sendResponse(id, { success: true, result });
  }
}

/** The error a call answers with when its caller cancelled it before it ran (X1). */
function cancelledError() {
  return new Error('TIMEOUT: the call was cancelled before it ran (its caller had left), so the tab was not touched');
}

/**
 * Clear one tab setting whose owner session was released (state.js claimTabSetting). Each kind
 * goes through the module that owns it. A tab already gone has nothing left to clear.
 */
function clearTabSetting(tabId, kind) {
  try {
    if (kind === 'mock') releaseMock(tabId);
    else if (kind === 'bodies') releaseBodyCapture(tabId);
    else if (kind === 'emulation') clearEmulation(tabId).catch(() => {}); // a failed clear: the tab is already gone or lost its session
  } catch { /* the tab is already gone */ }
}

/**
 * Record which session owns a tab setting after a call changed it (state.js claimTabSetting).
 * A call that only reads (no override or rule given) keeps the current owner. A call that
 * clears the setting drops the claim.
 */
function noteTabSetting(tool, params, sessionId, result) {
  if (!result || result.success === false || params.tabId == null) return;
  const { tabId } = params;
  if (tool === 'browser_mock' && params.rules !== undefined) {
    const cleared = Array.isArray(params.rules) && params.rules.length === 0;
    claimTabSetting(tabId, 'mock', cleared ? null : sessionId);
  } else if (tool === 'browser_emulate') {
    const changed = Object.keys(params).some((key) => key !== 'tabId' && params[key] !== undefined);
    const cleared = params.reset === true || !Object.keys(result.active ?? {}).length;
    if (changed) claimTabSetting(tabId, 'emulation', cleared ? null : sessionId);
  } else if (tool === 'browser_logs' && params.bodies !== undefined) {
    claimTabSetting(tabId, 'bodies', params.bodies === true && result.bodyCapture?.active ? sessionId : null);
  }
}

/** Which tabId does this call target? null = tab-agnostic (tabs list/create). */
function extractTabId(_tool, params) {
  return typeof params.tabId === "number" ? params.tabId : null;
}

/**
 * Whether a call's tab can take the show step. A frozen page cannot run it, and neither can a
 * page a JavaScript dialog blocks: the step would wait out its overlay budget for nothing.
 * The hide step does not use this: see the call's finally.
 */
const canDrawShield = (tabId) => !wedgedTabs.has(tabId) && !getOpenDialog(tabId);

const VAULT_TAB_ACTIONS = new Set(['inspect', 'fill']);
const vaultPermissionDenied = () => ({ success: false, code: 'VAULT_PERMISSION_DENIED' });

/** A malformed vault call is dropped before any work starts. */
function isVaultActionMessage(msg) {
  return typeof msg.id === 'string' && /^v\d+$/.test(msg.id) && typeof msg.action === 'string'
    && !!msg.params && typeof msg.params === 'object' && !Array.isArray(msg.params)
    && typeof msg.sessionId === 'string' && !!msg.sessionId;
}

function vaultErrorCode(error) {
  const message = error instanceof Error ? error.message : '';
  return /^VAULT_[A-Z_]+/.exec(message)?.[0] || 'VAULT_PERMISSION_DENIED';
}

/** A tab-bound vault action holds that tab's lock and shows it busy, like any other call. */
function runVaultActionInTab(params, sessionId, agentName, controller, action) {
  return runOnTabLib(tabLocks, tabMutex, params.tabId, sessionId, async () => {
    if (controller.signal.aborted) return vaultPermissionDenied();
    const call = tabControl.begin(params.tabId, sessionId, typeof agentName === 'string' ? agentName : 'Credential vault');
    try {
      setCurrentActivity('credential vault');
      updateBadge('active');
      return await action();
    } finally {
      setCurrentActivity(null);
      updateBadge(isWsConnected() ? 'connected' : 'disconnected');
      tabControl.end(call);
    }
  });
}

async function handleVaultMessage(msg) {
  if (msg.type === 'vaultActionCancel') {
    if (typeof msg.id === 'string') activeVaultActions.get(msg.id)?.abort();
    return;
  }
  if (!isVaultActionMessage(msg)) return;
  const controller = new AbortController();
  activeVaultActions.set(msg.id, controller);
  const action = async () => (controller.signal.aborted
    ? vaultPermissionDenied()
    : handleVaultAction(msg.action, msg.params, controller.signal));
  try {
    const result = VAULT_TAB_ACTIONS.has(msg.action) && Number.isInteger(msg.params.tabId)
      ? await runVaultActionInTab(msg.params, msg.sessionId, msg.agentName, controller, action)
      : await action();
    sendJson({ type: 'vaultActionResponse', id: msg.id, success: true, result });
  } catch (error) {
    sendJson({ type: 'vaultActionResponse', id: msg.id, success: true, result: { success: false, code: vaultErrorCode(error) } });
  } finally {
    activeVaultActions.delete(msg.id);
  }
}

export async function handleMessage(msg) {
  if (msg.type === 'vaultAction' || msg.type === 'vaultActionCancel') {
    await handleVaultMessage(msg);
    return;
  }
  // Control messages (non-tool) from the daemon. These carry a `type` and no
  // `tool`; handle them here before the tool-dispatch path assumes a tool call.
  if (msg.type === "releaseSession") {
    // Session ids are unique even when two live clients share a display name.
    // Releasing one session therefore cannot unlock its sibling's tabs.
    const owner = msg.sessionId;
    if (owner) {
      // releaseByOwner is synchronous and returns the released tabIds before
      // any shield calls below run — no async race (review NOTE 7a).
      const released = tabLocks.releaseByOwner(owner);
      tabControl.releaseByOwner(owner); // a gone agent no longer "controls" anything
      // Tab settings it set (mock rules, emulation overrides, body capture) go with it (L1).
      for (const { tabId, kind } of releaseSessionSettings(owner)) clearTabSetting(tabId, kind);
      sessionAgentNames.delete(owner);
      // Persist: without this, a service-worker recycle after the disconnect
      // would restore the just-released lock from session storage and
      // resurrect stale exclusivity (spec-review finding).
      persistSessionState();
      for (const tabId of released) hideLockShield(tabId);
      if (released.length) {
        broadcastStatus(
          `Released ${released.length} lock(s) from disconnected agent ${owner}`,
        );
      }
    }
    return; // control message — no response expected
  }
  if (msg.type === "cancel") {
    // The daemon/bridge aborted a call (client gone / timeout). Abort the
    // in-flight handler so it short-circuits and releases the tab mutex NOW —
    // otherwise a slow navigate (55s) blocks every later call on the same tab
    // even though the originating client is already gone. The handler's own
    // try/finally still runs (CDP detach, overlay hide), only its long await is
    // interrupted via the AbortSignal it was given.
    const cancelledId = msg.id;
    if (cancelledId && activeControllers.has(cancelledId)) {
      try {
        activeControllers.get(cancelledId).abort();
      } catch {
        /* already settled */
      }
    }
    return; // control message — no response expected
  }
  if (msg.type === "ping") {
    // already handled in onmessage, but be defensive
    return;
  }

  const { id, tool, params } = msg;
  const p = { ...(params || {}) };
  const sessionId = msg.sessionId || null;
  const agentName = msg.agentName || null;
  // Remember who a session is: a lock it takes is then shown to others by name.
  if (sessionId && agentName) sessionAgentNames.set(sessionId, agentName);

  // navigate without tabId opens a tab of its own (handleNavigate): there is no
  // tab to queue on or lock-check yet, so it runs with the tab-less calls below.
  const tabId = extractTabId(tool, p);

  // A tool call without an id can never be answered: it used to collide in
  // activeControllers under key `undefined` (aborting the wrong controller)
  // and leave the caller hanging until its timeout. Refuse it up front —
  // raw-WS clients only; the daemon always sends ids.
  if (id === undefined || id === null) {
    sendResponse(null, { success: false, error: 'tool call is missing id — no response can be correlated' });
    return;
  }

  if (Number.isInteger(tabId) && isPrivateVaultTab(tabId)) {
    sendResponse(id, { success: false, error: 'VAULT_CONTEXT_PROTECTED: The private credential vault page is unavailable to browser tools.' });
    return;
  }

  // ESCAPE HATCH (field report: frozen-tab deadlock): tabs close/focus must
  // NEVER queue behind the per-tab mutex. A page frozen by a native dialog
  // (GWT-style) pins its mutex forever — an in-flight executeScript can't be
  // aborted — so anything routed through runOnTab on that tab deadlocks,
  // including close (which needs NO page cooperation: chrome.tabs.remove)
  // and even handle_dialog. Close/focus retain their ownership checks inside
  // handleTabs; dialog handling uses CDP directly and must reach the native
  // prompt without waiting for page execution to settle.
  // A wedged tab's queue may still hold calls waiting on a frozen page:
  // navigate/reload are the recovery path and need no page cooperation.
  const bypassesMutex = (tool === 'browser_tabs' && (p.action === 'close' || p.action === 'focus'))
    || tool === 'browser_handle_dialog'
    || (tool === 'browser_navigate' && wedgedTabs.has(tabId));

  // Skipping the queue must not skip lock ownership: runOnTab enforces it for
  // queued calls, so the frozen-tab navigate and the dialog paths check it here
  // (a plain in-memory lookup, so it cannot wait on a frozen page).
  if ((tool === 'browser_navigate' || tool === 'browser_handle_dialog') && bypassesMutex) {
    const owner = tabLocks.owner(tabId);
    if (owner && owner !== sessionId) {
      sendResponse(id, { success: false, error: tabLockedMessage(tabId, tabLocks.grantOf(tabId)) });
      return;
    }
  }

  // Tools without a tabId (tabs list/create, console-less) run directly.
  if (tabId == null || bypassesMutex) {
    const controller = new AbortController();
    activeControllers.set(id, controller);
    // tabs close/focus/reload and dialogs name a tab but skip the queue: they
    // still count as the agent acting on it (tabs list/create have no tab).
    // Skipping the queue also skips runOnTab's ownership gate, so a caller the
    // tab's lock would refuse is not recorded as its controller.
    const lockOwner = tabId == null ? undefined : tabLocks.owner(tabId);
    const call = tabId != null && (lockOwner === undefined || lockOwner === sessionId)
      ? tabControl.begin(tabId, sessionId, agentName)
      : null;
    try {
      const result = await dispatch(
        tool,
        p,
        sessionId,
        agentName,
        controller.signal,
      );
      sendToolResponse(id, result);
    } catch (err) {
      sendResponse(id, { success: false, error: err.message || String(err) });
    } finally {
      activeControllers.delete(id);
      tabControl.end(call);
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
      // X1: a call its caller cancelled while it queued behind the tab's mutex never runs.
      if (controller.signal.aborted) throw cancelledError();
      // Record that this agent is acting on the tab so the popup's Open Tabs
      // list shows it as controlled rather than "free" (a plain call takes no
      // lock). Started only once the call really runs, not while it queues;
      // the outer finally ends it whatever the rest of this task throws.
      const call = tabControl.begin(tabId, sessionId, agentName);
      try {
        setCurrentActivity(tool);
        updateBadge('active');
        // Agent control shows the blue input-blocking spectrum for this call only;
        // the label names the AGENT (user request: "agent {name} controlling the tab"), not the
        // running tool. agentName is a top-level WS field (audit M1); fall back
        // to a generic label for anonymous direct-WS callers.
        // Best effort and bounded: the shield is cosmetic, a frozen page must not block the tool.
        if (canDrawShield(tabId)) {
          await overlayStep(showLockShield(tabId, agentName ? `agent ${agentName} controlling the tab` : 'agent controlling the tab'));
        }
        try {
          // The shield step above can take a while: check again before the handler sends anything.
          if (controller.signal.aborted) throw cancelledError();
          const result = await dispatch(tool, p, sessionId, agentName, controller.signal);
          sendToolResponse(id, result);
          noteTabSetting(tool, p, sessionId, result);
        } catch (err) {
          sendResponse(id, { success: false, error: err.message || String(err) });
        } finally {
          setCurrentActivity(null);
          updateBadge(isWsConnected() ? 'connected' : 'disconnected');
          // The frame lasts for this call only, locked or not. A wedged page cannot run the
          // removal; its next document drops the frame. A JavaScript dialog open now may be one
          // this call opened: it blocks the removal until it is answered, so the removal goes out
          // without an await. The call answers and frees the tab, and chrome.scripting runs the
          // removal once the dialog closes. Otherwise the removal is awaited within the overlay budget.
          if (!wedgedTabs.has(tabId)) {
            if (getOpenDialog(tabId)) hideLockShield(tabId).catch(() => {});
            else await overlayStep(hideLockShield(tabId));
          }
        }
      } finally {
        tabControl.end(call);
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
