import { describe, expect, it } from 'vitest';

(globalThis as any).chrome = {
  tabs: { get: async (id: number) => ({ id, url: 'https://example.test/', windowId: 1 }) },
  storage: { session: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({}), set: async () => {} } },
};

const { isSecretKey } = await import('../extension/lib/secret-keys.js');
const { redactJsonBody, redactBody, REDACTED } = await import('../extension/lib/response-bodies.js');
const { summarizeRequestBody, redactTextKeys, redactUrl } = await import('../extension/lib/network-capture.js');

const SECRET_KEYS = [
  'password', 'passwd', 'pass', 'pwd', 'passphrase', 'token', 'access_token', 'accessToken', 'secret', 'client_secret',
  'authorization', 'Authorization', 'api_key', 'api-key', 'apiKey', 'apikey', 'X-API-Key', 'credential', 'credentials',
  'private_key', 'privateKey', 'cookie', 'session_id', 'sessionId', 'user_pass', 'userPass',
  // One-word compounds the old request-side policy caught (/pass|pwd/): they must not leak.
  'dbpass', 'smtppass', 'adminpass', 'userpwd', 'pwdhash',
];
const PLAIN_KEYS = ['author', 'passive', 'compass', 'bypass', 'passenger', 'name', 'id', 'keyboard', 'monkey', 'surpass', 'session', 'private'];

describe('shared secret-key policy', () => {
  it.each(SECRET_KEYS)('treats %s as secret', (key) => expect(isSecretKey(key)).toBe(true));
  it.each(PLAIN_KEYS)('does not treat %s as secret', (key) => expect(isSecretKey(key)).toBe(false));
});

describe('response body redaction uses the shared policy for every scalar type', () => {
  it.each(SECRET_KEYS)('JSON body: %s', (key) => {
    const out = redactJsonBody(JSON.stringify({ [key]: 'hunter2', keep: 'ok' }));
    expect(JSON.parse(out.text)).toEqual({ [key]: REDACTED, keep: 'ok' });
    expect(out.redacted).toEqual([key]);
  });

  it('redacts numbers and booleans under a secret key, and nested or array scalars', () => {
    const out = redactJsonBody(JSON.stringify({
      password: 1234, token: true, pin: { pwd: 99, flags: [false, 7] }, secret: { a: { b: 5 }, c: [1, 'x', true] }, credentials: [1, 2],
    }));
    expect(JSON.parse(out.text)).toEqual({
      password: REDACTED, token: REDACTED, pin: { pwd: REDACTED, flags: [false, 7] },
      secret: { a: { b: REDACTED }, c: [REDACTED, REDACTED, REDACTED] }, credentials: [REDACTED, REDACTED],
    });
  });

  it('keeps null and keeps quantity counters such as max_tokens', () => {
    const out = redactJsonBody('{"password":null,"max_tokens":50,"total_tokens":7,"prompt_tokens":3}');
    expect(out.redacted).toEqual([]);
  });

  it('does not redact look-alike keys', () => {
    const body = JSON.stringify(Object.fromEntries(PLAIN_KEYS.map((k) => [k, 'v'])));
    expect(redactJsonBody(body)).toEqual({ text: body, redacted: [] });
  });

  it('non-JSON text goes through the same policy', () => {
    expect(redactBody('passive=1&pwd=abc&compass=n').text).toBe(`passive=1&pwd=${REDACTED}&compass=n`);
  });
});

describe('request side uses the shared policy', () => {
  it.each(SECRET_KEYS)('form field: %s', (key) => {
    expect(summarizeRequestBody({ formData: { [key]: ['v'] } })).toEqual({ kind: 'form', fields: { [key]: [REDACTED] } });
  });
  it.each(PLAIN_KEYS)('form field kept: %s', (key) => {
    expect(summarizeRequestBody({ formData: { [key]: ['v'] } })).toEqual({ kind: 'form', fields: { [key]: ['v'] } });
  });
  it('text pairs and URL query follow the policy', () => {
    expect(redactTextKeys('compass=n&bypass=1&pwd=x&private_key=k').text).toBe(`compass=n&bypass=1&pwd=${REDACTED}&private_key=${REDACTED}`);
    expect(redactUrl('https://e.test/?passive=1&pwd=x&credential=y')).toBe('https://e.test/?passive=1&pwd=***&credential=***');
  });
  it('JSON request body redacts numbers under a secret key', () => {
    const bytes = new TextEncoder().encode('{"pwd":1234,"flag":true,"secret":false}').buffer;
    const body = summarizeRequestBody({ raw: [{ bytes }] }) as { preview: string };
    expect(JSON.parse(body.preview)).toEqual({ pwd: REDACTED, flag: true, secret: REDACTED });
  });
});
