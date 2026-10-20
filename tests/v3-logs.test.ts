import { beforeEach, describe, expect, it } from 'vitest';

/**
 * browser_logs (3.0): console lines from the Runtime replay, network lines from the webRequest
 * buffer, one request in full, response bodies through CDP Network. chrome.debugger is mocked:
 * Runtime.enable replays the scripted console calls to the tab's subscribers.
 */
const APP = 'https://app.test/app.js';
const TAB = 11;
const WALL = 1_700_000_000; // seconds, as CDP sends wallTime
const sent: Array<[number, string, any]> = [];
const bodies: Record<string, string> = {};
let replay: Array<[string, any]> = [];
let emit: (source: { tabId: number }, method: string, params: unknown) => void = () => {};
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
      if (method === 'Runtime.enable') for (const [m, p] of replay) emit({ tabId }, m, p);
      if (method === 'Network.getResponseBody') return { body: bodies[params.requestId], base64Encoded: false };
      return { result: { value: 1 } };
    },
    onEvent: { addListener: (fn: typeof emit) => { emit = fn; } },
    onDetach: { addListener: () => {} },
  },
};

const { handleLogs } = await import('../extension/handlers/logs.js');
const { networkByTab, getTabBuffer, dropTabState } = await import('../extension/lib/state.js');
const { detachCdp } = await import('../extension/lib/cdp-session.js');

const str = (value: string) => ({ type: 'string', value });
const frame = (functionName: string, lineNumber: number) => ({ functionName, url: APP, lineNumber, columnNumber: 2 });
const clock = (ts: number) => new Date(ts).toTimeString().slice(0, 8);
const push = (entry: Record<string, unknown>) => getTabBuffer(networkByTab, TAB).push(entry);
const lines = (text: string) => text.split('\n');

beforeEach(async () => {
  dropTabState(TAB);
  await detachCdp(TAB);
  sent.length = 0;
  replay = [];
  attachFails = false;
});

describe('browser_logs console block', () => {
  it('prints `error HH:MM:SS message (src:line)` and up to three stack lines for an error', async () => {
    const at = 1_700_000_100_000;
    replay = [['Runtime.consoleAPICalled', {
      type: 'error', timestamp: at, args: [str('save failed')],
      stackTrace: { callFrames: [frame('save', 9), frame('onClick', 19), frame('dispatch', 30), frame('extra', 40)] },
    }]];
    const res = await handleLogs({ tabId: TAB, kind: 'console' }) as any;
    expect(res.text).toBe([
      'console (1):',
      `error ${clock(at)} save failed (${APP}:10)`,
      `  at save (${APP}:10:3)`,
      `  at onClick (${APP}:20:3)`,
      `  at dispatch (${APP}:31:3)`,
    ].join('\n'));
    expect(res.messages[0]).toMatchObject({ level: 'error', source: `${APP}:10` });
  });

  it('includes uncaught errors and rejections, each location printed once', async () => {
    const at = 1_700_000_200_000;
    replay = [
      ['Runtime.exceptionThrown', { timestamp: at, exceptionDetails: { text: 'Uncaught', url: APP, lineNumber: 4, exception: { type: 'object', subtype: 'error', description: 'TypeError: x is not a function\n    at https://app.test/:5:30' } } }],
      ['Runtime.exceptionThrown', { timestamp: at + 1, exceptionDetails: { text: 'Uncaught (in promise)', url: APP, lineNumber: 9, exception: { type: 'string', value: 'nope' } } }],
    ];
    const res = await handleLogs({ tabId: TAB, kind: 'console' }) as any;
    expect(res.text).toBe([
      'console (2):',
      `error ${clock(at)} Uncaught TypeError: x is not a function (${APP}:5)`,
      '  at https://app.test/:5:30',
      `error ${clock(at + 1)} Uncaught (in promise) nope (${APP}:10)`,
    ].join('\n'));
  });

  it('filter is a case-insensitive substring of the message; errors:true keeps console errors only', async () => {
    replay = [
      ['Runtime.consoleAPICalled', { type: 'log', timestamp: 1, args: [str('alpha')] }],
      ['Runtime.consoleAPICalled', { type: 'error', timestamp: 2, args: [str('beta')] }],
      ['Runtime.consoleAPICalled', { type: 'warning', timestamp: 3, args: [str('gamma BETA')] }],
    ];
    const filtered = await handleLogs({ tabId: TAB, kind: 'console', filter: 'beta' }) as any;
    expect(filtered.messages.map((m: any) => m.text)).toEqual(['beta', 'gamma BETA']);
    expect(filtered.text.split('\n')[0]).toBe('console (2):');
    const errors = await handleLogs({ tabId: TAB, kind: 'console', errors: true }) as any;
    expect(errors.messages.map((m: any) => m.text)).toEqual(['beta']);
  });

  it('limit keeps the latest entries and says how many older ones were left out', async () => {
    replay = [
      ['Runtime.consoleAPICalled', { type: 'log', timestamp: 1, args: [str('alpha')] }],
      ['Runtime.consoleAPICalled', { type: 'log', timestamp: 2, args: [str('beta')] }],
      ['Runtime.consoleAPICalled', { type: 'log', timestamp: 3, args: [str('gamma')] }],
    ];
    const res = await handleLogs({ tabId: TAB, kind: 'console', limit: 1 }) as any;
    expect(res.messages.map((m: any) => m.text)).toEqual(['gamma']);
    expect(lines(res.text)[2]).toMatch(/^… 2 older not shown \(limit 1;/);
  });

  it('clear discards the console entries in Chrome', async () => {
    replay = [['Runtime.consoleAPICalled', { type: 'log', timestamp: 1, args: [str('a')] }]];
    await handleLogs({ tabId: TAB, kind: 'console', clear: true });
    expect(sent.map(([, m]) => m)).toContain('Runtime.discardConsoleEntries');
  });

  it('a debugger that cannot attach is DEBUGGER_UNAVAILABLE', async () => {
    attachFails = true;
    await expect(handleLogs({ tabId: TAB, kind: 'console' })).rejects.toThrow(/^DEBUGGER_UNAVAILABLE: cannot attach the debugger to tab 11/);
  });
});

describe('browser_logs network block', () => {
  it('prints one line per request: id, method, status or error, type, size, duration, URL', async () => {
    push({ id: '17', method: 'GET', url: 'https://api.test/items', status: 200, type: 'xmlhttprequest', durationMs: 120, responseHeaders: [{ name: 'Content-Length', value: '1200' }] });
    push({ id: '18', method: 'POST', url: 'https://ads.test/pixel', error: 'net::ERR_BLOCKED_BY_CLIENT', type: 'image', durationMs: 5 });
    push({ id: '19', method: 'GET', url: 'https://api.test/missing', status: 404, type: 'xmlhttprequest', durationMs: 8 });
    push({ id: '20', method: 'GET', url: 'https://app.test/', status: 200, type: 'main_frame', durationMs: 30 });
    const res = await handleLogs({ tabId: TAB, kind: 'network' }) as any;
    expect(res.text).toBe([
      'network (4):',
      'r17 GET 200 xhr 1.2kB 120ms https://api.test/items',
      'r18 POST ERR_BLOCKED_BY_CLIENT image 5ms https://ads.test/pixel',
      'r19 GET 404 xhr 8ms https://api.test/missing',
      'r20 GET 200 document 30ms https://app.test/',
    ].join('\n'));
    expect(sent).toEqual([]); // the network block never touches the debugger
  });

  it('errors:true keeps failed, 4xx and 5xx requests only; filter matches the URL', async () => {
    push({ id: '1', method: 'GET', url: 'https://api.test/ok', status: 200, type: 'xmlhttprequest' });
    push({ id: '2', method: 'GET', url: 'https://api.test/bad', status: 500, type: 'xmlhttprequest' });
    push({ id: '3', method: 'GET', url: 'https://ads.test/x', error: 'net::ERR_BLOCKED_BY_CLIENT', type: 'script' });
    const errors = await handleLogs({ tabId: TAB, kind: 'network', errors: true }) as any;
    expect(errors.requests.map((r: any) => r.id)).toEqual(['2', '3']);
    expect(lines(errors.text)[0]).toBe('network (2):');
    const filtered = await handleLogs({ tabId: TAB, kind: 'network', filter: 'API.TEST/OK' }) as any;
    expect(filtered.requests.map((r: any) => r.id)).toEqual(['1']);
  });

  it('a URL over 120 characters is cut in the line; the data keeps it whole', async () => {
    const long = `https://api.test/track?${'q=abcdefghij&'.repeat(20)}`;
    push({ id: '5', method: 'GET', url: long, status: 204, type: 'image', durationMs: 3 });
    const res = await handleLogs({ tabId: TAB, kind: 'network' }) as any;
    const line = lines(res.text)[1];
    expect(line.slice(line.indexOf('https://'))).toHaveLength(120);
    expect(line.endsWith('…')).toBe(true);
    expect(res.requests[0].url).toBe(long);
  });

  it('shows the latest 50 by default, up to 200 with limit', async () => {
    for (let i = 1; i <= 60; i++) push({ id: String(i), method: 'GET', url: `https://api.test/${i}`, status: 200, type: 'xmlhttprequest' });
    const def = await handleLogs({ tabId: TAB, kind: 'network' }) as any;
    expect(lines(def.text)[0]).toBe('network (50):');
    expect(lines(def.text)[1]).toMatch(/^r11 /);
    expect(lines(def.text).at(-2)).toMatch(/^r60 /);
    expect(lines(def.text).at(-1)).toMatch(/^… 10 older not shown \(limit 50;/);
    const all = await handleLogs({ tabId: TAB, kind: 'network', limit: 200 }) as any;
    expect(all.requests).toHaveLength(60);
    await expect(handleLogs({ tabId: TAB, kind: 'network', limit: 201 })).rejects.toThrow(/^INVALID_ARGUMENT: limit/);
  });

  it('clear empties the request buffer and leaves the console alone', async () => {
    replay = [['Runtime.consoleAPICalled', { type: 'log', timestamp: 1, args: [str('kept')] }]];
    push({ id: '1', method: 'GET', url: 'https://api.test/a', status: 200, type: 'xmlhttprequest' });
    await handleLogs({ tabId: TAB, kind: 'network', clear: true });
    expect(getTabBuffer(networkByTab, TAB)).toHaveLength(0);
    expect(sent.some(([, m]) => m === 'Runtime.discardConsoleEntries')).toBe(false);
  });

  it('kind left out with clear clears both blocks', async () => {
    replay = [['Runtime.consoleAPICalled', { type: 'log', timestamp: 1, args: [str('gone')] }]];
    push({ id: '1', method: 'GET', url: 'https://api.test/a', status: 200, type: 'xmlhttprequest' });
    const res = await handleLogs({ tabId: TAB, clear: true }) as any;
    expect(res.messages.map((m: any) => m.text)).toEqual(['gone']);
    expect(sent.some(([, m]) => m === 'Runtime.discardConsoleEntries')).toBe(true);
    expect(getTabBuffer(networkByTab, TAB)).toHaveLength(0);
  });
});

describe('browser_logs requestId detail', () => {
  it('shows method, URL, status, timing, redacted headers and the form payload; r-prefix and bare id both work', async () => {
    push({
      id: '21', method: 'POST', url: 'https://api.test/login', status: 200, type: 'xmlhttprequest', durationMs: 42,
      requestHeaders: [{ name: 'Authorization', value: '[redacted]' }, { name: 'Content-Type', value: 'application/x-www-form-urlencoded' }],
      responseHeaders: [{ name: 'content-type', value: 'application/json' }],
      requestBody: { kind: 'form', fields: { user: ['ann'], password: ['[redacted]'] } },
    });
    const one = await handleLogs({ tabId: TAB, requestId: 'r21' }) as any;
    expect(one.text).toBe([
      'r21 POST https://api.test/login',
      'status: 200',
      'type: xhr',
      'timing: 42ms',
      'request headers:',
      '  Authorization: [redacted]',
      '  Content-Type: application/x-www-form-urlencoded',
      'response headers:',
      '  content-type: application/json',
      'payload (form): user=ann&password=[redacted]',
      'response body: capture is off: call browser_logs with bodies:true, then repeat the request',
    ].join('\n'));
    expect((await handleLogs({ tabId: TAB, requestId: '21' }) as any).request.id).toBe('21');
  });

  it('an unknown id is NOT_FOUND: request <id>', async () => {
    await expect(handleLogs({ tabId: TAB, requestId: 'r999' })).rejects.toThrow(/^NOT_FOUND: request r999/);
  });

  it('bodies:true keeps response bodies from then on; the body comes back redacted by requestId', async () => {
    push({ id: '22', method: 'POST', url: 'https://api.test/session', status: 200, type: 'xmlhttprequest', durationMs: 42, timestamp: WALL * 1000 + 50 });
    const started = await handleLogs({ tabId: TAB, kind: 'network', bodies: true }) as any;
    expect(started.text).toBe('network (1):\nr22 POST 200 xhr 42ms https://api.test/session\nresponse bodies: capture on for tab 11. Repeat the request, then read its body: browser_logs { tabId, requestId }.');
    // The request is repeated: CDP sees it (method + URL), the webRequest entry for it is pushed too.
    bodies.c1 = '{"token":"abc","items":[1]}';
    emit({ tabId: TAB }, 'Network.requestWillBeSent', { requestId: 'c1', request: { url: 'https://api.test/session', method: 'POST' }, wallTime: WALL, type: 'XHR' });
    emit({ tabId: TAB }, 'Network.responseReceived', { requestId: 'c1', response: { status: 200, mimeType: 'application/json' } });
    emit({ tabId: TAB }, 'Network.loadingFinished', { requestId: 'c1', encodedDataLength: 40 });
    await new Promise((r) => setTimeout(r, 5));
    const one = await handleLogs({ tabId: TAB, requestId: 'r22', bodies: true }) as any;
    expect(one.request.responseBody).toMatchObject({ text: '{"token":"[redacted]","items":[1]}', redacted: ['token'] });
    const safe = '{"token":"[redacted]","items":[1]}';
    expect(one.text).toContain(`response body (${safe.length} chars, secrets redacted):\n${safe}`);
    expect(one.text).not.toContain('abc');
    expect(one.bodyCapture).toEqual({ active: true, bodies: 1 });
  });

  it('bodies:false stops the capture; a body already kept stays readable', async () => {
    await handleLogs({ tabId: TAB, kind: 'network', bodies: true });
    const stopped = await handleLogs({ tabId: TAB, kind: 'network', bodies: false }) as any;
    expect(stopped.text).toBe('network (0):\nresponse bodies: capture off for tab 11.');
    expect(stopped.bodyCapture).toEqual({ active: false, bodies: 0 });
  });

  it('clear cannot be combined with requestId, bodies cannot be asked for the console', async () => {
    await expect(handleLogs({ tabId: TAB, requestId: 'r1', clear: true })).rejects.toThrow(/^INVALID_ARGUMENT: clear/);
    await expect(handleLogs({ tabId: TAB, kind: 'console', bodies: true })).rejects.toThrow(/^INVALID_ARGUMENT: bodies/);
    await expect(handleLogs({ tabId: TAB, kind: 'console', requestId: 'r1' })).rejects.toThrow(/^INVALID_ARGUMENT: requestId/);
  });
});
