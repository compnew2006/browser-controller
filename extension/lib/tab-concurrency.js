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
    this.queues.set(
      tabId,
      next.then(
        () => {},
        () => {},
      ),
    );
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

  /** Claim tabId for sessionId. */
  lock(tabId, sessionId) {
    this.locks.set(tabId, sessionId);
  }

  /** Release tabId (only if currently owned by sessionId). */
  unlock(tabId, sessionId) {
    if (sessionId == null || this.locks.get(tabId) === sessionId) {
      this.locks.delete(tabId);
    }
  }

  /** Release tabId unconditionally (used when the tab is closed). */
  release(tabId) {
    this.locks.delete(tabId);
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
    return new Promise((resolve) => {
      const tick = () => {
        const cur = this.locks.get(tabId);
        if (cur === undefined || cur === sessionId || Date.now() - start > this.acquireTimeoutMs) {
          resolve();
        } else {
          setTimeout(tick, 50);
        }
      };
      tick();
    });
  }
}

/**
 * Convenience wrapper combining lock + mutex, matching runOnTab in background.js.
 * @param {TabLockMap} locks
 * @param {TabMutexMap} mutex
 * @param {number} tabId
 * @param {string|null} sessionId
 * @param {() => (Promise<unknown> | unknown)} fn
 */
export async function runOnTab(locks, mutex, tabId, sessionId, fn) {
  await locks.waitFor(tabId, sessionId);
  return mutex.run(tabId, fn);
}
