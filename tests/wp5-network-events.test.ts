import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * WP5 events wiring: request bodies, blocked requests in the intercept ledger,
 * and the Chrome Issues row cap of browser_console. The page console itself is
 * read through CDP Runtime (lib/browser-log.js, tests/browser-log.test.ts).
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
const { handleIntercept } = await import('../extension/handlers/intercept.js');
const { networkByTab } = await import('../extension/lib/state.js');
const { interceptLedgerByTab } = await import('../extension/handlers/intercept.js');
const { capIssueRows, MAX_ISSUE_ROWS } = await import('../extension/lib/browser-log.js');

const webRequest = (name: string, d: Record<string, unknown>) => (registered.get(name)![0].fn as (x: unknown) => void)(d);

describe('events wiring', () => {
  beforeEach(() => {
    networkByTab.clear();
    interceptLedgerByTab.clear();
    registerEventListeners();
  });

  it('listens for request bodies (requestBody extraInfoSpec)', () => {
    expect(registered.get('onBeforeRequest')![0].extra).toEqual(['requestBody']);
  });

  it('a blocked request is ledgered too, not only completed ones', async () => {
    await handleIntercept({ action: 'set-rules', global: true, rules: [{ id: 'ads', match: 'https://ads\\.test/', action: 'block' }] });
    webRequest('onBeforeRequest', { requestId: 'ad1', tabId: 3, url: 'https://ads.test/x.js', method: 'GET', type: 'script', timeStamp: 1 });
    webRequest('onErrorOccurred', { requestId: 'ad1', tabId: 3, url: 'https://ads.test/x.js', method: 'GET', type: 'script', error: 'net::ERR_BLOCKED_BY_CLIENT', timeStamp: 2 });
    expect(networkByTab.get(3)?.[0]).toMatchObject({ error: 'net::ERR_BLOCKED_BY_CLIENT' });
    expect(networkByTab.get(3)?.[0]).not.toHaveProperty('intercept');
    expect(interceptLedgerByTab.get(3)).toEqual([expect.objectContaining({ error: 'net::ERR_BLOCKED_BY_CLIENT', intercept: expect.any(Object) })]);
  });
});

describe('browser_console Chrome Issues cap', () => {
  it('lists the most frequent issue kinds first and summarises the rest in one row', () => {
    const rows = Array.from({ length: MAX_ISSUE_ROWS + 3 }, (_, i) => ({ code: 'GenericIssue', type: `kind${i}`, count: i + 1 }));
    const capped = capIssueRows(rows);
    expect(capped).toHaveLength(MAX_ISSUE_ROWS + 1);
    expect(capped[0]).toMatchObject({ type: `kind${MAX_ISSUE_ROWS + 2}`, count: MAX_ISSUE_ROWS + 3 });
    expect(capped.at(-1)).toEqual({ code: 'Truncated', type: `3 more issue kinds not listed (row cap ${MAX_ISSUE_ROWS})` });
  });

  it('leaves a short list alone', () => {
    const rows = [{ code: 'A', count: 1 }, { code: 'B', count: 2 }];
    expect(capIssueRows(rows)).toEqual([{ code: 'B', count: 2 }, { code: 'A', count: 1 }]);
  });
});
