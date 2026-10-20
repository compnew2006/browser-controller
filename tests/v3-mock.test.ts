import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * browser_mock (3.0): tab-scoped Fetch rules. Requests pause on the tab's debugger; a matching
 * rule fails (block) or answers (status, body, headers) them, every other request continues.
 */
const sent: Array<[number, string, any]> = [];
let emit: (source: { tabId: number }, method: string, params: unknown) => void = () => {};
let dropSession: (source: { tabId: number }) => void = () => {};
let attachFails = false;
(globalThis as any).chrome = {
  tabs: { get: async (id: number) => ({ id, url: 'https://app.test/', windowId: 1 }), onRemoved: { addListener: () => {} } },
  windows: { get: async () => ({ width: 1280, height: 900 }) },
  storage: { session: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({}), set: async () => {} } },
  debugger: {
    attach: async () => { if (attachFails) throw new Error('Cannot access a chrome:// URL'); },
    detach: async () => {},
    sendCommand: async ({ tabId }: { tabId: number }, method: string, params: any) => {
      sent.push([tabId, method, params]);
      return { result: { value: 1 } };
    },
    onEvent: { addListener: (fn: typeof emit) => { emit = fn; } },
    onDetach: { addListener: (fn: typeof dropSession) => { dropSession = fn; } },
  },
};

const { handleMock, MAX_MOCK_RULES, MAX_MOCK_BODY, fulfillParams, urlMatches } = await import('../extension/handlers/mock.js');
const { detachCdp } = await import('../extension/lib/cdp-session.js');

const APP = 'https://app.test/';
const b64 = (s: string) => Buffer.from(s).toString('base64');
const header = (params: any, name: string) => params.responseHeaders.find((h: any) => h.name.toLowerCase() === name)?.value;
const commands = (tabId: number, method: string) => sent.filter(([t, m]) => t === tabId && m === method).map(([, , p]) => p);
const pause = async (tabId: number, requestId: string, url: string, { method = 'GET', headers = {} as Record<string, string> } = {}) => {
  emit({ tabId }, 'Fetch.requestPaused', { requestId, request: { url, method, headers }, resourceType: 'XHR' });
  await vi.advanceTimersByTimeAsync(0);
};
const listed = async (tabId: number) => (await handleMock({ tabId }) as any).text as string;

describe('urlMatches (mock rule patterns)', () => {
  it('a pattern with * is a glob over the whole URL; without * it is a case-sensitive substring', () => {
    expect(urlMatches('*api/items*', 'https://app.test/api/items?page=2')).toBe(true);
    expect(urlMatches('https://app.test/*', 'https://app.test/a/b')).toBe(true);
    expect(urlMatches('api/items*', 'https://app.test/api/items')).toBe(false); // anchored at the start
    expect(urlMatches('a*b*c', 'aXbYc')).toBe(true);
    expect(urlMatches('a*b*c', 'acb')).toBe(false);
    expect(urlMatches('*', 'anything')).toBe(true);
    expect(urlMatches('/api/items', 'https://app.test/api/items')).toBe(true);
    expect(urlMatches('/api/items', 'https://app.test/API/ITEMS')).toBe(false);
  });
});

describe('fulfillParams (the answer to a paused request)', () => {
  it('serves the body as base64 with a guessed content type and the rule status', () => {
    const json = fulfillParams({ status: 201, body: '{"id":7}' }, { method: 'GET', url: 'https://app.test/api', headers: {} });
    expect(json).toEqual({ responseCode: 201, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: b64('{"id":7}') });
    const text = fulfillParams({ body: 'café' }, { method: 'GET', url: 'https://app.test/x', headers: {} });
    expect(text.responseCode).toBe(200);
    expect(header(text, 'content-type')).toBe('text/plain; charset=utf-8');
    expect(Buffer.from(text.body, 'base64').toString('utf8')).toBe('café');
  });

  it('rule headers become response headers and win over the defaults', () => {
    const p = fulfillParams({ body: '<b>x</b>', headers: { 'Content-Type': 'text/html', 'X-Mock': '1' } }, { method: 'GET', url: 'https://app.test/', headers: {} });
    expect(p.responseHeaders).toEqual([{ name: 'Content-Type', value: 'text/html' }, { name: 'X-Mock', value: '1' }]);
  });

  it('allows the requesting origin, and answers its CORS preflight', () => {
    const cross = fulfillParams({ body: '{}', headers: { 'X-Mock': '1' } }, { method: 'POST', url: 'https://api.test/v1', headers: { Origin: 'https://app.test' } });
    expect(header(cross, 'access-control-allow-origin')).toBe('https://app.test');
    expect(header(cross, 'access-control-allow-credentials')).toBe('true');
    expect(header(cross, 'access-control-expose-headers')).toBe('X-Mock'); // else the page cannot read it
    const plain = fulfillParams({ body: '{}' }, { method: 'GET', url: 'https://api.test/v1', headers: { Origin: 'https://app.test' } });
    expect(header(plain, 'access-control-expose-headers')).toBeUndefined();
    const preflight = fulfillParams({ status: 500, body: '{}' }, {
      method: 'OPTIONS', url: 'https://api.test/v1',
      headers: { Origin: 'https://app.test', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
    });
    expect(preflight.responseCode).toBe(204);
    expect(preflight.body).toBeUndefined();
    expect(header(preflight, 'access-control-allow-methods')).toBe('POST');
    expect(header(preflight, 'access-control-allow-headers')).toBe('content-type');
    const own = fulfillParams({ headers: { 'Access-Control-Allow-Origin': '*' } }, { method: 'GET', url: 'https://api.test/', headers: { origin: 'https://app.test' } });
    expect(own.responseHeaders.filter((h: any) => /allow-origin/i.test(h.name))).toEqual([{ name: 'Access-Control-Allow-Origin', value: '*' }]);
    // The rule's own CORS headers answer its preflight too (else the real request is never sent).
    const ownPreflight = fulfillParams({ headers: { 'Access-Control-Allow-Origin': '*', 'X-Mock': '1' } }, {
      method: 'OPTIONS', url: 'https://api.test/', headers: { Origin: 'https://app.test', 'Access-Control-Request-Method': 'PUT' },
    });
    expect(ownPreflight.responseHeaders).toEqual([
      { name: 'Access-Control-Allow-Origin', value: '*' }, { name: 'Access-Control-Allow-Methods', value: 'PUT' },
    ]);
  });
});

describe('browser_mock rules (Fetch domain, one tab)', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    await handleMock({ tabId: 15, rules: [] });
    await handleMock({ tabId: 16, rules: [] });
    await detachCdp(15);
    await detachCdp(16);
    sent.length = 0;
    attachFails = false;
  });
  afterEach(() => { vi.useRealTimers(); });

  it('a glob rule answers the matching requests with its status, body and headers; the rest continues', async () => {
    const res = await handleMock({
      tabId: 15,
      rules: [{ match: '*api/items*', status: 201, body: '{"items":[]}', headers: { 'X-Mock': '1' } }],
    }) as any;
    expect(res).toMatchObject({ success: true, text: '1 rule active on tab 15', active: true });
    // Every request pauses: Chrome cannot filter a CORS preflight by type, and a rule must answer it too.
    expect(commands(15, 'Fetch.enable')).toEqual([{ patterns: [{ urlPattern: '*', requestStage: 'Request' }] }]);

    await pause(15, 'p1', `${APP}api/items?page=2`);
    await pause(15, 'p2', `${APP}app.js`);
    const [answer] = commands(15, 'Fetch.fulfillRequest');
    expect(answer).toMatchObject({ requestId: 'p1', responseCode: 201, body: b64('{"items":[]}') });
    expect(header(answer, 'content-type')).toBe('application/json');
    expect(header(answer, 'x-mock')).toBe('1');
    expect(commands(15, 'Fetch.continueRequest')).toEqual([{ requestId: 'p2' }]);
  });

  it('a pattern without * matches as a substring, case-sensitively', async () => {
    await handleMock({ tabId: 15, rules: [{ match: '/api/items', body: 'x' }] });
    await pause(15, 'upper', `${APP}API/ITEMS`);
    await pause(15, 'lower', `${APP}api/items`);
    expect(commands(15, 'Fetch.fulfillRequest').map((p) => p.requestId)).toEqual(['lower']);
    expect(commands(15, 'Fetch.continueRequest').map((p) => p.requestId)).toEqual(['upper']);
  });

  it('block:true fails the request with BlockedByClient', async () => {
    await handleMock({ tabId: 15, rules: [{ match: 'ads.test', block: true }] });
    await pause(15, 'ad', 'https://ads.test/pixel');
    expect(commands(15, 'Fetch.failRequest')).toEqual([{ requestId: 'ad', errorReason: 'BlockedByClient' }]);
    expect(commands(15, 'Fetch.fulfillRequest')).toEqual([]);
  });

  it('answers the CORS preflight of a mocked cross-origin request with 204 and the allow headers', async () => {
    await handleMock({ tabId: 15, rules: [{ match: 'api.test/save', body: '{}' }] });
    await pause(15, 'pre', 'https://api.test/save', {
      method: 'OPTIONS', headers: { Origin: 'https://app.test', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
    });
    const [preflight] = commands(15, 'Fetch.fulfillRequest');
    expect(preflight.responseCode).toBe(204);
    expect(header(preflight, 'access-control-allow-origin')).toBe('https://app.test');
    expect(header(preflight, 'access-control-allow-methods')).toBe('POST');
    expect(header(preflight, 'access-control-allow-headers')).toBe('content-type');
  });

  it('a rule without status or body answers 200 with an empty body', async () => {
    await handleMock({ tabId: 15, rules: [{ match: '/empty' }] });
    await pause(15, 'e', `${APP}empty`);
    expect(commands(15, 'Fetch.fulfillRequest')).toMatchObject([{ requestId: 'e', responseCode: 200, body: '' }]);
  });

  it('a later set replaces the tab rules; rules: [] clears them and switches the interception off', async () => {
    await handleMock({ tabId: 15, rules: [{ match: '/a', body: 'A' }] });
    const replaced = await handleMock({ tabId: 15, rules: [{ match: '/b', body: 'B' }] }) as any;
    expect(replaced.text).toBe('1 rule active on tab 15');
    await pause(15, 'ra', `${APP}a`);
    await pause(15, 'rb', `${APP}b`);
    expect(commands(15, 'Fetch.fulfillRequest').map((p) => p.requestId)).toEqual(['rb']);
    expect(commands(15, 'Fetch.continueRequest').map((p) => p.requestId)).toEqual(['ra']);

    const cleared = await handleMock({ tabId: 15, rules: [] }) as any;
    expect(cleared.text).toBe('cleared: no rules on tab 15');
    expect(commands(15, 'Fetch.disable')).toHaveLength(1);
    expect(await listed(15)).toBe('no rules on tab 15');
    await pause(15, 'late', `${APP}b`); // in flight when the rules went away: never answered by the old rule
    expect(commands(15, 'Fetch.fulfillRequest').map((p) => p.requestId)).toEqual(['rb']);
  });

  it('the list shows each rule with its hit count', async () => {
    await handleMock({ tabId: 15, rules: [{ match: '*api/items*', status: 200, body: '[]' }, { match: 'ads.test', block: true }] });
    await pause(15, '1', `${APP}api/items?a=1`);
    await pause(15, '2', `${APP}api/items?a=2`);
    await pause(15, '3', `${APP}api/items?a=3`);
    await pause(15, '4', 'https://ads.test/x');
    await pause(15, '5', `${APP}other`);
    expect(await listed(15)).toBe([
      '2 rules active on tab 15:',
      '1. *api/items* → 200 (3 hits)',
      '2. ads.test → blocked (1 hit)',
    ].join('\n'));
  });

  it('a debugger that cannot attach is DEBUGGER_UNAVAILABLE and nothing is stored', async () => {
    attachFails = true;
    await expect(handleMock({ tabId: 16, rules: [{ match: '/api/', body: '{}' }] })).rejects.toThrow(/^DEBUGGER_UNAVAILABLE: cannot intercept requests on tab 16/);
    expect(await listed(16)).toBe('no rules on tab 16');
    expect(commands(16, 'Fetch.enable')).toEqual([]);
  });

  it('closing the debugger banner: the list says inactive, and setting rules again attaches once more', async () => {
    await handleMock({ tabId: 15, rules: [{ match: '/api/', body: '{}' }] });
    dropSession({ tabId: 15 });
    expect(await listed(15)).toBe([
      'inactive (debugger detached): 1 rule on tab 15, not applied:',
      '1. /api/ → 200 (0 hits)',
    ].join('\n'));
    const again = await handleMock({ tabId: 15, rules: [{ match: '/api/', body: '{}' }] }) as any;
    expect(again.text).toBe('1 rule active on tab 15');
    expect(commands(15, 'Fetch.enable')).toHaveLength(2);
    expect(await listed(15)).toMatch(/^1 rule active on tab 15:/);
  });

  it('invalid rule sets are refused whole, and nothing changes', async () => {
    await handleMock({ tabId: 15, rules: [{ match: '/keep', body: 'kept' }] });
    const bad: Array<[unknown, RegExp]> = [
      ['not-an-array', /^INVALID_ARGUMENT: rules must be an array/],
      [Array.from({ length: MAX_MOCK_RULES + 1 }, (_, i) => ({ match: `/r${i}` })), /^INVALID_ARGUMENT: 51 rules/],
      [[{ match: '/x', body: 'y'.repeat(MAX_MOCK_BODY + 1) }], /^INVALID_ARGUMENT: rules\[0\]\.body/],
      [[{ match: '', body: 'x' }], /^INVALID_ARGUMENT: rules\[0\]\.match/],
      [[{ match: '/x', block: true, body: 'x' }], /^INVALID_ARGUMENT: rules\[0\]: block:true takes no/],
      [[{ match: '/x', status: 99 }], /^INVALID_ARGUMENT: rules\[0\]\.status/],
      [[{ match: '/x', headers: { 'X-N': 1 } }], /^INVALID_ARGUMENT: rules\[0\]\.headers/],
    ];
    for (const [rules, error] of bad) {
      await expect(handleMock({ tabId: 15, rules: rules as any })).rejects.toThrow(error);
    }
    expect(await listed(15)).toMatch(/^1 rule active on tab 15:\n1\. \/keep → 200 \(0 hits\)$/);
  });

  it('exactly the limits are accepted: 50 rules, a 20000-char body', async () => {
    const rules = Array.from({ length: MAX_MOCK_RULES }, (_, i) => ({ match: `/r${i}`, body: i === 0 ? 'y'.repeat(MAX_MOCK_BODY) : '' }));
    const res = await handleMock({ tabId: 15, rules }) as any;
    expect(res.text).toBe(`${MAX_MOCK_RULES} rules active on tab 15`);
  });
});
