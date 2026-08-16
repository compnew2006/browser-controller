import { describe, it, expect, beforeEach } from 'vitest';

/**
 * MV3 session persistence (architecture item): lock ownership + smart-selector
 * fallbacks must survive a service-worker recycle via chrome.storage.session.
 */

const sessionStore = new Map<string, unknown>();
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
  tabs: { get: async () => ({}), query: async () => [] },
  scripting: { executeScript: async () => [] },
  action: { setBadgeBackgroundColor: () => {}, setBadgeText: () => {} },
  runtime: { sendMessage: async () => {}, onMessage: { addListener: () => {} } },
  alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
};

const { tabLocks, fallbackByTab, persistSessionState, loadSessionState, dropTabState } =
  await import('../extension/lib/state.js');

describe('session persistence (MV3 lifetime)', () => {
  beforeEach(() => {
    sessionStore.clear();
    tabLocks.unlockAll();
    fallbackByTab.clear();
  });

  it('persists lock ownership and restores it after a recycle', async () => {
    tabLocks.lock(7, 'agentA');
    tabLocks.lock(8, 'agentB');
    persistSessionState();
    await new Promise((r) => setTimeout(r, 0)); // storage.set is async fire-and-forget

    // Simulate the recycle: wipe in-memory state, keep storage.
    tabLocks.unlockAll();
    expect(tabLocks.owner(7)).toBeUndefined();

    await loadSessionState();
    expect(tabLocks.owner(7)).toBe('agentA');
    expect(tabLocks.owner(8)).toBe('agentB');
  });

  it('persists fallbacks and restores them per-tab', async () => {
    fallbackByTab.set(9, new Map(Object.entries({ e1: { selector: '#x' }, e2: { text: 'Go' } })));
    persistSessionState();
    await new Promise((r) => setTimeout(r, 0));

    fallbackByTab.clear();
    await loadSessionState();
    expect(fallbackByTab.get(9)?.get('e1')).toEqual({ selector: '#x' });
    expect(fallbackByTab.get(9)?.get('e2')).toEqual({ text: 'Go' });
  });

  it('dropTabState releases the lock and clears per-tab maps (tab closed)', () => {
    tabLocks.lock(7, 'agentA');
    fallbackByTab.set(7, new Map());
    dropTabState(7);
    expect(tabLocks.owner(7)).toBeUndefined();
    expect(fallbackByTab.has(7)).toBe(false);
  });

  it('survives a corrupt/empty storage payload without throwing', async () => {
    sessionStore.set('bcSessionState', { locks: 'not-an-array' });
    await expect(loadSessionState()).resolves.toBeUndefined();
  });
});
