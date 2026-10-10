/**
 * Pure tab-concurrency primitives (plan tasks 2.1 + 2.2), framework-free so they
 * can be unit-tested with vitest WITHOUT a Chrome instance.
 *
 *   - {@link TabMutexMap}: one promise-chain per tabId. Calls to the SAME tab
 *     serialize; calls to DIFFERENT tabs run in parallel. (2.1)
 *   - {@link TabLockMap}: per-agent ownership of a tab. A call from a non-owner
 *     session waits (queues) until the owner releases. (2.2)
 *
 * background.js wires these together via runOnTab(); the vitest suite in
 * tests/tab-concurrency.test.ts proves the ordering guarantees.
 */

export class TabMutexMap {
  constructor() {
    /** @type {Map<number, Promise<void>>} */
    this.queues = new Map();
  }

  /**
   * Run `fn` serialized for `tabId`: at most one fn per tab runs at a time.
   * Different tabIds run concurrently. Resolves/rejects with fn's result.
   * @param {number} tabId
   * @param {() => (Promise<unknown> | unknown)} fn
   * @returns {Promise<unknown>}
   */
  run(tabId, fn) {
    const prev = this.queues.get(tabId) || Promise.resolve();
    const next = prev.then(fn, fn);
    // Swallow rejection on the stored chain so a later call isn't poisoned,
    // but the returned `next` still surfaces the real error to the caller.
    const settled = next.then(
      () => {},
      () => {},
    );
    this.queues.set(tabId, settled);
    // Leak fix: once this chain settles, drop the entry IF it's still ours.
    // A later run() may have chained onto `settled` and replaced the map value —
    // in that case `settled !== current`, and deleting would break the newer
    // chain's serialization. The identity check makes this safe. Without this,
    // every tab's first run() left a permanent entry → memory leak + isIdle()
    // returned false forever after the first call.
    settled.then(() => {
      if (this.queues.get(tabId) === settled) {
        this.queues.delete(tabId);
      }
    });
    return next;
  }

  /** For tests: whether anything is currently pending for a tab. */
  isIdle(tabId) {
    return !this.queues.has(tabId);
  }
}

export class TabLockMap {
  constructor() {
    /** @type {Map<number, string>} tabId -> sessionId */
    this.locks = new Map();
    /** lock-wait timeout so a forgotten lock can't hang a caller forever */
    this.acquireTimeoutMs = 30_000;
  }

  /** Who owns tabId, or undefined if unlocked. */
  owner(tabId) {
    return this.locks.get(tabId);
  }

  /** Claim tabId for sessionId without stealing another session's lock. */
  lock(tabId, sessionId) {
    const owner = this.locks.get(tabId);
    if (owner !== undefined && owner !== sessionId) {
      throw new Error(`Tab ${tabId} is already locked by ${owner}`);
    }
    this.locks.set(tabId, sessionId);
  }

  /** Release tabId only when the caller owns it. */
  unlock(tabId, sessionId) {
    if (this.locks.get(tabId) === sessionId) {
      this.locks.delete(tabId);
    }
  }

  /** Release tabId unconditionally (used when the tab is closed). */
  release(tabId) {
    this.locks.delete(tabId);
  }

  /**
   * Release every tab locked to `sessionId`. Called when an agent disconnects
   * (daemon close handler → bridge → extension) so a crashed/quit agent doesn't
   * leave orphaned locks that block other agents forever. Returns the tabIds
   * that were released (empty if the session owned nothing).
   * @param {string} sessionId
   * @returns {number[]}
   */
  releaseByOwner(sessionId) {
    const released = [];
    for (const [tabId, owner] of this.locks) {
      if (owner === sessionId) {
        this.locks.delete(tabId);
        released.push(tabId);
      }
    }
    return released;
  }

  /** @returns {Array<{tabId:number,sessionId:string}>} serializable snapshot. */
  snapshot() {
    return Array.from(this.locks.entries()).map(([tabId, sessionId]) => ({ tabId, sessionId }));
  }

  /** Release all locks. */
  unlockAll() {
    this.locks.clear();
  }

  /**
   * Wait until tabId is unlocked OR owned by sessionId (i.e. this session may
   * proceed). Resolves immediately if already eligible; otherwise polls.
   * @returns {Promise<void>}
   */
  async waitFor(tabId, sessionId) {
    if (sessionId == null) return; // no session → no locking semantics
    const owner = this.locks.get(tabId);
    if (owner === undefined || owner === sessionId) return;

    const start = Date.now();
    return new Promise((resolve, reject) => {
      const tick = () => {
        const cur = this.locks.get(tabId);
        if (cur === undefined || cur === sessionId) {
          resolve();
        } else if (Date.now() - start > this.acquireTimeoutMs) {
          reject(new Error(`Timed out waiting for tab ${tabId} lock owned by ${cur}`));
        } else {
          setTimeout(tick, 50);
        }
      };
      tick();
    });
  }
}

/**
 * Who is ACTING on a tab right now (or just was). Unlike {@link TabLockMap} this
 * is not exclusive ownership and never blocks anyone: it only records agent
 * activity so the popup can show a tab an agent is driving as "controlled"
 * instead of "free" (a plain call never creates a lock, so tabLocks alone says
 * "free" for a tab that is being clicked and typed into). An entry counts as
 * active while a call is in flight and for `lingerMs` after the last call
 * ended, which bridges the gap while the agent thinks between calls.
 *
 * Each begin() returns a handle for its own call and end() takes that handle,
 * so releasing a tab or a session mid-call can never make a stale end()
 * miscount a newer call on the same tab.
 */
export const CONTROL_LINGER_MS = 30_000;

export class TabControlMap {
  /**
   * @param {number} [lingerMs]
   * @param {() => number} [now] injectable clock (unit tests)
   */
  constructor(lingerMs = CONTROL_LINGER_MS, now = Date.now) {
    this.lingerMs = lingerMs;
    this.now = now;
    /**
     * @type {Map<number, {tabId: number, calls: Set<object>, sessionId: string|null,
     *   agentName: string|null, lastAt: number, linger: boolean}>}
     */
    this.entries = new Map();
  }

  /**
   * A call from `sessionId` started acting on `tabId`. The latest caller wins
   * the label. Returns the handle to pass to end().
   */
  begin(tabId, sessionId, agentName) {
    this.prune();
    let entry = this.entries.get(tabId);
    if (!entry) {
      entry = { tabId, calls: new Set(), sessionId: null, agentName: null, lastAt: 0, linger: true };
      this.entries.set(tabId, entry);
    }
    const call = { entry, sessionId: sessionId ?? null, agentName: agentName ?? null };
    entry.calls.add(call);
    entry.sessionId = call.sessionId;
    entry.agentName = call.agentName;
    entry.linger = true;
    entry.lastAt = this.now();
    return call;
  }

  /**
   * The call behind `call` finished. A no-op for a null handle or a call whose
   * tab/session was released meanwhile.
   */
  end(call) {
    const entry = call?.entry;
    if (!entry || !entry.calls.delete(call)) return;
    entry.lastAt = this.now();
    if (entry.calls.size === 0 && !entry.linger && this.entries.get(entry.tabId) === entry) {
      this.entries.delete(entry.tabId);
    }
  }

  /**
   * The current controller of `tabId`, or undefined when idle past the linger
   * window. `active` is true while a call is running, false during the linger.
   * Read-only: expired entries are dropped by prune(), never here.
   * @returns {{sessionId: string|null, agentName: string|null, active: boolean}|undefined}
   */
  controller(tabId) {
    const e = this.entries.get(tabId);
    if (!e || this.expired(e)) return undefined;
    return { sessionId: e.sessionId, agentName: e.agentName, active: e.calls.size > 0 };
  }

  /**
   * The tab was handed back (lock released): skip the linger. Calls still
   * running keep it controlled until they end; then it is free at once.
   */
  settle(tabId) {
    const e = this.entries.get(tabId);
    if (!e) return;
    e.linger = false;
    if (e.calls.size === 0) this.entries.delete(tabId);
  }

  /** A frozen tab was replaced: its control (and running calls) follow the new tab. */
  move(fromTabId, toTabId) {
    const e = this.entries.get(fromTabId);
    if (!e) return;
    this.entries.delete(fromTabId);
    e.tabId = toTabId;
    this.entries.set(toTabId, e);
  }

  /** Forget a tab (closed). */
  release(tabId) {
    this.entries.delete(tabId);
  }

  /**
   * Forget `sessionId` (agent disconnected): drop its calls, and its label
   * unless another session still has a call running on that tab.
   */
  releaseByOwner(sessionId) {
    for (const [tabId, e] of this.entries) {
      for (const call of e.calls) if (call.sessionId === sessionId) e.calls.delete(call);
      if (e.sessionId !== sessionId) continue;
      const last = [...e.calls].at(-1);
      if (last) {
        e.sessionId = last.sessionId;
        e.agentName = last.agentName;
      } else {
        this.entries.delete(tabId);
      }
    }
  }

  /** Drop entries idle past the linger (also tab ids that never existed). */
  prune() {
    for (const [tabId, e] of this.entries) if (this.expired(e)) this.entries.delete(tabId);
  }

  /** @private */
  expired(e) {
    return e.calls.size === 0 && this.now() - e.lastAt >= this.lingerMs;
  }
}

/**
 * Convenience wrapper combining lock + mutex, matching runOnTab in background.js.
 *
 * Ownership is re-checked INSIDE the mutex task: checking only before joining
 * the queue left a window (TOCTOU) where another session could lock the tab
 * between waitFor() resolving and fn() actually starting, letting a non-owner
 * act on a locked tab. When the tab changed hands, the task defers and the
 * outer loop waits again. waitFor() stays OUTSIDE the mutex — waiting while
 * holding the tab mutex would deadlock the owner's own unlock call.
 *
 * @param {TabLockMap} locks
 * @param {TabMutexMap} mutex
 * @param {number} tabId
 * @param {string|null} sessionId
 * @param {() => (Promise<unknown> | unknown)} fn
 */
const DEFER = Symbol('runOnTab.defer');

export async function runOnTab(locks, mutex, tabId, sessionId, fn) {
  for (;;) {
    await locks.waitFor(tabId, sessionId);
    const out = await mutex.run(tabId, async () => {
      const owner = locks.owner(tabId);
      if (sessionId != null && owner !== undefined && owner !== sessionId) return DEFER;
      return { value: await fn() };
    });
    if (out !== DEFER) return out.value;
  }
}
