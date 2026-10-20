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
    get: async (id: number) => ({ id, url: 'https://x.test/', windowId: 1 }),
  },
  storage: { session: { get: async () => ({}), set: async () => {} } },
  scripting: { executeScript: async () => [{ result: null }] },
};

const { registerEventListeners } = await import('../extension/events.js');
const { networkByTab } = await import('../extension/lib/state.js');

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
