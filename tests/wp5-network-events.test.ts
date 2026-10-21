import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Events wiring (events.js): webRequest listeners for network capture, request bodies and
 * failed requests. The page console is read through CDP Runtime (lib/browser-log.js,
 * tests/browser-log.test.ts).
 */

vi.mock('../extension/lib/connection.js', () => ({
  getOpenTabs: async () => [],
  buildStatusPayload: () => ({}),
  broadcastStatus: () => {},
  applyPort: () => ({ success: true }),
  applyToken: () => ({ success: true }),
  applyEnrollment: async () => ({ success: true }),
  sendJson: () => {},
  updateBadge: () => {},
  isWsConnected: () => true,
  setCurrentActivity: () => {},
}));

/** chrome.tabs.update calls, in order. */
const updates: Array<[number, Record<string, unknown>]> = [];
/** What chrome.tabs.get answers for a tab beyond its id and url (default: window 1, not active). */
const tabFields = new Map<number, { windowId: number; active: boolean }>();
/** The tabs chrome.tabs.query({active: true}) answers. */
let activeNow: Array<{ id: number; windowId: number }> = [];
const registered = vi.hoisted(() => new Map<string, Array<{ fn: (...args: unknown[]) => unknown; extra?: unknown }>>());
const onAdd = (name: string) => ({
  addListener: (fn: (...args: unknown[]) => unknown, _filter?: unknown, extra?: unknown) => {
    registered.set(name, [...(registered.get(name) ?? []), { fn, extra }]);
  },
});
(globalThis as unknown as { chrome: unknown }).chrome = {
  runtime: { onMessage: onAdd('onMessage'), getManifest: () => ({ version: '9.9.9' }) },
  webRequest: {
    onBeforeRequest: onAdd('onBeforeRequest'), onSendHeaders: onAdd('onSendHeaders'),
    onCompleted: onAdd('onCompleted'), onErrorOccurred: onAdd('onErrorOccurred'),
  },
  tabs: {
    onRemoved: onAdd('onRemoved'),
    onUpdated: onAdd('onUpdated'),
    onActivated: onAdd('onActivated'),
    update: async (id: number, props: Record<string, unknown>) => { updates.push([id, props]); return { id }; },
    get: async (id: number) => ({ id, url: 'https://x.test/', windowId: 1, active: false, ...tabFields.get(id) }),
    query: async (q: { active?: boolean }) => (q.active ? activeNow : []),
  },
  webNavigation: { onCreatedNavigationTarget: onAdd('onCreatedNavigationTarget') },
  storage: { session: { get: async () => ({}), set: async () => {} } },
  scripting: { executeScript: async () => [{ result: null }] },
};

const { registerEventListeners } = await import('../extension/events.js');
const { networkByTab, tabLocks } = await import('../extension/lib/state.js');

const webRequest = (name: string, d: Record<string, unknown>) => (registered.get(name)![0].fn as (x: unknown) => void)(d);

describe('events wiring', () => {
  beforeEach(() => {
    networkByTab.clear();
    registerEventListeners();
  });

  it('listens for request bodies (requestBody extraInfoSpec)', () => {
    expect(registered.get('onBeforeRequest')![0].extra).toEqual(['requestBody']);
  });

  it('a failed request is buffered as a plain network entry, error included', () => {
    webRequest('onBeforeRequest', { requestId: 'ad1', tabId: 3, url: 'https://ads.test/x.js', method: 'GET', type: 'script', timeStamp: 1 });
    webRequest('onErrorOccurred', { requestId: 'ad1', tabId: 3, url: 'https://ads.test/x.js', method: 'GET', type: 'script', error: 'net::ERR_BLOCKED_BY_CLIENT', timeStamp: 2 });
    expect(networkByTab.get(3)?.[0]).toMatchObject({ error: 'net::ERR_BLOCKED_BY_CLIENT' });
    expect(networkByTab.get(3)?.[0]).not.toHaveProperty('intercept');
  });
});

describe('a tab an agent\'s own tab opens (target=_blank, window.open)', () => {
  /** The listeners of the latest registration (each test registers once more). */
  const latest = (name: string) => registered.get(name)!.at(-1)!.fn as (x: unknown) => unknown;
  /** Tab `tabId` opened from `sourceTabId` in window 7, as webNavigation reports it. */
  const opened = (sourceTabId: number, tabId: number, active: boolean) => {
    tabFields.set(tabId, { windowId: 7, active });
    return latest('onCreatedNavigationTarget')({ sourceTabId, tabId, sourceFrameId: 0, url: 'https://x.test/new', timeStamp: 0 });
  };

  beforeEach(() => {
    tabLocks.unlockAll();
    updates.length = 0;
    tabFields.clear();
    activeNow = [];
    registerEventListeners();
    tabLocks.lock(10, 'session-a');
  });

  it('belongs to the source tab\'s session, and the user\'s tab is made active again', async () => {
    latest('onActivated')({ tabId: 1, windowId: 7 }); // the user is on tab 1, the agent's tab 10 is in the background
    latest('onActivated')({ tabId: 11, windowId: 7 }); // Chrome activates the new tab before reporting where it came from
    await opened(10, 11, true);
    expect(tabLocks.owner(11)).toBe('session-a');
    expect(updates).toEqual([[1, { active: true }]]);
  });

  it('keeps the focus where it went when the user was looking at the source tab', async () => {
    latest('onActivated')({ tabId: 10, windowId: 7 });
    latest('onActivated')({ tabId: 11, windowId: 7 });
    await opened(10, 11, true);
    expect(tabLocks.owner(11)).toBe('session-a');
    expect(updates).toEqual([]);
  });

  it('restores the user\'s tab also when the worker has seen no activation since it started', async () => {
    activeNow = [{ id: 1, windowId: 7 }];
    registerEventListeners();
    await Promise.resolve(); // the active tabs are read when the listeners are registered
    latest('onActivated')({ tabId: 11, windowId: 7 });
    await opened(10, 11, true);
    expect(updates).toEqual([[1, { active: true }]]);
  });

  it('a tab opened by a user tab, or in the background, is left alone', async () => {
    latest('onActivated')({ tabId: 1, windowId: 7 });
    await opened(1, 12, true);
    expect(tabLocks.owner(12)).toBeUndefined();
    await opened(10, 13, false);
    expect(tabLocks.owner(13)).toBe('session-a');
    expect(updates).toEqual([]);
  });
});
