import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildExtensionHello } from '../mcp-server/src/protocol.js';

/**
 * Extension side of the handshake (lib/connection.js): the token travels only in
 * the WebSocket subprotocol, a daemon hello without the 3.0 contract is refused,
 * and a daemon that says nothing within the handshake timeout is refused too.
 * Before any socket, connect() probes GET /status: a daemon that does not answer
 * gets no WebSocket at all (no connection-refused errors in chrome://extensions).
 */

const HANDSHAKE_TIMEOUT_MS = 3_000;
const PROBE_TIMEOUT_MS = 2_000;

let sockets: FakeWebSocket[] = [];
let fetchMock: ReturnType<typeof vi.fn>;

class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = 0;
  sent: string[] = [];
  closed: Array<[number | undefined, string | undefined]> = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => Promise<void>) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string, public protocols?: string | string[]) {
    sockets.push(this);
  }
  send(data: string) { this.sent.push(data); }
  close(code?: number, reason?: string) { this.closed.push([code, reason]); }
}

beforeEach(() => {
  vi.resetModules();
  sockets = [];
  // The probe's answer. 403 is what the bridge's enrollment gate returns to a
  // probe without the secret: any HTTP answer means the daemon is up.
  fetchMock = vi.fn(async () => ({ ok: false, status: 403 }));
  (globalThis as any).fetch = fetchMock;
  (globalThis as any).chrome = {
    storage: {
      local: { get: async () => ({}), set: async () => {} },
      session: { get: async () => ({}), set: async () => {} },
    },
    alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
    tabs: { query: async () => [] },
    action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {} },
    runtime: {
      sendMessage: async () => {},
      getManifest: () => ({ version: '3.0.0' }),
    },
  };
  (globalThis as any).WebSocket = FakeWebSocket;
});

const load = () => import('../extension/lib/connection.js');

/** Let connect() get past its awaited /status probe before the socket is checked. */
async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** Open the one socket the connection created, the way the browser would. */
function openSocket(): FakeWebSocket {
  const [socket] = sockets;
  socket.readyState = FakeWebSocket.OPEN;
  socket.onopen?.();
  return socket;
}

describe('extension handshake (connection.js)', () => {
  it('carries the token only in the subprotocol, never in the URL', async () => {
    const conn = await load();
    conn.applyToken('tok-123');
    await settle();

    const [socket] = sockets;
    expect(socket.url).toBe('ws://127.0.0.1:7225');
    expect(socket.protocols).toEqual(['bc-auth.tok-123', 'bc-auth']);
  });

  it('acknowledges a current daemon hello and reports connected', async () => {
    const conn = await load();
    conn.applyToken('t');
    await settle();
    const socket = openSocket();

    await socket.onmessage?.({ data: JSON.stringify(buildExtensionHello('3.0.0')) });

    const ack = JSON.parse(socket.sent[0]);
    expect(ack).toMatchObject({ type: 'helloAck', protocolVersion: 1, capabilities: expect.arrayContaining(['tools-v3']) });
    expect(conn.getConnectionState()).toBe('connected');
    expect(socket.closed).toEqual([]);
  });

  it('refuses a daemon hello without a protocol version, with the restart hint', async () => {
    const conn = await load();
    conn.applyToken('t');
    await settle();
    const socket = openSocket();

    await socket.onmessage?.({ data: JSON.stringify({ type: 'hello', capabilities: ['tool-dispatch', 'ping-pong', 'tools-v3'] }) });

    expect(socket.sent).toEqual([]);
    expect(socket.closed).toEqual([[1002, 'incompatible protocol']]);
    expect(conn.getConnectionState()).toBe('disconnected');
    expect(conn.buildStatusPayload(null, []).lastError).toMatch(/daemon is older than 3\.0/);
  });

  it('refuses a daemon that sends no hello within the handshake timeout', async () => {
    const conn = await load();
    vi.useFakeTimers();
    try {
      conn.applyToken('t');
      await settle();
      openSocket();
      const socket = sockets[0];
      vi.advanceTimersByTime(HANDSHAKE_TIMEOUT_MS);

      expect(socket.closed).toEqual([[1002, 'incompatible protocol']]);
      expect(conn.getConnectionState()).toBe('disconnected');
      expect(conn.buildStatusPayload(null, []).lastError).toMatch(/daemon is older than 3\.0/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a daemon whose hello arrives inside the handshake timeout', async () => {
    const conn = await load();
    vi.useFakeTimers();
    try {
      conn.applyToken('t');
      await settle();
      const socket = openSocket();
      vi.advanceTimersByTime(HANDSHAKE_TIMEOUT_MS - 1_000);
      await socket.onmessage?.({ data: JSON.stringify(buildExtensionHello('3.0.0')) });
      vi.advanceTimersByTime(HANDSHAKE_TIMEOUT_MS * 2);

      expect(socket.closed).toEqual([]);
      expect(conn.getConnectionState()).toBe('connected');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('port probe before the WebSocket (connection.js)', () => {
  it('opens no WebSocket while /status is refused, and schedules the next attempt', async () => {
    const conn = await load();
    vi.useFakeTimers();
    try {
      fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
      conn.applyToken('t');
      await settle();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(sockets).toEqual([]);
      expect(conn.getConnectionState()).toBe('reconnecting');
      const { nextRetryMs, lastError } = conn.buildStatusPayload(null, []);
      expect(nextRetryMs).toBeGreaterThan(0);
      expect(lastError).toBe('Daemon not running on port 7225');

      vi.advanceTimersByTime(nextRetryMs);
      await settle();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(sockets).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats a /status that never answers as down once the probe times out', async () => {
    const conn = await load();
    vi.useFakeTimers();
    try {
      fetchMock.mockImplementation((_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))));
      conn.applyToken('t');
      vi.advanceTimersByTime(PROBE_TIMEOUT_MS);
      await settle();

      expect(sockets).toEqual([]);
      expect(conn.getConnectionState()).toBe('reconnecting');
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens the WebSocket with the same subprotocols once /status answers', async () => {
    const conn = await load();
    conn.applyToken('tok-456');
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [probeUrl, probeInit] = fetchMock.mock.calls[0];
    expect(probeUrl).toBe('http://127.0.0.1:7225/status');
    // The probe carries neither the enrollment secret nor the auth token.
    expect(probeInit).not.toHaveProperty('headers');
    expect(sockets).toHaveLength(1);
    expect(sockets[0].url).toBe('ws://127.0.0.1:7225');
    expect(sockets[0].protocols).toEqual(['bc-auth.tok-456', 'bc-auth']);
  });
});
