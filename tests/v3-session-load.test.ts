import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * X3: a service worker woken by a tab event can run its listeners before the boot has read
 * chrome.storage.session. A write then must not overwrite the stored locks with the empty
 * in-memory state. This file keeps its own module instance: the boot read has not happened.
 */

const sessionStore = new Map<string, any>();
(globalThis as any).chrome = {
  storage: {
    session: {
      get: async (key: string) => (sessionStore.has(key) ? { [key]: sessionStore.get(key) } : {}),
      set: async (obj: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(obj)) sessionStore.set(k, v);
      },
    },
  },
};

// Each scenario needs a module that has not read storage yet: a fresh instance per test.
async function freshState() {
  vi.resetModules();
  return import('../extension/lib/state.js');
}
let tabLocks: any, persistSessionState: any, loadSessionState: any, dropTabState: any, dropDocumentState: any;

const flush = () => new Promise((r) => setTimeout(r, 0));
const stored = () => sessionStore.get('bcSessionState')?.locks?.map((l: { tabId: number }) => l.tabId) ?? null;
const savedLocks = [
  { tabId: 5, sessionId: 'agentA', agentName: 'A', since: 1 },
  { tabId: 6, sessionId: 'agentB', agentName: 'B', since: 2 },
];

describe('X3: tab events before the boot read do not erase the stored locks', () => {
  beforeEach(async () => {
    sessionStore.clear();
    ({ tabLocks, persistSessionState, loadSessionState, dropTabState, dropDocumentState } = await freshState());
  });

  it('a write before the read is deferred: storage keeps the locks, and the read restores them', async () => {
    sessionStore.set('bcSessionState', { locks: savedLocks, daemonInstance: null, fallbacks: {} });

    dropDocumentState(5); // a tab reloads: the worker woke on onUpdated
    persistSessionState();
    await flush();
    expect(stored()).toEqual([5, 6]);

    await loadSessionState();
    expect(tabLocks.owner(5)).toBe('agentA');
    expect(tabLocks.owner(6)).toBe('agentB');
    expect(stored()).toEqual([5, 6]); // the deferred write went out once the read was done
  });

  it('a tab closed before the read is not restored from storage', async () => {
    sessionStore.set('bcSessionState', { locks: savedLocks, daemonInstance: null, fallbacks: {} });

    dropTabState(5); // onRemoved woke the worker
    persistSessionState();
    await loadSessionState();

    expect(tabLocks.owner(5)).toBeUndefined();
    expect(tabLocks.owner(6)).toBe('agentB');
    expect(stored()).toEqual([6]);
  });

  it('a lock taken before the read is written together with the stored ones', async () => {
    sessionStore.set('bcSessionState', { locks: savedLocks.slice(0, 1), daemonInstance: null, fallbacks: {} });

    tabLocks.lock(7, 'agentC');
    persistSessionState();
    await loadSessionState();
    await flush();

    expect(tabLocks.owner(5)).toBe('agentA');
    expect(tabLocks.owner(7)).toBe('agentC');
    expect(stored()?.sort()).toEqual([5, 7]);
  });
});
