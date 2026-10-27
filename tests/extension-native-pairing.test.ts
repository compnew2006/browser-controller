import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeHttpAuthenticator } from '../mcp-server/src/bridge-auth.js';
import { PAIRING_TIMEOUT_MS } from '../extension/lib/connection-transport.js';

/**
 * Zero-touch pairing obtains the enrollment secret through Chrome native
 * messaging. The daemon challenge proves its identity before the extension
 * sends any request proof; no raw secret is sent over HTTP.
 */

let store: Record<string, unknown>;
let nativeReplies: unknown[];
let nativeCalls: unknown[][];
let httpCalls: Array<{ url: string; enrollmentHeader: boolean }>;
let statusMessages: string[];
let daemon: () => { status: number; body?: unknown } | Error;
let daemonEnrollmentSecret: string;
let authenticator: BridgeHttpAuthenticator;

class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = 0;
  onopen = null; onclose = null; onmessage = null; onerror = null;
  constructor(public url: string) {}
  close() {}
  send() {}
}

function httpResponse(status: number, body: string, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

beforeEach(() => {
  vi.resetModules();
  store = {};
  nativeReplies = [];
  nativeCalls = [];
  httpCalls = [];
  statusMessages = [];
  daemon = () => ({ status: 403 });
  daemonEnrollmentSecret = 'daemon-enrollment-secret';
  authenticator = new BridgeHttpAuthenticator(daemonEnrollmentSecret, 'pairing-test-daemon');
  (globalThis as any).chrome = {
    storage: {
      local: {
        get: async (keys: string[]) => Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, store[k]])),
        set: async (items: Record<string, unknown>) => { Object.assign(store, items); },
      },
      session: { get: async () => ({}), set: async () => {} },
    },
    alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
    tabs: { query: async () => [] },
    action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {} },
    runtime: {
      sendMessage: async (msg: { statusMessage?: string }) => { if (msg?.statusMessage) statusMessages.push(msg.statusMessage); },
      getManifest: () => ({ version: '3.0.0' }),
      sendNativeMessage: async (host: string, msg: unknown) => {
        nativeCalls.push([host, msg]);
        const reply = nativeReplies.shift();
        if (reply instanceof Error) throw reply;
        return reply;
      },
    },
  };
  (globalThis as any).WebSocket = FakeWebSocket;
  (globalThis as any).fetch = async (input: string | URL, init?: { headers?: HeadersInit; method?: string }) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    httpCalls.push({ url: url.href, enrollmentHeader: headers.has('X-BC-Enrollment') });
    if (url.pathname === '/status') return httpResponse(403, 'Forbidden');
    if (url.pathname === '/auth/challenge') {
      const challenge = authenticator.issueChallenge(url.searchParams.get('clientNonce') || '');
      return { ...httpResponse(200, JSON.stringify(challenge)), json: async () => challenge };
    }
    if (url.pathname === '/pair') {
      const clientNonce = headers.get('X-BC-Client-Nonce') || '';
      const serverNonce = headers.get('X-BC-Server-Nonce') || '';
      const accepted = authenticator.verifyAndConsume({
        clientNonce,
        serverNonce,
        method: init?.method || 'GET',
        target: url.pathname + url.search,
        clientProof: headers.get('X-BC-Client-Proof') || '',
      });
      if (!accepted) return httpResponse(403, 'Forbidden');
      const result = daemon();
      if (result instanceof Error) throw result;
      const body = JSON.stringify(result.body ?? {});
      const proof = authenticator.createResponseProof({ clientNonce, serverNonce, status: result.status, body });
      return httpResponse(result.status, body, { 'x-bc-response-proof': proof });
    }
    throw new Error(`Unexpected fixture request: ${url.pathname}`);
  };
});

const load = () => import('../extension/lib/connection.js');
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('zero-touch pairing (native messaging)', () => {
  it('pairs itself when no secret is stored: native host → authenticated /pair → token', async () => {
    daemon = () => ({ status: 200, body: { token: 'tok' } });
    daemonEnrollmentSecret = 'from-host';
    authenticator = new BridgeHttpAuthenticator(daemonEnrollmentSecret, 'pairing-test-daemon');
    nativeReplies.push({ ok: true, enrollmentSecret: 'from-host', port: 7225 });
    await (await load()).initConnection();
    await flush();

    expect(nativeCalls).toEqual([['com.browser_controller.pairing', { type: 'pairing' }]]);
    expect(store).toMatchObject({ enrollmentSecret: 'from-host', wsToken: 'tok' });
    expect(httpCalls.some((call) => call.url.endsWith('/pair'))).toBe(true);
    expect(httpCalls.every((call) => !call.enrollmentHeader)).toBe(true);
    expect(httpCalls.every((call) => !call.url.includes('from-host'))).toBe(true);
    expect(statusMessages.some((m) => /Paired automatically/.test(m))).toBe(true);
  });

  it('replaces a rotated secret when the existing secret cannot verify the daemon challenge', async () => {
    store.enrollmentSecret = 'old';
    daemon = () => ({ status: 200, body: { token: 'tok' } });
    daemonEnrollmentSecret = 'new';
    authenticator = new BridgeHttpAuthenticator(daemonEnrollmentSecret, 'pairing-test-daemon');
    nativeReplies.push({ ok: true, enrollmentSecret: 'new', port: 7225 });
    await (await load()).initConnection();

    expect(store.enrollmentSecret).toBe('new');
    expect(nativeCalls).toHaveLength(1);
    expect(httpCalls.filter((call) => call.url.endsWith('/pair'))).toHaveLength(1);
    expect(httpCalls.every((call) => !call.enrollmentHeader && !call.url.includes('old') && !call.url.includes('new'))).toBe(true);
  });

  it('never starts the host while the stored secret works or the daemon is down', async () => {
    store.enrollmentSecret = 'good';
    daemonEnrollmentSecret = 'good';
    authenticator = new BridgeHttpAuthenticator(daemonEnrollmentSecret, 'pairing-test-daemon');
    daemon = () => ({ status: 200, body: { token: 'tok' } });
    await (await load()).initConnection();
    expect(nativeCalls).toHaveLength(0);

    vi.resetModules();
    daemon = () => new Error('connection refused');
    (globalThis as any).fetch = async (input: string | URL) => {
      if (new URL(String(input)).pathname === '/status') return httpResponse(403, 'Forbidden');
      throw new Error('connection refused');
    };
    await (await load()).initConnection();
    expect(nativeCalls).toHaveLength(0);
  });

  it('reports missing host setup and rate-limits native messaging requests', async () => {
    nativeReplies.push(new Error('Specified native messaging host not found.'));
    const conn = await load();
    await conn.initConnection();
    expect(await conn.ensurePairing()).toBe('');
    await flush();

    expect(nativeCalls).toHaveLength(1);
    expect(store.enrollmentSecret).toBeUndefined();
    expect(statusMessages.filter((m) => /npm run setup:pairing/.test(m))).toHaveLength(1);
  });

  it('keeps a user-selected port and does not send a rejected secret to that port', async () => {
    store.wsPort = 9000;
    nativeReplies.push({ ok: true, enrollmentSecret: 'still-wrong', port: 7225 });
    await (await load()).initConnection();
    expect(store.enrollmentSecret).toBe('still-wrong');
    expect(httpCalls.every((call) => !call.enrollmentHeader && !call.url.includes('still-wrong'))).toBe(true);
    expect(httpCalls.some((call) => new URL(call.url).port === '9000')).toBe(true);
    expect(nativeCalls).toHaveLength(1);
  });

  // connect() holds its probing guard through pairing: a request that never settles must not wedge it.
  describe('a pairing request that never settles', () => {
    // Earlier tests leave connect() chains running; let them settle on real timers before faking time.
    beforeEach(async () => { await new Promise((r) => setTimeout(r, 50)); });
    afterEach(() => { vi.useRealTimers(); });

    const statusProbes = () => httpCalls.filter((call) => call.url.endsWith('/status')).length;

    it('times out a native message, then lets a later connect() proceed', async () => {
      vi.useFakeTimers();
      (globalThis as any).chrome.runtime.sendNativeMessage = () => new Promise(() => {});
      const conn = await load();

      const first = conn.connect();
      await vi.advanceTimersByTimeAsync(10);
      void conn.connect(); // ignored while the first attempt holds the guard
      expect(statusProbes()).toBe(1);

      await vi.advanceTimersByTimeAsync(PAIRING_TIMEOUT_MS + 10);
      await first;
      await conn.connect();
      expect(statusProbes()).toBe(2);
    });

    it('times out /pair, then lets a later connect() pair and proceed', async () => {
      store.enrollmentSecret = 'good';
      daemonEnrollmentSecret = 'good';
      authenticator = new BridgeHttpAuthenticator(daemonEnrollmentSecret, 'pairing-test-daemon');
      daemon = () => ({ status: 200, body: { token: 'tok' } });
      const conn = await load();
      await conn.initConnection();
      expect(store.wsToken).toBe('tok');

      vi.useFakeTimers();
      const realFetch = (globalThis as any).fetch;
      let hangPair = true;
      (globalThis as any).fetch = (input: string | URL, init?: unknown) => (
        hangPair && new URL(String(input)).pathname === '/pair' ? new Promise(() => {}) : realFetch(input, init)
      );
      httpCalls = [];
      store.wsToken = '';
      conn.applyToken(''); // resets the socket and starts a connect() that must pair
      await vi.advanceTimersByTimeAsync(10);
      expect(statusProbes()).toBe(1);

      await vi.advanceTimersByTimeAsync(PAIRING_TIMEOUT_MS + 10);
      hangPair = false;
      await conn.connect();
      expect(statusProbes()).toBe(2);
      expect(store.wsToken).toBe('tok');
    });
  });
});
