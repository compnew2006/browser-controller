import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * WP6 item 1b: locks, control entries and shields belong to the daemon instance
 * that granted them. A hello from a different instance (the daemon restarted)
 * releases them; the same instance (a service-worker recycle) keeps them.
 */

const sessionStore = new Map<string, unknown>();
const shieldTabs = vi.hoisted(() => [] as number[]);

(globalThis as unknown as { chrome: unknown }).chrome = {
  storage: {
    session: {
      get: async (key: string) => (sessionStore.has(key) ? { [key]: sessionStore.get(key) } : {}),
      set: async (obj: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(obj)) sessionStore.set(k, v);
      },
    },
    local: { get: async () => ({}), set: async () => {} },
  },
  tabs: { query: async () => [] },
  scripting: {
    executeScript: async (req: { target: { tabId: number } }) => {
      shieldTabs.push(req.target.tabId);
      return [];
    },
  },
  action: { setBadgeBackgroundColor: () => {}, setBadgeText: () => {} },
  runtime: { sendMessage: async () => {}, onMessage: { addListener: () => {} } },
  alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
};

const { adoptDaemonInstance } = await import('../extension/lib/connection.js');
const { tabLocks, tabControl, persistSessionState, loadSessionState, setAdoptedDaemonInstance } =
  await import('../extension/lib/state.js');

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('daemon instance adoption (stale locks after a daemon restart)', () => {
  beforeEach(() => {
    sessionStore.clear();
    shieldTabs.length = 0;
    tabLocks.unlockAll();
    tabControl.clear();
    setAdoptedDaemonInstance(null);
  });

  it('a reconnect to the same daemon instance keeps its locks', () => {
    adoptDaemonInstance('inst-a');
    tabLocks.lock(1, 's-inst-a-1');
    expect(adoptDaemonInstance('inst-a')).toBe(0);
    expect(tabLocks.owner(1)).toBe('s-inst-a-1');
    expect(shieldTabs).toEqual([]);
  });

  it('a restarted daemon (new instance id) releases the old locks, control entries and shields', () => {
    adoptDaemonInstance('inst-a');
    tabLocks.lock(1, 's-inst-a-1');
    tabLocks.lock(2, 's-inst-a-2');
    tabControl.begin(3, 's-inst-a-1', 'Claude');
    expect(adoptDaemonInstance('inst-b')).toBe(2);
    expect(tabLocks.owner(1)).toBeUndefined();
    expect(tabLocks.owner(2)).toBeUndefined();
    expect(tabControl.controller(3)).toBeUndefined();
    expect(shieldTabs.sort()).toEqual([1, 2]);
  });

  it('after the restart a new session can lock a tab the dead one held', () => {
    adoptDaemonInstance('inst-a');
    tabLocks.lock(1, 's-inst-a-1');
    adoptDaemonInstance('inst-b');
    expect(() => tabLocks.lock(1, 's-inst-b-1')).not.toThrow();
    expect(tabLocks.owner(1)).toBe('s-inst-b-1');
  });

  it('a hello without an instance id (daemon from before instance ids) changes nothing', () => {
    adoptDaemonInstance('inst-a');
    tabLocks.lock(1, 's-inst-a-1');
    expect(adoptDaemonInstance(undefined)).toBe(0);
    expect(adoptDaemonInstance('')).toBe(0);
    expect(tabLocks.owner(1)).toBe('s-inst-a-1');
  });

  it('the adopted instance is persisted with the locks: a worker recycle keeps a same-daemon lock', async () => {
    adoptDaemonInstance('inst-a');
    tabLocks.lock(1, 's-inst-a-1', { agentName: 'Claude', since: 1000 });
    persistSessionState();
    await flush();

    // Recycle: memory gone, storage kept.
    tabLocks.unlockAll();
    setAdoptedDaemonInstance(null);
    await loadSessionState();
    expect(tabLocks.grantOf(1)).toEqual({ sessionId: 's-inst-a-1', agentName: 'Claude', since: 1000 });

    expect(adoptDaemonInstance('inst-a')).toBe(0); // same daemon: lock survives
    expect(tabLocks.owner(1)).toBe('s-inst-a-1');
    expect(adoptDaemonInstance('inst-b')).toBe(1); // a restart after the recycle: released
    expect(tabLocks.owner(1)).toBeUndefined();
  });

  it('a lock restored from storage that was written before instance ids is released by the first daemon hello', async () => {
    sessionStore.set('bcSessionState', { locks: [{ tabId: 4, sessionId: 's1' }], fallbacks: {} });
    await loadSessionState();
    expect(tabLocks.owner(4)).toBe('s1');
    expect(adoptDaemonInstance('inst-a')).toBe(1);
    expect(tabLocks.owner(4)).toBeUndefined();
  });
});
