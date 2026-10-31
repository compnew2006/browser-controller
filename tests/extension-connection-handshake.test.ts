import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildExtensionHello } from '../mcp-server/src/protocol/index.js';
import { BridgeHttpAuthenticator, newAuthNonce, verifyWebSocketClientProof } from '../mcp-server/src/bridge-auth.js';

/**
 * Extension side of the handshake (lib/connection.js): daemon identity is proven
 * before helloAck/state adoption, a daemon hello without authentication is refused,
 * and a daemon that says nothing within the handshake timeout is refused too.
 * Before any socket, connect() probes GET /status: a daemon that does not answer
 * gets no WebSocket at all (no connection-refused errors in chrome://extensions).
 */

const HANDSHAKE_TIMEOUT_MS = 3_000;
const PROBE_TIMEOUT_MS = 2_000;

let sockets: FakeWebSocket[] = [];
let fetchMock: ReturnType<typeof vi.fn>;
let httpAuth: BridgeHttpAuthenticator;
const ENROLLMENT_SECRET = 'synthetic-enrollment-secret-for-tests';
const AUTH_TOKEN = 'synthetic-extension-token-for-tests';
const DAEMON_INSTANCE_ID = 'daemon-test';

function httpResponse(status: number, body: string, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = 0;
  sent: string[] = [];
  closed: Array<[number | undefined, string | undefined]> = [];
  onopen: (() => void) | null = null;
  onclose: ((event?: { code?: number; reason?: string }) => void) | null = null;
  onmessage: ((event: { data: string }) => Promise<void>) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string, public protocols?: string | string[]) {
    sockets.push(this);
  }
  send(data: string) { this.sent.push(data); }
  close(code?: number, reason?: string) { this.closed.push([code, reason]); this.readyState = 3; this.onclose?.(); }
}

beforeEach(() => {
  vi.resetModules();
  sockets = [];
  httpAuth = new BridgeHttpAuthenticator(ENROLLMENT_SECRET, DAEMON_INSTANCE_ID);
  fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === '/auth/challenge') {
      const challenge = httpAuth.issueChallenge(url.searchParams.get('clientNonce') ?? '');
      return httpResponse(200, JSON.stringify(challenge));
    }
    if (url.pathname === '/pair') {
      const headers = new Headers(init?.headers);
      const clientNonce = headers.get('X-BC-Client-Nonce') ?? '';
      const serverNonce = headers.get('X-BC-Server-Nonce') ?? '';
      const accepted = httpAuth.verifyAndConsume({
        clientNonce,
        serverNonce,
        method: init?.method ?? 'GET',
        target: url.pathname + url.search,
        clientProof: headers.get('X-BC-Client-Proof') ?? '',
      });
      if (!accepted) return httpResponse(403, 'Forbidden');
      const body = JSON.stringify({ token: AUTH_TOKEN });
      const proof = httpAuth.createResponseProof({ clientNonce, serverNonce, status: 200, body });
      return httpResponse(200, body, { 'x-bc-response-proof': proof });
    }
    if (url.pathname === '/status') return httpResponse(403, 'Forbidden');
    throw new Error('Unexpected fixture request');
  });
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

const load = async () => {
  const connection = await import('../extension/lib/connection.js');
  await connection.applyEnrollment(ENROLLMENT_SECRET);
  await settle();
  return connection;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Let connect() get past its awaited /status probe before the socket is checked. */
async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** Open the one socket the connection created, the way the browser would. */
function openSocket(): FakeWebSocket {
  const socket = sockets[sockets.length - 1];
  socket.readyState = FakeWebSocket.OPEN;
  socket.onopen?.();
  return socket;
}

function authenticatedDaemonHello(socket: FakeWebSocket) {
  const init = JSON.parse(socket.sent[0]);
  return buildExtensionHello('3.0.0', DAEMON_INSTANCE_ID, {
    clientNonce: init.clientNonce,
    serverNonce: newAuthNonce(),
    enrollmentSecret: ENROLLMENT_SECRET,
  });
}

describe('extension handshake (connection.js)', () => {
  it('keeps credentials out of the WebSocket URL and subprotocols', async () => {
    await load();
    const [socket] = sockets;
    expect(socket.url).toBe('ws://127.0.0.1:7225');
    expect(socket.protocols).toBeUndefined();
  });

  it('acknowledges a current daemon hello and reports connected', async () => {
    const conn = await load();
    const socket = openSocket();

    const hello = authenticatedDaemonHello(socket);
    await socket.onmessage?.({ data: JSON.stringify(hello) });

    const ack = JSON.parse(socket.sent[1]);
    expect(ack).toMatchObject({ type: 'helloAck', protocolVersion: 2, capabilities: expect.arrayContaining(['tools-v3']) });
    expect(verifyWebSocketClientProof(AUTH_TOKEN, ack, hello.clientNonce, DAEMON_INSTANCE_ID, hello.serverNonce)).toBe(true);
    expect(conn.getConnectionState()).toBe('connected');
    expect(socket.closed).toEqual([]);
  });

  it('takes down an approval card a restarted worker restored once a new daemon connection opens', async () => {
    const stored = [{ tabId: 9, requestId: 'req_ab12', documentId: 'doc-9', origin: 'https://fixture.test', token: 'token-9', expiresAt: Date.now() + 60_000 }];
    (globalThis as any).chrome.storage.session.get = async () => ({ bcVaultApprovalCards: stored });
    const hidden: unknown[] = [];
    (globalThis as any).chrome.scripting = { executeScript: async (request: unknown) => { hidden.push(request); return [{ result: true }]; } };
    await load();
    const cards = await import('../extension/lib/vault-card.js');
    await cards.cardsReady;
    expect(cards.isApprovalCardOpen(9)).toBe(true);
    openSocket();
    await settle();
    expect(cards.isApprovalCardOpen(9)).toBe(false);
    expect(hidden).toEqual([expect.objectContaining({ target: { tabId: 9, documentIds: ['doc-9'] }, args: ['req_ab12'] })]);
  });

  it('refuses a daemon hello without a protocol version, with the restart hint', async () => {
    const conn = await load();
    const socket = openSocket();

    await socket.onmessage?.({ data: JSON.stringify({ type: 'hello', capabilities: ['tool-dispatch', 'ping-pong', 'tools-v3'] }) });

    expect(socket.sent).toHaveLength(1); // authInit only; no acknowledgement to an untrusted peer
    expect(socket.closed).toEqual([[1002, 'incompatible protocol']]);
    expect(conn.getConnectionState()).toBe('reconnecting');
    expect(conn.buildStatusPayload(null, []).lastError).toMatch(/daemon is older than 3\.0/);
  });

  it('refuses a daemon that sends no hello within the handshake timeout', async () => {
    const conn = await load();
    vi.useFakeTimers();
    try {
      const socket = openSocket();
      vi.advanceTimersByTime(HANDSHAKE_TIMEOUT_MS);

      expect(socket.closed).toEqual([[1002, 'incompatible protocol']]);
      expect(conn.getConnectionState()).toBe('reconnecting');
      expect(conn.buildStatusPayload(null, []).lastError).toMatch(/daemon is older than 3\.0/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a daemon whose hello arrives inside the handshake timeout', async () => {
    const conn = await load();
    vi.useFakeTimers();
    try {
      const socket = openSocket();
      vi.advanceTimersByTime(HANDSHAKE_TIMEOUT_MS - 1_000);
      await socket.onmessage?.({ data: JSON.stringify(authenticatedDaemonHello(socket)) });
      vi.advanceTimersByTime(HANDSHAKE_TIMEOUT_MS * 2);

      expect(socket.closed).toEqual([]);
      expect(conn.getConnectionState()).toBe('connected');
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a forged daemon hello before acknowledging or adopting it', async () => {
    const conn = await load();
    const socket = openSocket();
    const hello = authenticatedDaemonHello(socket);
    await socket.onmessage?.({ data: JSON.stringify({ ...hello, authProof: 'forged-proof' }) });

    expect(socket.sent).toHaveLength(1); // only authInit; no helloAck leaves the extension
    expect(socket.closed).toEqual([[1002, 'incompatible protocol']]);
    expect(conn.getConnectionState()).toBe('reconnecting');
    expect(conn.buildStatusPayload(null, []).lastError).toMatch(/authentication failed/i);
  });

  it('re-pairs before reconnecting when the daemon refuses the acknowledgement proof', async () => {
    await load();
    vi.useFakeTimers();
    try {
      const socket = openSocket();
      await socket.onmessage?.({ data: JSON.stringify(authenticatedDaemonHello(socket)) });
      const pairCalls = () => fetchMock.mock.calls.filter(([url]) => new URL(String(url)).pathname === '/pair').length;
      const pairedBefore = pairCalls();

      // The daemon rejects a stale token after the socket opened: close 1002, no frame.
      socket.readyState = 3;
      socket.onclose?.({ code: 1002, reason: 'incompatible protocol' });
      vi.advanceTimersByTime(2_000);
      // Pairing runs Web Crypto, which settles outside the fake clock.
      vi.useRealTimers();
      await vi.waitFor(() => expect(sockets).toHaveLength(2));

      expect(pairCalls()).toBe(pairedBefore + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not report connected when the socket closes while the daemon proof is checked', async () => {
    const conn = await load();
    const socket = openSocket();
    const handling = socket.onmessage?.({ data: JSON.stringify(authenticatedDaemonHello(socket)) });
    socket.close(1000, 'gone');
    await handling;

    expect(socket.sent).toHaveLength(1); // authInit only: no acknowledgement on a closed socket
    expect(conn.getConnectionState()).toBe('reconnecting');
  });

  it('opens one socket when connect() runs again while the first one is still pairing', async () => {
    const normalFetch = fetchMock.getMockImplementation()!;
    let releasePair!: () => void;
    const pairHeld = new Promise<void>((resolve) => { releasePair = resolve; });
    let pairCalls = 0;
    fetchMock.mockImplementation(async (input: string | URL, init?: RequestInit) => {
      if (new URL(String(input)).pathname === '/pair') {
        pairCalls++;
        // The first token fetch fails, so connect() has to pair before it opens a socket.
        if (pairCalls === 1) throw new TypeError('Failed to fetch');
        await pairHeld;
      }
      return normalFetch(input, init);
    });
    const connection = await import('../extension/lib/connection.js');
    await connection.applyEnrollment(ENROLLMENT_SECRET);
    await vi.waitFor(() => expect(pairCalls).toBe(2));

    // The keepalive alarm fires while the first attempt waits on pairing.
    const second = connection.connect();
    releasePair();
    await second;
    await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(0));
    await sleep(50);

    expect(sockets).toHaveLength(1);
  });
});

describe('port probe before the WebSocket (connection.js)', () => {
  it('opens no WebSocket while /status is refused, and schedules the next attempt', async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
      const unavailable = await load();
      await settle();

      expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/status'))).toBe(true);
      expect(sockets).toEqual([]);
      expect(unavailable.getConnectionState()).toBe('reconnecting');
      const { nextRetryMs, lastError } = unavailable.buildStatusPayload(null, []);
      expect(nextRetryMs).toBeGreaterThan(0);
      expect(lastError).toBe('Daemon not running on port 7225');

      vi.advanceTimersByTime(nextRetryMs);
      await settle();
      expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/status')).length).toBeGreaterThan(1);
      expect(sockets).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats a /status that never answers as down once the probe times out', async () => {
    vi.useFakeTimers();
    try {
      const normalFetch = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation((input: string | URL, init?: RequestInit) => {
        if (new URL(String(input)).pathname !== '/status') return normalFetch(input, init);
        return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
      });
      const unavailable = await load();
      vi.advanceTimersByTime(PROBE_TIMEOUT_MS);
      await settle();

      expect(sockets).toEqual([]);
      expect(unavailable.getConnectionState()).toBe('reconnecting');
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens a WebSocket after the unauthenticated liveness probe responds', async () => {
    await load();

    const [probeUrl, probeInit] = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/status'))!;
    expect(probeUrl).toBe('http://127.0.0.1:7225/status');
    // The probe carries neither the enrollment secret nor the auth token.
    expect(probeInit).not.toHaveProperty('headers');
    expect(sockets).toHaveLength(1);
    expect(sockets[0].url).toBe('ws://127.0.0.1:7225');
    expect(sockets[0].protocols).toBeUndefined();
  });
});
