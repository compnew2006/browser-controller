/**
 * Per-tab state + concurrency instances (extracted from background.js —
 * architecture item: the 2000+ line service worker is now a set of focused ES
 * modules; this one owns ALL mutable cross-handler state so every other
 * module stays stateless-in-itself).
 *
 *   - network buffers are per-tab (capped PER_TAB_CAP). They remain in-memory
 *     debug aids: Chrome can recycle the worker at any moment, and the agent
 *     can always re-read after the page makes new requests. (Console messages
 *     are not buffered here: Chrome keeps them, see lib/browser-log.js.)
 *   - tabLocks + fallbackByTab ARE durably persisted to chrome.storage.session
 *     (MV3 lifetime): a recycle used to silently drop lock ownership (an
 *     agent's exclusivity guarantee) and smart-selector fallbacks. session
 *     storage is wiped when the browser closes, which is exactly the right
 *     lifetime for both. See loadSessionState/persistSessionState.
 */
import { TabMutexMap, TabLockMap, TabControlMap } from './tab-concurrency.js';
import { unpinCdp } from './cdp-session.js';

export const PER_TAB_CAP = 200;
// Response cap for unbounded result tools (browser_evaluate). browser_text
// caps at maxLength (default 5000), but evaluate returned arbitrarily large
// payloads — JSON.stringify(document.body.innerHTML) came back in full.
export const MAX_RESULT_CHARS = 100_000;

/** @type {Map<number, Array<object>>} */
export const networkByTab = new Map();
/**
 * browser_logs bodies: tabId -> { bodies (lib/response-bodies.js),
 * unsubscribe (CDP events; null once stopped) }. In memory, like the buffers.
 * @type {Map<number, {bodies: object, unsubscribe: (() => void) | null}>}
 */
export const bodyCaptureByTab = new Map();
/**
 * browser_mock rules: tabId -> { rules, off, send }. off and send are set while the tab's Fetch
 * interception is attached (lib/cdp-session.js subscription). Owned by handlers/mock.js.
 * @type {Map<number, {rules: object[], off?: () => void, send?: Function}>}
 */
export const mockByTab = new Map();
/** CDP pin reason of a response-body capture (handlers/logs.js starts and pins it). */
export const BODY_CAPTURE_PIN = 'network-bodies';
/**
 * Smart-selector fallbacks (plan tasks 2–4). Map<tabId, Map<ref, fallback>>.
 * Populated at snapshot time; consumed by click/type when a ref no longer
 * resolves. Never sent to the agent — it keeps payloads token-cheap.
 * @type {Map<number, Map<string, object>>}
 */
export const fallbackByTab = new Map();
/**
 * The highest ref number each tab's documents have shown the agent (Map<tabId, n>). Refs are
 * per document, so a new document's counter starts above this (lib/page-dom.js
 * PAGE_DOM_INSTALL): a ref from an earlier page can never name an element of this one.
 * Kept across navigations (the next document needs it); dropped with the tab.
 */
export const refHighWaterByTab = new Map();
/** The counter base a new document of this tab starts from. */
export function refBaseFor(tabId) {
  return refHighWaterByTab.get(tabId) || 0;
}
/** Record the refs a page result showed (`highest`: their largest number); persisted when it moves up. */
export function noteRefsShown(tabId, highest) {
  if (!(highest > (refHighWaterByTab.get(tabId) || 0))) return;
  refHighWaterByTab.set(tabId, highest);
  persistSessionState();
}
/**
 * Tabs whose page stopped answering chrome.scripting (frozen main thread, a
 * giant document). Map<tabId, sinceMs>. While a tab is here every page call
 * first probes it with a short timeout and fails fast with TAB_WEDGED instead
 * of queueing behind executeScript calls that can never be aborted.
 * Cleared when the tab starts a new navigation or is closed.
 */
export const wedgedTabs = new Map();

// --- Per-tab mutex (task 2.1) + per-agent tab locks (task 2.2) ------------
// Pure, unit-tested primitives in lib/tab-concurrency.js.
export const tabMutex = new TabMutexMap();
export const windowCaptureMutex = new TabMutexMap();
/** sessionId -> agent name, recorded by the router on each call (names the owner in TAB_LOCKED). */
export const sessionAgentNames = new Map();
export const tabLocks = new TabLockMap({ nameOf: (sessionId) => sessionAgentNames.get(sessionId) });
// Which agent is acting on a tab (in-flight + a short linger). In-memory only:
// it is a live indicator for the popup, not a guarantee, so a worker recycle
// may drop it harmlessly. Not exclusive — see TabControlMap.
export const tabControl = new TabControlMap();

/**
 * Tabs replaced by another tab (Map<oldTabId, newTabId>): a frozen tab that browser_navigate
 * swapped out, or a tab Chrome replaced (discard, prerender). A tab id is never reused, so an
 * entry does not go stale. Kept to MAX_REPLACED_TABS entries; in memory, so a worker restart
 * forgets them and the old id then fails TAB_NOT_FOUND.
 */
const replacedTabs = new Map();
const MAX_REPLACED_TABS = 200;

/**
 * The tab that `tabId` was replaced by, following a chain (replaced twice: the last tab).
 * Undefined when the tab was never replaced.
 */
export function replacementOf(tabId) {
  let id = tabId;
  for (let hops = 0; replacedTabs.has(id) && hops < MAX_REPLACED_TABS; hops++) id = replacedTabs.get(id);
  return id === tabId ? undefined : id;
}

/**
 * A tab was replaced by a new one in the same place. The new tab takes over the old one's lock,
 * control and wedge mark, so the owning session keeps it and the popup does not list it as free.
 */
export function followReplacedTab(fromTabId, toTabId) {
  replacedTabs.set(fromTabId, toTabId);
  if (replacedTabs.size > MAX_REPLACED_TABS) replacedTabs.delete(replacedTabs.keys().next().value);
  wedgedTabs.delete(fromTabId);
  const grant = tabLocks.grantOf(fromTabId);
  if (grant) {
    tabLocks.release(fromTabId);
    tabLocks.lock(toTabId, grant.sessionId, { agentName: grant.agentName, since: grant.since });
  }
  tabControl.move(fromTabId, toTabId);
  persistSessionState();
}

// The daemon instance (hello.instanceId) this worker last adopted. Locks are
// only valid for the daemon that granted them; connection.js
// adoptDaemonInstance() compares against this and releases the stale ones.
let adoptedDaemonInstance = null;
export function getAdoptedDaemonInstance() {
  return adoptedDaemonInstance;
}
export function setAdoptedDaemonInstance(instanceId) {
  adoptedDaemonInstance = instanceId;
}

export function getTabBuffer(map, tabId) {
  let arr = map.get(tabId);
  if (!arr) {
    arr = [];
    map.set(tabId, arr);
  }
  return arr;
}

// --- Session-owned tab settings ---------------------------------------------
// browser_mock rules ('mock'), browser_emulate overrides ('emulation') and browser_logs
// response bodies ('bodies') outlive the call that set them. The session that set one last
// owns it: its release (releaseSession) clears it, and a closed tab forgets it. Another
// session's setting is never touched. Ownership is per tab and kind, so the last setter wins.
/** @type {Map<number, Map<string, string>>} tabId -> kind -> sessionId */
const settingOwners = new Map();

/** `sessionId` set `kind` on `tabId`. An anonymous caller (no session) clears the claim: nobody owns it. */
export function claimTabSetting(tabId, kind, sessionId) {
  let kinds = settingOwners.get(tabId);
  if (!kinds) {
    kinds = new Map();
    settingOwners.set(tabId, kinds);
  }
  if (sessionId) kinds.set(kind, sessionId);
  else kinds.delete(kind);
}

/** The session that owns `kind` on `tabId`, or undefined. */
export function tabSettingOwner(tabId, kind) {
  return settingOwners.get(tabId)?.get(kind);
}

/**
 * Take every setting `sessionId` owns, forgetting its claims. Returns [{tabId, kind}] for the
 * caller to clear. Synchronous, like TabLockMap.releaseByOwner.
 * @returns {Array<{tabId: number, kind: string}>}
 */
export function releaseSessionSettings(sessionId) {
  const released = [];
  if (!sessionId) return released;
  for (const [tabId, kinds] of settingOwners) {
    for (const [kind, owner] of kinds) {
      if (owner !== sessionId) continue;
      kinds.delete(kind);
      released.push({ tabId, kind });
    }
    if (!kinds.size) settingOwners.delete(tabId);
  }
  return released;
}

/**
 * Stop a tab's response-body capture: its listener, its bodies and its pin on the debugger
 * session (the session may then detach when idle).
 */
export function releaseBodyCapture(tabId) {
  bodyCaptureByTab.get(tabId)?.unsubscribe?.();
  bodyCaptureByTab.delete(tabId);
  unpinCdp(tabId, BODY_CAPTURE_PIN);
}

// --- MV3 session persistence (architecture item) ---------------------------

const SESSION_STATE_KEY = "bcSessionState";
/**
 * A worker woken by a tab event can run listeners before loadSessionState() has read
 * storage. Writing then would overwrite the stored locks with the empty in-memory state
 * (X3). Until the load completes, a persist is deferred and flushed right after the load,
 * and a tab closed meanwhile is not restored from storage.
 */
let sessionStateLoaded = false;
let persistDeferred = false;
/** @type {Set<number>} */
const closedBeforeLoad = new Set();

/**
 * Persist lock ownership + smart-selector fallbacks to chrome.storage.session.
 * Called after every mutation (cheap: the payload is small). Failures are
 * swallowed — persistence is a best-effort durability upgrade, never a
 * correctness gate on the mutation itself.
 */
export function persistSessionState() {
  if (!sessionStateLoaded) {
    persistDeferred = true;
    return;
  }
  try {
    const fallbacks = {};
    for (const [tabId, map] of fallbackByTab) {
      fallbacks[tabId] = Object.fromEntries(map);
    }
    chrome.storage.session.set({
      [SESSION_STATE_KEY]: {
        locks: tabLocks.snapshot(),
        daemonInstance: adoptedDaemonInstance,
        fallbacks,
        refHighWater: Object.fromEntries(refHighWaterByTab),
      },
    }).catch(() => {});
  } catch { /* storage unavailable — in-memory behavior */ }
}

/**
 * Restore locks + fallbacks after a service-worker recycle. Must complete
 * BEFORE the WS connect (so the shield sweep honors restored owners) and
 * before any tool call (so lock routing sees the real ownership).
 */
export async function loadSessionState() {
  try {
    const stored = await chrome.storage.session.get(SESSION_STATE_KEY);
    const state = stored?.[SESSION_STATE_KEY];
    if (!state) return;
    if (typeof state.daemonInstance === 'string') adoptedDaemonInstance = state.daemonInstance;
    if (Array.isArray(state.locks)) {
      for (const { tabId, sessionId, agentName, since } of state.locks) {
        if (closedBeforeLoad.has(tabId)) continue; // the tab closed before its lock was read
        // lock() refuses to steal: a stale entry for a tab another live session
        // re-locked is impossible here (we're the only instance), but the guard
        // costs nothing.
        try {
          tabLocks.lock(tabId, sessionId, { agentName: agentName ?? undefined, since: typeof since === 'number' ? since : undefined });
        } catch {}
      }
    }
    if (state.refHighWater && typeof state.refHighWater === "object") {
      for (const [tabId, n] of Object.entries(state.refHighWater)) {
        if (Number.isInteger(n) && n > 0 && !closedBeforeLoad.has(Number(tabId))) refHighWaterByTab.set(Number(tabId), n);
      }
    }
    if (state.fallbacks && typeof state.fallbacks === "object") {
      for (const [tabId, entries] of Object.entries(state.fallbacks)) {
        if (entries && typeof entries === "object" && !closedBeforeLoad.has(Number(tabId))) {
          fallbackByTab.set(Number(tabId), new Map(Object.entries(entries)));
        }
      }
    }
  } catch { /* storage unavailable — start empty, as before */ } finally {
    sessionStateLoaded = true;
    closedBeforeLoad.clear();
    if (persistDeferred) {
      persistDeferred = false;
      persistSessionState();
    }
  }
}

/** Invalidate document-bound refs without releasing the tab's durable lock. */
export function dropDocumentState(tabId) {
  wedgedTabs.delete(tabId);
  fallbackByTab.delete(tabId);
}

/**
 * Drop one tab's durable state (tab closed). Its mock rules go with it: the listener is
 * unsubscribed, so nothing keeps answering on a dead tab (X15).
 */
export function dropTabState(tabId) {
  wedgedTabs.delete(tabId);
  networkByTab.delete(tabId);
  bodyCaptureByTab.get(tabId)?.unsubscribe?.();
  bodyCaptureByTab.delete(tabId);
  fallbackByTab.delete(tabId);
  refHighWaterByTab.delete(tabId);
  const mock = mockByTab.get(tabId);
  mockByTab.delete(tabId);
  mock?.off?.();
  settingOwners.delete(tabId);
  tabLocks.release(tabId);
  tabControl.release(tabId);
  if (!sessionStateLoaded) closedBeforeLoad.add(tabId);
}
