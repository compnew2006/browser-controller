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

const { tabLocks, fallbackByTab, observationSnapshots, persistSessionState, loadSessionState, dropDocumentState, dropTabState } =
  await import('../extension/lib/state.js');

describe('session persistence (MV3 lifetime)', () => {
  beforeEach(() => {
    sessionStore.clear();
    tabLocks.unlockAll();
    fallbackByTab.clear();
    observationSnapshots.clear();
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
    observationSnapshots.register({
      snapshotId: 's_tab', tabId: 7, sessionId: 'agentA', documentId: 'd1',
      documentVersion: 'd1:1', createdAt: Date.now(),
    });
    dropTabState(7);
    expect(tabLocks.owner(7)).toBeUndefined();
    expect(fallbackByTab.has(7)).toBe(false);
    expect(observationSnapshots.validate('s_tab', 7, 'agentA')).toMatchObject({ error: 'SNAPSHOT_NOT_FOUND' });
  });

  it('invalidates document-bound refs without releasing a durable tab lock', () => {
    tabLocks.lock(7, 'agentA');
    fallbackByTab.set(7, new Map([['e1', { selector: '#continue' }]]));
    observationSnapshots.register({
      snapshotId: 's_document', tabId: 7, sessionId: 'agentA', documentId: 'd1',
      documentVersion: 'd1:1', createdAt: Date.now(),
    });

    dropDocumentState(7);

    expect(tabLocks.owner(7)).toBe('agentA');
    expect(fallbackByTab.has(7)).toBe(false);
    expect(observationSnapshots.validate('s_document', 7, 'agentA')).toMatchObject({ error: 'DOCUMENT_CHANGED' });
  });

  it('persists bounded observation ownership metadata across a worker recycle', async () => {
    observationSnapshots.register({
      snapshotId: 's_restore', tabId: 11, sessionId: 'agentA', documentId: 'd1',
      documentVersion: 'd1:1', createdAt: Date.now(),
    });
    persistSessionState();
    await new Promise((r) => setTimeout(r, 0));

    observationSnapshots.clear();
    await loadSessionState();
    expect(observationSnapshots.validate('s_restore', 11, 'agentA')).toMatchObject({ ok: true });
  });

  it('survives a corrupt/empty storage payload without throwing', async () => {
    sessionStore.set('bcSessionState', { locks: 'not-an-array' });
    await expect(loadSessionState()).resolves.toBeUndefined();
  });
});
