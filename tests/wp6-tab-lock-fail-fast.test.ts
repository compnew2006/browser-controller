import { describe, it, expect, beforeEach } from 'vitest';
import { TabMutexMap, TabLockMap, TabControlMap, runOnTab } from '../extension/lib/tab-concurrency.js';

/**
 * WP6 item 2: an explicit tab lock held by another live session fails the
 * caller at once with TAB_LOCKED (owner name + lock time), instead of queueing
 * for ~30 s. The short per-tab mutex queueing between unlocked calls is kept.
 */
describe('explicit tab locks fail fast (TAB_LOCKED)', () => {
  let mutex: TabMutexMap;
  let locks: TabLockMap;
  beforeEach(() => {
    mutex = new TabMutexMap();
    locks = new TabLockMap();
  });

  it('a call from another session is refused at once, naming the agent and since when', async () => {
    locks.lock(5, 'sessionA', { agentName: 'Claude', since: Date.UTC(2026, 9, 20, 5, 50) });
    let ran = false;
    const started = Date.now();
    await expect(
      runOnTab(locks, mutex, 5, 'sessionB', async () => { ran = true; }),
    ).rejects.toThrow('TAB_LOCKED: tab 5 is locked by Claude (session sessionA) since 2026-10-20T05:50:00.000Z');
    expect(Date.now() - started).toBeLessThan(500); // no waiting for the owner
    expect(ran).toBe(false);
    expect(locks.owner(5)).toBe('sessionA');
  });

  it('the owner of the lock still runs, and an unlocked tab is never gated', async () => {
    locks.lock(6, 'sessionA');
    await expect(runOnTab(locks, mutex, 6, 'sessionA', async () => 'owner-ok')).resolves.toBe('owner-ok');
    await expect(runOnTab(locks, mutex, 7, 'sessionB', async () => 'free-ok')).resolves.toBe('free-ok');
  });

  it('a call with no session (status reads) is never gated', async () => {
    locks.lock(9, 'sessionA');
    await expect(runOnTab(locks, mutex, 9, null, async () => 'read-ok')).resolves.toBe('read-ok');
  });

  it('a lock attempt by another session is refused with the same TAB_LOCKED error', () => {
    locks.lock(14, 'sessionA', { agentName: 'Claude', since: 1000 });
    expect(() => locks.lock(14, 'sessionB')).toThrow(/^TAB_LOCKED: tab 14 is locked by Claude \(session sessionA\)/);
    expect(locks.owner(14)).toBe('sessionA');
  });

  it('a call queued before the lock was taken is refused when it reaches the mutex', async () => {
    const events: string[] = [];
    const p = runOnTab(locks, mutex, 1, 'agentB', async () => { events.push('b-ran'); });
    locks.lock(1, 'agentA', { agentName: 'Claude', since: 1000 });
    await expect(p).rejects.toThrow(/^TAB_LOCKED: tab 1 is locked by Claude/);
    expect(events).toEqual([]);
    expect(locks.owner(1)).toBe('agentA');
  });

  it('once the owner unlocks, the next session gets in', async () => {
    locks.lock(8, 'sessionA');
    locks.unlock(8, 'sessionA');
    await expect(runOnTab(locks, mutex, 8, 'sessionB', async () => 'in')).resolves.toBe('in');
  });

  it('the agent name comes from nameOf when the lock is taken without one', () => {
    const named = new TabLockMap({ nameOf: (sid) => (sid === 'sessionA' ? 'Cursor' : undefined) });
    named.lock(3, 'sessionA');
    expect(named.grantOf(3)).toMatchObject({ sessionId: 'sessionA', agentName: 'Cursor' });
    expect(named.grantOf(3)?.since).toBeGreaterThan(0);
    expect(() => named.lock(3, 'sessionB')).toThrow(/locked by Cursor \(session sessionA\)/);
  });

  it('a snapshot keeps the agent name and lock time, and a restore keeps them too', () => {
    locks.lock(1, 'a', { agentName: 'Claude', since: 1000 });
    const json = JSON.parse(JSON.stringify(locks.snapshot()));
    expect(json).toEqual([{ tabId: 1, sessionId: 'a', agentName: 'Claude', since: 1000 }]);
    const restored = new TabLockMap();
    for (const entry of json) restored.lock(entry.tabId, entry.sessionId, { agentName: entry.agentName, since: entry.since });
    expect(restored.grantOf(1)).toEqual({ sessionId: 'a', agentName: 'Claude', since: 1000 });
  });

  it('releaseByOwner frees every tab of one session and reports them', () => {
    locks.lock(1, 'a');
    locks.lock(2, 'a');
    locks.lock(3, 'b');
    expect(locks.releaseByOwner('a').sort()).toEqual([1, 2]);
    expect(locks.owner(3)).toBe('b');
    expect(locks.owner(1)).toBeUndefined();
  });
});

describe('TabControlMap.clear', () => {
  it('forgets every tab, and a call that was running on one ends harmlessly', () => {
    const control = new TabControlMap(30_000, () => 0);
    const call = control.begin(7, 's-old-1', 'Claude');
    control.clear();
    expect(control.controller(7)).toBeUndefined();
    expect(() => control.end(call)).not.toThrow();
  });
});
