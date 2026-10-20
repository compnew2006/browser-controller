import { beforeEach, describe, expect, it } from 'vitest';

(globalThis as any).chrome = {
  tabs: { get: async (id: number) => ({ id, url: 'https://example.test/', windowId: 1 }) },
  storage: { session: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({}), set: async () => {} } },
};

const { createNetworkCapture, summarizeRequestBody, pushNetworkEntry, listView, BODY_PREVIEW_MAX, REDACTED } =
  await import('../extension/lib/network-capture.js');
const { handleLogs } = await import('../extension/handlers/logs.js');
const { networkByTab, getTabBuffer } = await import('../extension/lib/state.js');

const bytes = (text: string) => ({ bytes: new TextEncoder().encode(text).buffer });
const rawBody = (text: string) => ({ raw: [bytes(text)] });

describe('request body preview (browser_logs requestId view)', () => {
  it('summarises form data by field and redacts the values of secret-looking keys', () => {
    expect(summarizeRequestBody({ formData: { user: ['ann'], password: ['hunter2'], api_key: ['k-1', 'k-2'] } })).toEqual({
      kind: 'form',
      fields: { user: ['ann'], password: [REDACTED], api_key: [REDACTED, REDACTED] },
    });
  });

  it('redacts secret values at any depth of a JSON body and keeps the rest', () => {
    const body = summarizeRequestBody(rawBody('{"user":"ann","auth":{"api_key":"k-123","items":[{"token":"t-9"}]},"note":"hi"}'));
    expect(body).toMatchObject({ kind: 'raw', size: expect.any(Number) });
    const preview = JSON.parse((body as { preview: string }).preview);
    expect(preview).toEqual({ user: 'ann', auth: { api_key: REDACTED, items: [{ token: REDACTED }] }, note: 'hi' });
  });

  it('redacts form-encoded pairs and leaves other pairs alone', () => {
    const body = summarizeRequestBody(rawBody('grant=password&username=ann&password=hunter2&client_secret=s3'));
    const preview = (body as { preview: string }).preview;
    expect(preview).toBe(`grant=password&username=ann&password=${REDACTED}&client_secret=${REDACTED}`);
    expect(preview).not.toContain('hunter2');
  });

  it('a large base64 or hex body is summarised quickly (no quadratic regex scan)', () => {
    const started = Date.now();
    const base64 = summarizeRequestBody(rawBody('QUJD'.repeat(16384))) as { preview: string; truncated: boolean };
    const hex = summarizeRequestBody(rawBody('ab12'.repeat(16384))) as { preview: string };
    expect(Date.now() - started).toBeLessThan(1000);
    expect(base64.truncated).toBe(true);
    expect(hex.preview.length).toBeLessThanOrEqual(BODY_PREVIEW_MAX + 64);
  });

  it('a secret nested under a plain key is redacted in a body too large to parse', () => {
    const body = summarizeRequestBody(rawBody(`{"a":{"api_key":"sk-live-123"},"pad":"${'x'.repeat(70 * 1024)}"}`)) as { preview: string };
    expect(body.preview).not.toContain('sk-live-123');
    expect(body.preview).toContain(`"api_key":"${REDACTED}"`);
  });

  it('a body too large to parse still has its secret values redacted in the preview', () => {
    const padding = 'x'.repeat(70 * 1024);
    const body = summarizeRequestBody(rawBody(`{"password":"hunter2","pad":"${padding}"}`));
    const preview = (body as { preview: string; truncated?: boolean });
    expect(preview.preview).not.toContain('hunter2');
    expect(preview.preview.length).toBeLessThanOrEqual(BODY_PREVIEW_MAX + 64);
    expect(preview.truncated).toBe(true);
  });

  it('keeps a bounded preview of a long text body and flags it as truncated', () => {
    const body = summarizeRequestBody(rawBody('a'.repeat(5000))) as { preview: string; size: number; truncated: boolean };
    expect(body.size).toBe(5000);
    expect(body.preview.startsWith('a'.repeat(BODY_PREVIEW_MAX))).toBe(true);
    expect(body.preview.length).toBeLessThan(BODY_PREVIEW_MAX + 64);
    expect(body.truncated).toBe(true);
  });

  it('shows only the size of binary data', () => {
    const data = { raw: [{ bytes: new Uint8Array([0, 1, 2, 255, 254, 0]).buffer }] };
    expect(summarizeRequestBody(data)).toEqual({ kind: 'binary', size: 6 });
  });

  it('a file upload part is counted, not read', () => {
    expect(summarizeRequestBody({ raw: [{ file: '/Users/someone/secret.pdf' }] })).toEqual({ kind: 'files', files: 1 });
    expect(summarizeRequestBody({})).toBeUndefined();
  });

  it('is attached to the request when the listener receives a body, and not to the list view', () => {
    const stored: any[] = [];
    const c = createNetworkCapture({ store: (_tab: number, entry: any) => stored.push(entry) });
    c.onBeforeRequest({ requestId: 'p1', tabId: 5, url: 'https://example.test/login', method: 'POST', type: 'xmlhttprequest', timeStamp: 10, requestBody: { formData: { password: ['pw'], user: ['ann'] } } });
    c.onCompleted({ requestId: 'p1', tabId: 5, url: 'https://example.test/login', method: 'POST', type: 'xmlhttprequest', statusCode: 200, timeStamp: 12 });
    expect(stored[0].requestBody).toEqual({ kind: 'form', fields: { password: [REDACTED], user: ['ann'] } });
    expect(listView(stored[0])).not.toHaveProperty('requestBody');
  });
});

describe('network buffer eviction', () => {
  beforeEach(() => { networkByTab.clear(); });

  it('a full buffer drops static assets before any API call, then the oldest entry', () => {
    const buf = getTabBuffer(networkByTab, 5);
    for (let i = 0; i < 200; i++) pushNetworkEntry(buf, { id: `x${i}`, url: `https://example.test/api/${i}`, type: 'xmlhttprequest' });
    pushNetworkEntry(buf, { id: 'img', url: 'https://example.test/a.png', type: 'image' });
    expect(buf).toHaveLength(200);
    expect(buf.map((e: any) => e.id)).not.toContain('img');
    expect(buf[0].id).toBe('x0');
    pushNetworkEntry(buf, { id: 'x200', url: 'https://example.test/api/200', type: 'xmlhttprequest' });
    expect(buf).toHaveLength(200);
    expect(buf[0].id).toBe('x1'); // no static entries left: the oldest API call goes
  });

  it('static assets are evicted first even when they are the newest entries', () => {
    const buf = getTabBuffer(networkByTab, 5);
    pushNetworkEntry(buf, { id: 'doc', url: 'https://example.test/', type: 'main_frame' }, 3);
    pushNetworkEntry(buf, { id: 'img1', url: 'https://example.test/1.png', type: 'image' }, 3);
    pushNetworkEntry(buf, { id: 'xhr', url: 'https://example.test/api', type: 'xmlhttprequest' }, 3);
    pushNetworkEntry(buf, { id: 'font', url: 'https://example.test/f.woff', type: 'font' }, 3);
    expect(buf.map((e: any) => e.id)).toEqual(['doc', 'xhr', 'font']);
  });
});

describe('list view', () => {
  it('lists only network fields: no intercept data, bodies or headers leak in', () => {
    const entry = {
      id: '1', method: 'POST', url: 'https://example.test/api', status: 200, type: 'xmlhttprequest', timestamp: 1, durationMs: 3,
      requestHeaders: [], responseHeaders: [], requestBody: { kind: 'raw', size: 2, preview: '{}' },
      intercept: { matchedRuleIds: ['r1'], applied: [] },
    };
    expect(Object.keys(listView(entry)).sort()).toEqual(['durationMs', 'id', 'method', 'status', 'timestamp', 'type', 'url']);
  });
});

describe('browser_logs requestId view carries the body preview', () => {
  beforeEach(() => {
    networkByTab.clear();
    const c = createNetworkCapture({ store: (tabId: number, entry: any) => pushNetworkEntry(getTabBuffer(networkByTab, tabId), entry) });
    c.onBeforeRequest({ requestId: 'b1', tabId: 5, url: 'https://example.test/api/session', method: 'POST', type: 'xmlhttprequest', timeStamp: 1, requestBody: { raw: [bytes('{"token":"abc","n":1}')] } });
    c.onCompleted({ requestId: 'b1', tabId: 5, url: 'https://example.test/api/session', method: 'POST', type: 'xmlhttprequest', statusCode: 201, timeStamp: 2 });
  });

  it('returns the body in full by requestId, redacted, and keeps it out of the list', async () => {
    const list = await handleLogs({ tabId: 5, kind: 'network' }) as any;
    expect(list.requests[0]).not.toHaveProperty('requestBody');
    const one = await handleLogs({ tabId: 5, requestId: 'b1' }) as any;
    expect(one.request.requestBody.preview).toBe(`{"token":"${REDACTED}","n":1}`);
    expect(one.text).toContain(`payload (${one.request.requestBody.size} bytes): {"token":"${REDACTED}","n":1}`);
  });
});
