import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * F4-3: a chrome.storage.session read error must not start the worker with no locks, and a
 * persist must not overwrite the stored locks while the read has not succeeded. The load is
 * retried; persistence stays off until one attempt succeeds. Fresh module instance per test.
 */

const sessionStore = new Map<string, any>();
let getFailures = 0;
let setFailure: Error | null = null;
let setCalls = 0;
(globalThis as any).chrome = {
  storage: {
    session: {
      get: async (key: string) => {
        if (getFailures > 0) {
          getFailures--;
          throw new Error('storage read failed');
        }
        return sessionStore.has(key) ? { [key]: sessionStore.get(key) } : {};
      },
      set: async (obj: Record<string, unknown>) => {
        setCalls++;
        if (setFailure) throw setFailure;
        for (const [k, v] of Object.entries(obj)) sessionStore.set(k, v);
      },
    },
  },
};

let state: any;
const flush = () => new Promise((r) => setTimeout(r, 0));
const stored = () => sessionStore.get('bcSessionState')?.locks?.map((l: { tabId: number }) => l.tabId) ?? null;
const savedLocks = [
  { tabId: 5, sessionId: 'agentA', agentName: 'A', since: 1 },
  { tabId: 6, sessionId: 'agentB', agentName: 'B', since: 2 },
];

describe('F4-3: tab-lock restore fails closed', () => {
  beforeEach(async () => {
    sessionStore.clear();
    getFailures = 0;
    setFailure = null;
    setCalls = 0;
    vi.resetModules();
    state = await import('../extension/lib/state.js');
    sessionStore.set('bcSessionState', { locks: savedLocks, daemonInstance: null, fallbacks: {} });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('a read failure then a successful retry restores the locks; no persist wrote in between', async () => {
    getFailures = 1;
    state.persistSessionState(); // deferred before the load
    state.tabLocks.lock(7, 'agentC'); // a change made while the load is failing
    state.persistSessionState();

    await state.loadSessionState({ retryDelaysMs: [0] });

    expect(state.tabLocks.owner(5)).toBe('agentA');
    expect(state.tabLocks.owner(6)).toBe('agentB');
    expect(state.isSessionStateUnavailable()).toBe(false);
    await flush();
    expect(stored()?.sort()).toEqual([5, 6, 7]); // the deferred write went out only after the restore
  });

  it('while every attempt fails the state is unavailable and nothing is persisted over the stored locks', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    getFailures = 99;
    state.persistSessionState();
    const loading = state.loadSessionState({ retryDelaysMs: [10, 20] });
    await vi.advanceTimersByTimeAsync(100);
    await loading;

    expect(state.isSessionStateUnavailable()).toBe(true);
    state.persistSessionState();
    state.dropTabState(5);
    await vi.advanceTimersByTimeAsync(0);
    expect(setCalls).toBe(0);
    expect(stored()).toEqual([5, 6]);

    // Storage recovers: the background retry restores the locks and then lets the persist out.
    getFailures = 0;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.isSessionStateUnavailable()).toBe(false);
    expect(state.tabLocks.owner(6)).toBe('agentB');
    expect(state.tabLocks.owner(5)).toBeUndefined(); // closed meanwhile: not restored
    expect(stored()).toEqual([6]);
  });

  it('a write failure is reported, not silent', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await state.loadSessionState();
    setFailure = new Error('quota exceeded');
    state.persistSessionState();
    await flush();
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0].join(' '))).toMatch(/quota exceeded/);
  });
});
