/**
 * Per-tab state + concurrency instances (extracted from background.js —
 * architecture item: the 2000+ line service worker is now a set of focused ES
 * modules; this one owns ALL mutable cross-handler state so every other
 * module stays stateless-in-itself).
 *
 *   - console/network buffers are per-tab (capped PER_TAB_CAP). These remain
 *     in-memory debug aids: Chrome can recycle the worker at any moment, and
 *     the agent can always re-read after the page emits new messages.
 *   - tabLocks + fallbackByTab ARE durably persisted to chrome.storage.session
 *     (MV3 lifetime): a recycle used to silently drop lock ownership (an
 *     agent's exclusivity guarantee) and smart-selector fallbacks. session
 *     storage is wiped when the browser closes, which is exactly the right
 *     lifetime for both. See loadSessionState/persistSessionState.
 */
import { TabMutexMap, TabLockMap } from './tab-concurrency.js';

export const PER_TAB_CAP = 200;
// Response cap for unbounded result tools (evaluate/run_action). browser_text
// caps at maxLength (default 5000), but these two returned arbitrarily large
// payloads — JSON.stringify(document.body.innerHTML) came back in full.
export const MAX_RESULT_CHARS = 100_000;

/** @type {Map<number, Array<{level:string,text:number,timestamp:number,url:string}>>} */
export const consoleByTab = new Map();
/** @type {Map<number, Array<object>>} */
export const networkByTab = new Map();
/**
 * Smart-selector fallbacks (plan tasks 2–4). Map<tabId, Map<ref, fallback>>.
 * Populated at snapshot time; consumed by click/type when a ref no longer
 * resolves. Never sent to the agent — it keeps payloads token-cheap.
 * @type {Map<number, Map<string, object>>}
 */
export const fallbackByTab = new Map();
/**
 * isNew feature: Map<tabId, string[]> of "fingerprints" (role|name) from the
 * PREVIOUS snapshot. The next snapshot marks any ref whose fingerprint isn't
 * in this set as `isNew: true`, so the agent can focus on what changed.
 * @type {Map<number, string[]>}
 */
export const lastSnapshotFingerprints = new Map();

// --- Per-tab mutex (task 2.1) + per-agent tab locks (task 2.2) ------------
// Pure, unit-tested primitives in lib/tab-concurrency.js.
export const tabMutex = new TabMutexMap();
export const windowCaptureMutex = new TabMutexMap();
export const tabLocks = new TabLockMap();

export function getTabBuffer(map, tabId) {
  let arr = map.get(tabId);
  if (!arr) {
    arr = [];
    map.set(tabId, arr);
  }
  return arr;
}

export function pushCapped(arr, item, cap = PER_TAB_CAP) {
  arr.push(item);
  if (arr.length > cap) arr.splice(0, arr.length - cap);
}

// --- MV3 session persistence (architecture item) ---------------------------

const SESSION_STATE_KEY = 'bcSessionState';

/**
 * Persist lock ownership + smart-selector fallbacks to chrome.storage.session.
 * Called after every mutation (cheap: the payload is small). Failures are
 * swallowed — persistence is a best-effort durability upgrade, never a
 * correctness gate on the mutation itself.
 */
export function persistSessionState() {
  try {
    const fallbacks = {};
    for (const [tabId, map] of fallbackByTab) {
      fallbacks[tabId] = Object.fromEntries(map);
    }
    chrome.storage.session.set({
      [SESSION_STATE_KEY]: { locks: tabLocks.snapshot(), fallbacks },
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
    if (Array.isArray(state.locks)) {
      for (const { tabId, sessionId } of state.locks) {
        // lock() refuses to steal: a stale entry for a tab another live session
        // re-locked is impossible here (we're the only instance), but the guard
        // costs nothing.
        try { tabLocks.lock(tabId, sessionId); } catch {}
      }
    }
    if (state.fallbacks && typeof state.fallbacks === 'object') {
      for (const [tabId, entries] of Object.entries(state.fallbacks)) {
        if (entries && typeof entries === 'object') {
          fallbackByTab.set(Number(tabId), new Map(Object.entries(entries)));
        }
      }
    }
  } catch { /* storage unavailable — start empty, as before */ }
}

/** Drop one tab's durable state (tab closed). */
export function dropTabState(tabId) {
  consoleByTab.delete(tabId);
  networkByTab.delete(tabId);
  fallbackByTab.delete(tabId);
  lastSnapshotFingerprints.delete(tabId);
  tabLocks.release(tabId);
}
