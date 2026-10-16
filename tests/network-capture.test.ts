import { beforeEach, describe, expect, it } from 'vitest';

(globalThis as any).chrome = {
  tabs: { get: async (id: number) => ({ id, url: 'https://example.test/', windowId: 1 }) },
  storage: { session: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({}), set: async () => {} } },
};

const { createNetworkCapture, redactHeaders, listView, REDACTED } = await import('../extension/lib/network-capture.js');
const { handleNetwork } = await import('../extension/handlers/tabs.js');
const { networkByTab, getTabBuffer, pushCapped } = await import('../extension/lib/state.js');

const LONG = `https://example.test/track?${Array.from({ length: 40 }, (_, i) => `param${i}=${'v'.repeat(15)}`).join('&')}`;

function capture() {
  const stored: Array<[number, any]> = [];
  const c = createNetworkCapture({ store: (tabId: number, entry: any) => { stored.push([tabId, entry]); pushCapped(getTabBuffer(networkByTab, tabId), entry); } });
  return { c, stored };
}

function request(c: any, id: string, url: string, { type = 'xmlhttprequest', status = 200, error = '', at = 1000, ms = 42, reqHeaders = [] as any[], resHeaders = [] as any[] } = {}) {
  c.onBeforeRequest({ requestId: id, tabId: 5, url, method: 'GET', type, timeStamp: at });
  c.onSendHeaders({ requestId: id, tabId: 5, requestHeaders: reqHeaders });
  if (error) c.onErrorOccurred({ requestId: id, tabId: 5, url, method: 'GET', type, error, timeStamp: at + ms });
  else c.onCompleted({ requestId: id, tabId: 5, url, method: 'GET', type, statusCode: status, responseHeaders: resHeaders, timeStamp: at + ms });
}

describe('network capture (webRequest → per-tab buffer)', () => {
  beforeEach(() => { networkByTab.clear(); });

  it('redacts credential-bearing headers and keeps the rest', () => {
    expect(redactHeaders([
      { name: 'Authorization', value: 'Bearer abc' }, { name: 'Cookie', value: 'sid=1' }, { name: 'X-API-Key', value: 'k' },
      { name: 'x-csrf-token', value: 't' }, { name: 'Content-Type', value: 'application/json' }, { name: 'Accept' },
    ])).toEqual([
      { name: 'Authorization', value: REDACTED }, { name: 'Cookie', value: REDACTED }, { name: 'X-API-Key', value: REDACTED },
      { name: 'x-csrf-token', value: REDACTED }, { name: 'Content-Type', value: 'application/json' }, { name: 'Accept', value: '' },
    ]);
    expect(redactHeaders(undefined)).toBeUndefined();
  });

  it('records id, duration and redacted headers; failures keep their error; non-tab requests are ignored', () => {
    const { c, stored } = capture();
    request(c, '7', 'https://example.test/api/data', {
      reqHeaders: [{ name: 'Authorization', value: 'Bearer abc' }],
      resHeaders: [{ name: 'x-test-header', value: 'bc-fixture' }],
    });
    request(c, '8', 'https://example.test/missing', { error: 'net::ERR_BLOCKED_BY_CLIENT', ms: 5 });
    c.onCompleted({ requestId: '9', tabId: -1, url: 'https://sw.example/', method: 'GET', type: 'other', statusCode: 200, timeStamp: 1 });
    expect(stored.map(([tab]) => tab)).toEqual([5, 5]);
    expect(stored[0][1]).toEqual({
      id: '7', method: 'GET', url: 'https://example.test/api/data', status: 200, type: 'xmlhttprequest', timestamp: 1042,
      durationMs: 42,
      requestHeaders: [{ name: 'Authorization', value: REDACTED }],
      responseHeaders: [{ name: 'x-test-header', value: 'bc-fixture' }],
    });
    expect(stored[1][1]).toMatchObject({ id: '8', error: 'net::ERR_BLOCKED_BY_CLIENT', durationMs: 5 });
    expect(stored[1][1].status).toBeUndefined();
  });

  it('a request whose start was never seen still lands, without a duration', () => {
    const { c, stored } = capture();
    c.onCompleted({ requestId: 'x', tabId: 5, url: 'https://example.test/', method: 'GET', type: 'main_frame', statusCode: 200, timeStamp: 1 });
    expect(stored[0][1]).toEqual({ id: 'x', method: 'GET', url: 'https://example.test/', status: 200, type: 'main_frame', timestamp: 1 });
  });

  it('list view is lean: long URLs are cut with a marker unless fullUrls, headers stay out', () => {
    const entry = { id: '1', method: 'GET', url: LONG, status: 204, type: 'image', timestamp: 1, durationMs: 3, requestHeaders: [], responseHeaders: [] };
    const lean = listView(entry, {});
    expect(lean.url.length).toBeLessThan(240);
    expect(lean.url).toMatch(/…\[\+\d+ chars\]$/);
    expect(lean).not.toHaveProperty('requestHeaders');
    expect(lean).not.toHaveProperty('responseHeaders');
    expect(listView(entry, { fullUrls: true }).url).toBe(LONG);
  });
});

describe('browser_network', () => {
  beforeEach(() => {
    networkByTab.clear();
    const { c } = capture();
    request(c, '1', 'https://example.test/', { type: 'main_frame' });
    request(c, '2', 'https://example.test/api/data', { reqHeaders: [{ name: 'Cookie', value: 'sid=1' }], resHeaders: [{ name: 'x-test-header', value: 'bc-fixture' }] });
    request(c, '3', LONG, { type: 'image', status: 204 });
    request(c, '4', 'https://example.test/app.js', { type: 'script' });
  });

  it('filters by resource type, with xhr/fetch/document aliases and lists', async () => {
    const urls = async (type: unknown) => (await handleNetwork({ tabId: 5, type }) as any).requests.map((r: any) => r.id);
    expect(await urls('xhr')).toEqual(['2']);
    expect(await urls('fetch')).toEqual(['2']);
    expect(await urls('document')).toEqual(['1']);
    expect(await urls(['image', 'script'])).toEqual(['3', '4']);
  });

  it('lists lean entries and returns one request in full by requestId', async () => {
    const list = await handleNetwork({ tabId: 5 }) as any;
    expect(list.requests.every((r: any) => !('requestHeaders' in r))).toBe(true);
    expect(list.requests[2].url).toMatch(/…\[\+\d+ chars\]$/);
    const one = await handleNetwork({ tabId: 5, requestId: '2' }) as any;
    expect(one).toMatchObject({
      success: true,
      request: {
        id: '2', status: 200, durationMs: 42,
        requestHeaders: [{ name: 'Cookie', value: REDACTED }],
        responseHeaders: [{ name: 'x-test-header', value: 'bc-fixture' }],
      },
    });
    expect((await handleNetwork({ tabId: 5, requestId: '3' }) as any).request.url).toBe(LONG);
    const missing = await handleNetwork({ tabId: 5, requestId: 'nope' }) as any;
    expect(missing.success).toBe(false);
    expect(missing.error).toMatch(/nope/);
  });

  it('rejects an unknown resource type instead of silently returning nothing', async () => {
    await expect(handleNetwork({ tabId: 5, type: 'pictures' })).rejects.toThrow(/Unknown resource type "pictures"/);
  });
});
