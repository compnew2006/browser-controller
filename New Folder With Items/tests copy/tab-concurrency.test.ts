import { describe, it, expect, beforeEach } from 'vitest';
import { TabMutexMap, TabLockMap, runOnTab } from '../extension/lib/tab-concurrency.js';

/**
 * Concurrency guarantees (plan tasks 2.1 + 2.4). These are the ONLY pieces of
 * the multi-agent behavior we can verify without a live Chrome + extension:
 * the mutex/lock algorithm. background.js wires these exact primitives into its
 * dispatch path (runOnTabLib), so proving them here proves the shipped behavior.
 */

describe('TabMutexMap (task 2.1)', () => {
  let mutex: TabMutexMap;
  beforeEach(() => (mutex = new TabMutexMap()));

  it('serializes calls to the SAME tab', async () => {
    const order: string[] = [];
    const slow = (label: string, ms: number) =>
      new Promise<string>((resolve) => setTimeout(() => {
        order.push(label);
        resolve(label);
      }, ms));

    // Fire two calls at tab 1 concurrently. Even though b is registered first
    // with a tiny head start, they must run in call order, never overlapping.
    const pA = mutex.run(1, () => slow('a', 60));
    const pB = mutex.run(1, () => slow('b', 10));

    await Promise.all([pA, pB]);
    expect(order).toEqual(['a', 'b']); // b waited for a despite being faster
  });

  it('runs calls to DIFFERENT tabs in parallel', async () => {
    const running: string[] = [];
    let overlapSeen = false;
    const track = (label: string, ms: number) =>
      new Promise<void>((resolve) => {
        running.push(label);
        if (running.length > 1) overlapSeen = true;
        setTimeout(() => {
          const i = running.indexOf(label);
          if (i >= 0) running.splice(i, 1);
          resolve();
        }, ms);
      });

    const start = Date.now();
    await Promise.all([
      mutex.run(10, () => track('t10', 60)),
      mutex.run(20, () => track('t20', 60)),
    ]);
    const elapsed = Date.now() - start;

    expect(overlapSeen).toBe(true); // they ran concurrently
    expect(elapsed).toBeLessThan(110); // ~60ms, not ~120ms
  });

  it('does not let a failed call poison the next one', async () => {
    await expect(mutex.run(1, () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    // queue must still accept & run the next call
    await expect(mutex.run(1, () => Promise.resolve('ok'))).resolves.toBe('ok');
  });
});

describe('TabLockMap (task 2.2)', () => {
  let locks: TabLockMap;
  beforeEach(() => (locks = new TabLockMap()));

  it('owner proceeds immediately; non-owner waits', async () => {
    locks.lock(5, 'agentA');
    // owner call returns without delay
    await expect(locks.waitFor(5, 'agentA')).resolves.toBeUndefined();

    // shorten the poll for the test
    locks.acquireTimeoutMs = 200;
    const waited = locks.waitFor(5, 'agentB');
    // release after 60ms; agentB should then proceed, well before its timeout
    setTimeout(() => locks.release(5), 60);
    await expect(waited).resolves.toBeUndefined();
  });

  it('release lets a previously-blocked session proceed', async () => {
    locks.lock(7, 'agentA');
    let resolved = false;
    const p = locks.waitFor(7, 'agentB').then(() => { resolved = true; });
    await new Promise((r) => setTimeout(r, 40));
    expect(resolved).toBe(false); // still blocked
    locks.release(7);
    await p;
    expect(resolved).toBe(true);
  });

  it('unlock only releases if owned by the given session', () => {
    locks.lock(9, 'agentA');
    locks.unlock(9, 'agentB'); // wrong owner → no-op
    expect(locks.owner(9)).toBe('agentA');
    locks.unlock(9, 'agentA'); // correct owner → released
    expect(locks.owner(9)).toBeUndefined();
  });

  it('snapshot is serializable', () => {
    locks.lock(1, 'a');
    locks.lock(2, 'b');
    expect(JSON.parse(JSON.stringify(locks.snapshot()))).toEqual([
      { tabId: 1, sessionId: 'a' },
      { tabId: 2, sessionId: 'b' },
    ]);
  });

  // --- Coverage gaps closed (audit m4) --------------------------------------

  it('unlock(null) releases unconditionally (admin/force path)', () => {
    locks.lock(11, 'agentA');
    // sessionId == null means "release regardless of owner" (used by unlockAll
    // and tabs.onRemoved). Must not require a matching session.
    locks.unlock(11, null);
    expect(locks.owner(11)).toBeUndefined();
  });

  it('waitFor eventually resolves on acquire-timeout (no infinite hang)', async () => {
    locks.lock(12, 'agentA');
    locks.acquireTimeoutMs = 100; // shorten so the test is fast
    const start = Date.now();
    // agentB will NEVER be granted (agentA never releases) — it must still
    // resolve via the timeout, not hang forever.
    await expect(locks.waitFor(12, 'agentB')).resolves.toBeUndefined();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(95); // waited ~the timeout
    expect(elapsed).toBeLessThan(400); // didn't hang
  });

  it('waitFor returns immediately when sessionId is null (no locking semantics)', async () => {
    locks.lock(13, 'agentA');
    // A call with no session bypasses locking entirely (used by status reads).
    await expect(locks.waitFor(13, null)).resolves.toBeUndefined();
  });
});

describe('TabMutexMap additional coverage (audit m4)', () => {
  let mutex: TabMutexMap;
  beforeEach(() => (mutex = new TabMutexMap()));

  it('isIdle reflects pending work and clears after completion (no queue leak)', async () => {
    // Regression guard (javascript-pro audit): TabMutexMap.run used to leave a
    // permanent entry in `queues` after the chain settled, leaking memory and
    // making isIdle() return false forever after the first call. After the fix,
    // the entry is deleted once the chain settles AND no newer call chained on.
    expect(mutex.isIdle(1)).toBe(true); // nothing run yet
    const p = mutex.run(1, () => new Promise<void>((r) => setTimeout(r, 40)));
    expect(mutex.isIdle(1)).toBe(false); // work in flight
    await p;
    // Allow the settled-then cleanup microtask to run.
    await new Promise((r) => setTimeout(r, 0));
    expect(mutex.isIdle(1)).toBe(true); // queue entry deleted after settle → no leak
  });

  it('isIdle stays false while a newer call is chained (delete-if-owner safety)', async () => {
    // The leak-fix deletes the entry only if it's still the SAME settled chain.
    // A second run() that chains onto the first must keep the entry alive until
    // IT settles — otherwise we'd break serialization for a fast follow-up call.
    const p1 = mutex.run(1, () => new Promise<void>((r) => setTimeout(r, 40)));
    const p2 = mutex.run(1, () => new Promise<void>((r) => setTimeout(r, 40)));
    expect(mutex.isIdle(1)).toBe(false);
    await Promise.all([p1, p2]);
    await new Promise((r) => setTimeout(r, 0));
    expect(mutex.isIdle(1)).toBe(true); // both done → entry cleared
  });

  it('a synchronous throw inside fn does not poison the next call', async () => {
    // The existing rejection test uses Promise.reject; this proves a SYNCHRONOUS
    // throw (before any await) is likewise contained to the failing call.
    await expect(mutex.run(2, () => { throw new Error('sync boom'); })).rejects.toThrow('sync boom');
    await expect(mutex.run(2, () => Promise.resolve('ok'))).resolves.toBe('ok');
  });
});

describe('runOnTab (combined lock + mutex, tasks 2.1+2.2)', () => {
  let mutex: TabMutexMap;
  let locks: TabLockMap;
  beforeEach(() => {
    mutex = new TabMutexMap();
    locks = new TabLockMap();
  });

  it('two agents on the same tab serialize, even when locked', async () => {
    const events: string[] = [];
    locks.lock(1, 'agentA');

    // agentB's call should wait for agentA to release the lock AND then the mutex
    const pB = runOnTab(locks, mutex, 1, 'agentB', async () => {
      events.push('b-start');
      await new Promise((r) => setTimeout(r, 20));
      events.push('b-end');
    });

    const pA = runOnTab(locks, mutex, 1, 'agentA', async () => {
      events.push('a-start');
      await new Promise((r) => setTimeout(r, 20));
      events.push('a-end');
      locks.release(1); // owner releases after finishing
    });

    await Promise.all([pA, pB]);
    // agentA ran first (it held the lock); agentB ran only after release
    expect(events).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
  });

  it('two agents on different tabs run in parallel', async () => {
    const active: string[] = [];
    let overlap = false;
    const mk = (label: string, tab: number) =>
      runOnTab(locks, mutex, tab, `agent-${tab}`, async () => {
        active.push(label);
        if (active.length > 1) overlap = true;
        await new Promise((r) => setTimeout(r, 40));
        const i = active.indexOf(label);
        if (i >= 0) active.splice(i, 1);
      });

    await Promise.all([mk('t1', 1), mk('t2', 2)]);
    expect(overlap).toBe(true);
  });
});
