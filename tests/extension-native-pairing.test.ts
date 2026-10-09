import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Zero-touch pairing: when the daemon refuses the enrollment secret (none
 * stored yet, or rotated), the background asks the native pairing host for it
 * and retries /pair once. The host is never asked while the stored secret
 * works or the daemon is down, and at most once per 30 s.
 */

let store: Record<string, unknown>;
let nativeReplies: unknown[];
let nativeCalls: unknown[][];
let pairCalls: Array<{ url: string; enrollment?: string }>;
let statusMessages: string[];
let daemon: (enrollment?: string) => { status: number; body?: unknown } | Error;

class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = 0;
  onopen = null; onclose = null; onmessage = null; onerror = null;
  constructor(public url: string) {}
  close() {}
  send() {}
}

beforeEach(() => {
  vi.resetModules();
  store = {};
  nativeReplies = [];
  nativeCalls = [];
  pairCalls = [];
  statusMessages = [];
  daemon = () => ({ status: 403 });
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
      sendNativeMessage: async (host: string, msg: unknown) => {
        nativeCalls.push([host, msg]);
        const reply = nativeReplies.shift();
        if (reply instanceof Error) throw reply;
        return reply;
      },
    },
  };
  (globalThis as any).WebSocket = FakeWebSocket;
  (globalThis as any).fetch = async (url: string, init?: { headers?: Record<string, string> }) => {
    const enrollment = init?.headers?.['X-BC-Enrollment'];
    pairCalls.push({ url, enrollment });
    const r = daemon(enrollment);
    if (r instanceof Error) throw r;
    return { ok: r.status === 200, status: r.status, json: async () => r.body };
  };
});

const load = () => import('../extension/lib/connection.js');
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('zero-touch pairing (native messaging)', () => {
  it('pairs itself when no secret is stored: host → secret → /pair → token', async () => {
    daemon = (e) => (e === 'from-host' ? { status: 200, body: { token: 'tok' } } : { status: 403 });
    nativeReplies.push({ ok: true, enrollmentSecret: 'from-host', port: 7225 });
    await (await load()).initConnection();
    await flush();

    expect(nativeCalls).toEqual([['com.browser_controller.pairing', { type: 'pairing' }]]);
    expect(pairCalls.map((c) => c.enrollment)).toEqual([undefined, 'from-host']);
    expect(store).toMatchObject({ enrollmentSecret: 'from-host', wsToken: 'tok' });
    expect(statusMessages.some((m) => /Paired automatically/.test(m))).toBe(true);
  });

  it('replaces a rotated secret the daemon refuses', async () => {
    store.enrollmentSecret = 'old';
    daemon = (e) => (e === 'new' ? { status: 200, body: { token: 'tok' } } : { status: 403 });
    nativeReplies.push({ ok: true, enrollmentSecret: 'new', port: 7225 });
    await (await load()).initConnection();
    expect(store.enrollmentSecret).toBe('new');
    expect(pairCalls.map((c) => c.enrollment)).toEqual(['old', 'new']);
  });

  it('never starts the host while the stored secret works or the daemon is down', async () => {
    store.enrollmentSecret = 'good';
    daemon = () => ({ status: 200, body: { token: 'tok' } });
    await (await load()).initConnection();
    expect(nativeCalls).toHaveLength(0);

    vi.resetModules();
    daemon = () => new Error('connection refused');
    await (await load()).initConnection();
    expect(nativeCalls).toHaveLength(0);
  });

  it('without setup: says how to set it up and asks the host at most once per 30 s', async () => {
    nativeReplies.push(new Error('Specified native messaging host not found.'));
    const conn = await load();
    await conn.initConnection();
    expect(await conn.ensurePairing()).toBe('');
    await flush();

    expect(nativeCalls).toHaveLength(1);
    expect(store.enrollmentSecret).toBeUndefined();
    expect(statusMessages.filter((m) => /npm run setup:pairing/.test(m))).toHaveLength(1);
  });

  it('keeps a port the user set, adopts the host port otherwise, and does not loop on a refused secret', async () => {
    store.wsPort = 9000;
    nativeReplies.push({ ok: true, enrollmentSecret: 'still-wrong', port: 7225 });
    await (await load()).initConnection();
    expect(pairCalls.map((c) => c.url)).toEqual(['http://127.0.0.1:9000/pair', 'http://127.0.0.1:9000/pair']);
    expect(nativeCalls).toHaveLength(1);

    vi.resetModules();
    store = {};
    pairCalls = [];
    daemon = (e) => (e === 's' ? { status: 200, body: { token: 'tok' } } : { status: 403 });
    nativeReplies.push({ ok: true, enrollmentSecret: 's', port: 9333 });
    await (await load()).initConnection();
    expect(pairCalls.map((c) => c.url)).toEqual(['http://127.0.0.1:7225/pair', 'http://127.0.0.1:9333/pair']);
  });
});
