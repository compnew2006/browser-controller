import { beforeEach, describe, expect, it } from 'vitest';

(globalThis as any).chrome = {
  tabs: { get: async (id: number) => ({ id, url: 'https://example.test/', windowId: 1 }) },
  storage: { session: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({}), set: async () => {} } },
};

const { createNetworkCapture, redactHeaders, redactUrl, listView, pushNetworkEntry, REDACTED } = await import('../extension/lib/network-capture.js');
const { handleLogs } = await import('../extension/handlers/logs.js');
const { networkByTab, getTabBuffer } = await import('../extension/lib/state.js');

const LONG = `https://example.test/track?${Array.from({ length: 40 }, (_, i) => `param${i}=${'v'.repeat(15)}`).join('&')}`;

function capture() {
  const stored: Array<[number, any]> = [];
  const c = createNetworkCapture({ store: (tabId: number, entry: any) => { stored.push([tabId, entry]); pushNetworkEntry(getTabBuffer(networkByTab, tabId), entry); } });
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

describe('browser_logs network block and requestId', () => {
  beforeEach(() => {
    networkByTab.clear();
    const { c } = capture();
    request(c, '1', 'https://example.test/', { type: 'main_frame' });
    request(c, '2', 'https://example.test/api/data', { reqHeaders: [{ name: 'Cookie', value: 'sid=1' }], resHeaders: [{ name: 'x-test-header', value: 'bc-fixture' }] });
    request(c, '3', LONG, { type: 'image', status: 204 });
    request(c, '4', 'https://example.test/app.js', { type: 'script' });
  });

  it('filters the URLs case-insensitively', async () => {
    const urls = async (filter: string) => (await handleLogs({ tabId: 5, kind: 'network', filter }) as any).requests.map((r: any) => r.id);
    expect(await urls('API/DATA')).toEqual(['2']);
    expect(await urls('example.test')).toEqual(['1', '2', '3', '4']);
    expect(await urls('nothing-matches')).toEqual([]);
  });

  it('prints one line per request with a shortened URL, and returns one request in full by requestId', async () => {
    const res = await handleLogs({ tabId: 5, kind: 'network' }) as any;
    const lines = res.text.split('\n');
    expect(lines[0]).toBe('network (4):');
    expect(lines).toContain('r2 GET 200 xhr 42ms https://example.test/api/data');
    const long = lines.find((l: string) => l.startsWith('r3 '));
    expect(long).toMatch(/^r3 GET 204 image 42ms https:\/\/.*…$/);
    expect(long.slice(long.indexOf('https://'))).toHaveLength(120);
    expect(res.requests.every((r: any) => !('requestHeaders' in r))).toBe(true);
    expect(res.requests[2].url).toBe(LONG); // the data keeps the full URL; only the line is cut

    const one = await handleLogs({ tabId: 5, requestId: 'r2' }) as any;
    expect(one).toMatchObject({
      success: true,
      request: {
        id: '2', status: 200, durationMs: 42,
        requestHeaders: [{ name: 'Cookie', value: REDACTED }],
        responseHeaders: [{ name: 'x-test-header', value: 'bc-fixture' }],
      },
    });
    expect(one.text).toContain(`Cookie: ${REDACTED}`);
    expect(one.text).toContain('x-test-header: bc-fixture');
    expect((await handleLogs({ tabId: 5, requestId: '3' }) as any).request.url).toBe(LONG);
    await expect(handleLogs({ tabId: 5, requestId: 'nope' })).rejects.toThrow(/^NOT_FOUND: request nope/);
  });

  it('rejects a kind or a limit outside the contract instead of returning nothing', async () => {
    await expect(handleLogs({ tabId: 5, kind: 'pictures' })).rejects.toThrow(/^INVALID_ARGUMENT: kind/);
    await expect(handleLogs({ tabId: 5, kind: 'network', limit: 201 })).rejects.toThrow(/^INVALID_ARGUMENT: limit/);
  });

});

describe('secret query values never reach the buffer (L3)', () => {
  beforeEach(() => { networkByTab.clear(); });

  it('a stored request URL has its secret-looking query values masked; the navigation URL is untouched', () => {
    const { c, stored } = capture();
    request(c, 'q1', 'https://api.test/items?access_token=abc123&page=2');
    expect(stored[0][1].url).toBe('https://api.test/items?access_token=***&page=2');
    expect(redactUrl('https://api.test/a?secret=1#frag')).toBe('https://api.test/a?secret=***#frag');
  });
});
