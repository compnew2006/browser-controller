import { describe, expect, it } from 'vitest';

const { createBodyCapture, redactJsonBody, redactBody, REDACTED } = await import('../extension/lib/response-bodies.js');
const { redactUrl } = await import('../extension/lib/network-capture.js');

/** CDP Network events for one request: sent → response → finished (or failed). */
function load(c: any, id: string, url: string, { method = 'GET', type = 'XHR', wallTime = 1000, mimeType = 'application/json', status = 200, failed = false, encodedDataLength = 300 } = {}) {
  c.onEvent('Network.requestWillBeSent', { requestId: id, request: { url, method }, wallTime, type });
  c.onEvent('Network.responseReceived', { requestId: id, type, response: { url, status, mimeType } });
  return failed
    ? c.onEvent('Network.loadingFailed', { requestId: id, errorText: 'net::ERR_ABORTED' })
    : c.onEvent('Network.loadingFinished', { requestId: id, encodedDataLength });
}

function capture(bodies: Record<string, { body: string; base64Encoded?: boolean } | Error>, opts: object = {}) {
  const asked: string[] = [];
  const c = createBodyCapture({
    getBody: async (id: string) => {
      asked.push(id);
      const b = bodies[id];
      if (b instanceof Error) throw b;
      return { base64Encoded: false, ...b };
    },
    ...opts,
  });
  return { c, asked };
}

describe('response body capture (CDP Network → per-tab body store)', () => {
  it('keeps document/xhr/fetch bodies and finds them for a webRequest entry by method, url and start time', async () => {
    const { c, asked } = capture({ a: { body: '{"n":42}' }, b: { body: '<h1>hi</h1>' }, img: { body: 'xx' } });
    await load(c, 'a', 'https://x.test/api', { wallTime: 1000 });
    await load(c, 'b', 'https://x.test/', { type: 'Document', wallTime: 999.5, mimeType: 'text/html' });
    await load(c, 'img', 'https://x.test/logo.png', { type: 'Image', mimeType: 'image/png' });
    expect(asked).toEqual(['a', 'b']); // images are never read
    // webRequest timestamps are completion times in ms; durationMs gives the start.
    expect(c.find({ method: 'GET', url: 'https://x.test/api', timestamp: 1_000_030, durationMs: 30 }))
      .toMatchObject({ text: '{"n":42}', mimeType: 'application/json', status: 200, length: 8 });
    expect(c.find({ method: 'GET', url: 'https://x.test/', timestamp: 999_520, durationMs: 20 })).toMatchObject({ text: '<h1>hi</h1>' });
    expect(c.find({ method: 'POST', url: 'https://x.test/api', timestamp: 1_000_030, durationMs: 30 })).toBeNull();
    expect(c.find({ method: 'GET', url: 'https://x.test/api', timestamp: 2_000_000, durationMs: 30 })).toBeNull(); // too far apart
  });

  it('picks the closest of repeated requests to the same URL (polling)', async () => {
    const { c } = capture({ p1: { body: 'first' }, p2: { body: 'second' } });
    await load(c, 'p1', 'https://x.test/poll', { wallTime: 1000 });
    await load(c, 'p2', 'https://x.test/poll', { wallTime: 1001 });
    expect(c.find({ method: 'GET', url: 'https://x.test/poll', timestamp: 1_001_010, durationMs: 5 })?.text).toBe('second');
    expect(c.find({ method: 'GET', url: 'https://x.test/poll', timestamp: 1_000_008, durationMs: 5 })?.text).toBe('first');
  });

  it('follows redirects: final URL and method, first hop start time', async () => {
    const { c } = capture({ r: { body: 'done' } });
    c.onEvent('Network.requestWillBeSent', { requestId: 'r', request: { url: 'https://x.test/form', method: 'POST' }, wallTime: 1000, type: 'Document' });
    c.onEvent('Network.requestWillBeSent', { requestId: 'r', request: { url: 'https://x.test/thanks', method: 'GET' }, wallTime: 1000.2, type: 'Document', redirectResponse: { status: 303 } });
    c.onEvent('Network.responseReceived', { requestId: 'r', response: { status: 200, mimeType: 'text/html' } });
    await c.onEvent('Network.loadingFinished', { requestId: 'r' });
    expect(c.find({ method: 'GET', url: 'https://x.test/thanks', timestamp: 1_000_300, durationMs: 300 })?.text).toBe('done');
  });

  it('records why a body is missing: failed loads are dropped, unreadable bodies keep the error', async () => {
    const { c } = capture({ gone: new Error('No resource with given identifier found') });
    await load(c, 'f', 'https://x.test/fail', { failed: true });
    await load(c, 'gone', 'https://x.test/gone');
    expect(c.find({ method: 'GET', url: 'https://x.test/fail', timestamp: 1_000_010, durationMs: 10 })).toBeNull();
    expect(c.find({ method: 'GET', url: 'https://x.test/gone', timestamp: 1_000_010, durationMs: 10 }))
      .toMatchObject({ error: 'No resource with given identifier found' });
  });

  it('decodes base64 text, never reads binary or huge bodies, truncates long text', async () => {
    const { c, asked } = capture({
      t: { body: Buffer.from('{"ok":true}').toString('base64'), base64Encoded: true },
      bin: { body: 'never read' },
      huge: { body: 'never read' },
      long: { body: 'x'.repeat(50) },
    }, { maxChars: 20 });
    await load(c, 't', 'https://x.test/t');
    await load(c, 'bin', 'https://x.test/bin', { mimeType: 'video/mp4', encodedDataLength: 40_000_000 });
    await load(c, 'huge', 'https://x.test/huge', { encodedDataLength: 6_000_000 });
    await load(c, 'long', 'https://x.test/long', { mimeType: 'text/plain' });
    expect(asked).toEqual(['t', 'long']);
    const at = { timestamp: 1_000_010, durationMs: 10, method: 'GET' };
    expect(c.find({ ...at, url: 'https://x.test/t' })).toMatchObject({ text: '{"ok":true}', length: 11 });
    const bin = c.find({ ...at, url: 'https://x.test/bin' });
    expect(bin).toMatchObject({ binary: true, transferSize: 40_000_000, mimeType: 'video/mp4' });
    expect(bin.text).toBeUndefined();
    expect(c.find({ ...at, url: 'https://x.test/huge' })).toMatchObject({ tooLarge: true, transferSize: 6_000_000 });
    expect(c.find({ ...at, url: 'https://x.test/long' })).toMatchObject({ text: 'x'.repeat(20), length: 50, truncated: true });
  });

  it('keeps only the newest maxBodies and clears on demand', async () => {
    const { c } = capture({ a: { body: '1' }, b: { body: '2' }, d: { body: '3' } }, { maxBodies: 2 });
    for (const [i, id] of ['a', 'b', 'd'].entries()) await load(c, id, `https://x.test/${id}`, { wallTime: 1000 + i });
    expect(c.size).toBe(2);
    expect(c.find({ method: 'GET', url: 'https://x.test/a', timestamp: 1_000_005, durationMs: 5 })).toBeNull();
    c.clear();
    expect(c.size).toBe(0);
  });

  it('redacts credential values in JSON bodies before storing them', async () => {
    const { c } = capture({ tok: { body: JSON.stringify({ access_token: 'abc', expires_in: 3600, user: { name: 'Ann', password: 'pw' }, max_tokens: 50 }) } });
    await load(c, 'tok', 'https://x.test/oauth/token');
    const got = c.find({ method: 'GET', url: 'https://x.test/oauth/token', timestamp: 1_000_010, durationMs: 10 });
    expect(JSON.parse(got.text)).toEqual({ access_token: REDACTED, expires_in: 3600, user: { name: 'Ann', password: REDACTED }, max_tokens: 50 });
    expect(got.redacted).toEqual(['access_token', 'password']);
    expect(got.text).not.toContain('abc');
  });
});

describe('redactJsonBody', () => {
  it('only touches values of credential keys, and leaves non-JSON alone', () => {
    expect(redactJsonBody('{"author":"Ann","sessionId":"s1","apiKey":"k","max_tokens":3}')).toEqual({
      text: JSON.stringify({ author: 'Ann', sessionId: REDACTED, apiKey: REDACTED, max_tokens: 3 }),
      redacted: ['sessionId', 'apiKey'],
    });
    expect(redactJsonBody('[{"refresh_token":"r"}]').redacted).toEqual(['refresh_token']);
    // Every scalar below a credential key (string or number), not just directly under it.
    const nested = redactJsonBody('{"tokens":["eyJ1","r1"],"secret":{"value":"sk_live","n":2},"pin":{"password":1234}}');
    expect(JSON.parse(nested.text)).toEqual({ tokens: [REDACTED, REDACTED], secret: { value: REDACTED, n: REDACTED }, pin: { password: REDACTED } });
    expect(nested.redacted).toEqual(['tokens', 'secret', 'password']);
    expect(redactJsonBody('{"a":1}')).toEqual({ text: '{"a":1}', redacted: [] }); // untouched text keeps its formatting
    expect(redactJsonBody('token=abc')).toEqual({ text: 'token=abc', redacted: [] });
  });
});

describe('non-JSON bodies are redacted too (L2)', () => {
  it('an HTML page keeps a secret-looking key/value pair out and says which key', () => {
    const html = '<script>window.app={"sessionToken":"tok-123","page":2}</script><p>hi</p>';
    const got = redactBody(html);
    expect(got.text).not.toContain('tok-123');
    expect(got.text).toContain('"sessionToken":"[redacted]"');
    expect(got.text).toContain('"page":2');
    expect(got.redacted).toEqual(['sessionToken']);
  });

  it('a form body redacts its password and token fields and keeps the rest', () => {
    const got = redactBody('user=ann&password=hunter2&token=abc&page=2');
    expect(got.text).toBe('user=ann&password=[redacted]&token=[redacted]&page=2');
    expect(got.redacted).toEqual(['password', 'token']);
  });

  it('JSON cut off before its end is still redacted as text', () => {
    const got = redactBody('{"password":"hunter2","items":[1,2');
    expect(got.text).not.toContain('hunter2');
    expect(got.redacted).toEqual(['password']);
  });

  it('a text body with nothing secret-looking comes back unchanged and not flagged', () => {
    expect(redactBody('<h1>Orders</h1><p>3 open</p>')).toEqual({ text: '<h1>Orders</h1><p>3 open</p>', redacted: [] });
  });

  it('a captured HTML body is stored redacted, and its request is still found by the URL with a secret', async () => {
    const { c } = capture({ h: { body: '<form>password=hunter2&page=2</form>' } });
    await load(c, 'h', 'https://x.test/login?token=abc&next=/home', { type: 'Document', mimeType: 'text/html' });
    const found = c.find({ method: 'GET', url: 'https://x.test/login?token=***&next=/home', timestamp: 1000000, durationMs: 0 });
    expect(found.text).not.toContain('hunter2');
    expect(found.text).toContain('page=2');
    expect(found.redacted).toEqual(['password']);
  });
});

describe('secret query values in URLs (L3)', () => {
  it('replaces the value of a secret-looking key, keeps the key and the other values', () => {
    expect(redactUrl('https://api.test/items?access_token=abc123&page=2&Password=p%40ss')).toBe(
      'https://api.test/items?access_token=***&page=2&Password=***',
    );
  });

  it('leaves URLs without a query, and queries without secret keys, unchanged', () => {
    expect(redactUrl('https://api.test/items')).toBe('https://api.test/items');
    expect(redactUrl('https://api.test/items?page=2&q=cats')).toBe('https://api.test/items?page=2&q=cats');
  });
});
