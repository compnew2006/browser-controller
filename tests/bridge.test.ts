import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import http from 'node:http';
import { ExtensionBridge, isDaemonResponsiveOnPort } from '../mcp-server/src/bridge.js';

let portCounter = 20_000 + (process.pid % 5_000);
function nextPort() { return portCounter++; }

describe('isDaemonResponsiveOnPort', () => {
  let servers: http.Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
    servers = [];
  });

  it('returns true when /pair answers with a token (a healthy daemon)', async () => {
    const port = nextPort();
    const s = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ token: 'abc123' }));
    });
    servers.push(s);
    await new Promise<void>((r) => s.listen(port, '127.0.0.1', r));
    await expect(isDaemonResponsiveOnPort('127.0.0.1', port)).resolves.toBe(true);
  });

  it('returns false when nothing is listening on the port', async () => {
    const port = nextPort(); // nothing bound
    await expect(isDaemonResponsiveOnPort('127.0.0.1', port)).resolves.toBe(false);
  });

  it('returns false when a non-daemon server holds the port (wrong body shape)', async () => {
    const port = nextPort();
    const s = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ hello: 'world' })); // no `token` field
    });
    servers.push(s);
    await new Promise<void>((r) => s.listen(port, '127.0.0.1', r));
    await expect(isDaemonResponsiveOnPort('127.0.0.1', port)).resolves.toBe(false);
  });

  it('returns false when the server hangs (timeout, no response)', async () => {
    const port = nextPort();
    const s = http.createServer(() => { /* never responds */ });
    servers.push(s);
    await new Promise<void>((r) => s.listen(port, '127.0.0.1', r));
    await expect(isDaemonResponsiveOnPort('127.0.0.1', port, 300)).resolves.toBe(false);
  }, 5000);
});

describe('ExtensionBridge', () => {
  const bridges: ExtensionBridge[] = [];
  const clients: WebSocket[] = [];

  afterEach(async () => {
    clients.forEach(c => { try { c.close(); } catch {} });
    clients.length = 0;
    bridges.forEach(b => b.stop());
    bridges.length = 0;
    await new Promise(r => setTimeout(r, 50));
  });

  function createBridge(
    port: number,
    opts?: Partial<{ maxRetries: number; token: string; enrollmentSecret: string }>,
  ): ExtensionBridge {
    const b = new ExtensionBridge({
      port,
      maxRetries: opts?.maxRetries ?? 1,
      pingIntervalMs: 60_000,
      token: opts?.token,
      enrollmentSecret: opts?.enrollmentSecret,
    });
    bridges.push(b);
    return b;
  }

  async function connectClient(port: number, path = ''): Promise<WebSocket> {
    const client = new WebSocket(`ws://localhost:${port}${path}`);
    clients.push(client);
    await new Promise<void>((resolve, reject) => {
      client.on('open', resolve);
      client.on('error', reject);
    });
    await new Promise(r => setTimeout(r, 30));
    return client;
  }

  it('starts WebSocket server', async () => {
    const bridge = createBridge(nextPort());
    await bridge.start();
    expect(bridge.isConnected()).toBe(false);
  });

  it('accepts extension connection', async () => {
    const port = nextPort();
    const bridge = createBridge(port);
    await bridge.start();

    await connectClient(port);
    expect(bridge.isConnected()).toBe(true);
  });

  it('sends tool call and receives response', async () => {
    const port = nextPort();
    const bridge = createBridge(port);
    await bridge.start();

    const client = await connectClient(port);
    client.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.tool) {
        client.send(JSON.stringify({ id: msg.id, success: true, result: { clicked: true } }));
      }
    });

    const result = await bridge.callTool('browser_click', { ref: 'e1' });
    expect(result).toEqual({ clicked: true });
  });

  it('rejects on error response', async () => {
    const port = nextPort();
    const bridge = createBridge(port);
    await bridge.start();

    const client = await connectClient(port);
    client.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.tool) {
        client.send(JSON.stringify({ id: msg.id, success: false, error: 'not found' }));
      }
    });

    await expect(bridge.callTool('browser_click', { ref: 'e1' })).rejects.toThrow('not found');
  });

  it('waitForConnection resolves when already connected', async () => {
    const port = nextPort();
    const bridge = createBridge(port);
    await bridge.start();
    await connectClient(port);

    await expect(bridge.waitForConnection(1000)).resolves.toBeUndefined();
  });

  it('waitForConnection times out when no connection', async () => {
    const port = nextPort();
    const bridge = createBridge(port);
    await bridge.start();

    await expect(bridge.waitForConnection(100)).rejects.toThrow('Timed out');
  });

  it('throws when calling tool without connection', async () => {
    const port = nextPort();
    const bridge = createBridge(port, { maxRetries: 0 });
    await bridge.start();

    await expect(bridge.callTool('browser_click', {})).rejects.toThrow();
  }, 10_000);

  // Task 3.1 regression guard: this test would have caught the daemon shipping
  // with WS auth disabled (the token was loaded but never passed to the bridge).
  it('with a token, accepts a connection that presents the right token', async () => {
    const port = nextPort();
    const bridge = createBridge(port, { token: 'sekret' });
    await bridge.start();

    await connectClient(port, '?token=sekret');
    expect(bridge.isConnected()).toBe(true);
  });

  it('with a token, REJECTS a connection missing the token', async () => {
    const port = nextPort();
    const bridge = createBridge(port, { token: 'sekret' });
    await bridge.start();

    // The socket opens (handshake) then the server closes it for bad auth.
    const client = new WebSocket(`ws://localhost:${port}`);
    clients.push(client);
    await new Promise<void>((resolve) => {
      client.on('close', () => resolve());
      client.on('error', () => resolve());
    });
    expect(bridge.isConnected()).toBe(false);
  });

  it('with a token, REJECTS a connection with a wrong token', async () => {
    const port = nextPort();
    const bridge = createBridge(port, { token: 'sekret' });
    await bridge.start();

    const client = new WebSocket(`ws://localhost:${port}?token=wrong`);
    clients.push(client);
    await new Promise<void>((resolve) => {
      client.on('close', () => resolve());
      client.on('error', () => resolve());
    });
    expect(bridge.isConnected()).toBe(false);
  });

  // --- Token via Sec-WebSocket-Protocol (token-out-of-URL hardening) --------
  // The extension now sends the auth token in the subprotocol header so it
  // never lands in the URL query (access logs / browser history). These guard
  // the new path while keeping the legacy ?token= path working.
  //
  // The extension offers BOTH `bc-auth.<token>` (for the daemon to read the
  // token) AND the bare `bc-auth` (so the daemon can ACK it without echoing the
  // token back via ws.protocol). Tests mirror that dual-offer.
  async function connectClientWithProtocol(
    port: number,
    subprotocols: string | string[],
    path = '',
  ): Promise<WebSocket> {
    const client = new WebSocket(`ws://localhost:${port}${path}`, subprotocols);
    clients.push(client);
    await new Promise<void>((resolve, reject) => {
      client.on('open', resolve);
      client.on('error', reject);
    });
    await new Promise(r => setTimeout(r, 30));
    return client;
  }

  it('accepts a connection that presents the token via Sec-WebSocket-Protocol', async () => {
    const port = nextPort();
    const bridge = createBridge(port, { token: 'sekret' });
    await bridge.start();

    await connectClientWithProtocol(port, ['bc-auth.sekret', 'bc-auth']);
    expect(bridge.isConnected()).toBe(true);
  });

  it('REJECTS a token sent via subprotocol that does not match', async () => {
    const port = nextPort();
    const bridge = createBridge(port, { token: 'sekret' });
    await bridge.start();

    const client = new WebSocket(`ws://localhost:${port}`, ['bc-auth.wrong', 'bc-auth']);
    clients.push(client);
    await new Promise<void>((resolve) => {
      client.on('close', () => resolve());
      client.on('error', () => resolve());
    });
    expect(bridge.isConnected()).toBe(false);
  });

  it('subprotocol token takes precedence over a conflicting ?token=', async () => {
    // If both are present and the subprotocol one is correct, the connection
    // succeeds (subprotocol wins; this matches the extension's dual-send).
    const port = nextPort();
    const bridge = createBridge(port, { token: 'sekret' });
    await bridge.start();

    await connectClientWithProtocol(port, ['bc-auth.sekret', 'bc-auth'], '?token=wrong');
    expect(bridge.isConnected()).toBe(true);
  });

  it('keeps the replacement extension connected when the old socket closes', async () => {
    const port = nextPort();
    const bridge = createBridge(port);
    await bridge.start();

    const first = await connectClient(port);
    const firstClosed = new Promise<void>((resolve) => first.once('close', () => resolve()));
    await connectClient(port);
    await firstClosed;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(bridge.isConnected()).toBe(true);
  });

  it('honors a timing-safe match on tokens of equal length (constant-time path)', async () => {
    // Two tokens that share a prefix but differ at the end must still reject.
    // Guards against a regression where only a prefix or a non-constant compare
    // would be used.
    const port = nextPort();
    const bridge = createBridge(port, { token: 'aaaaaaaaaa' });
    await bridge.start();

    const client = new WebSocket(`ws://localhost:${port}`, ['bc-auth.aaaaaXaaaa', 'bc-auth']);
    clients.push(client);
    await new Promise<void>((resolve) => {
      client.on('close', () => resolve());
      client.on('error', () => resolve());
    });
    expect(bridge.isConnected()).toBe(false);
  });

  // --- Call cancellation (audit C2) -----------------------------------------
  // When the daemon evicts a client mid-call, it aborts the AbortController.
  // The bridge must reject the pending promise so a non-idempotent action
  // (click/type) doesn't keep running after the originating agent is gone.
  it('aborts an in-flight call when the AbortSignal fires (audit C2)', async () => {
    const port = nextPort();
    const bridge = createBridge(port);
    await bridge.start();

    const client = await connectClient(port);
    // Extension NEVER replies — simulates a slow/in-flight action.
    client.on('message', () => { /* swallow: deliberately hang */ });

    const controller = new AbortController();
    const promise = bridge.callTool('browser_click', { ref: 'e1' }, undefined, controller.signal);

    // Abort mid-flight (as the daemon's close handler would on eviction).
    await new Promise((r) => setTimeout(r, 30));
    controller.abort();

    await expect(promise).rejects.toThrow(/aborted/i);
  });

  // --- Cancellation forwarding (cancel control message) ---------------------
  // When a call is aborted, the bridge must tell the extension to abort the
  // matching in-flight handler so it releases the tab mutex immediately. Without
  // this, a slow navigate (55s) keeps the tab pinned after the caller is gone.
  it('forwards a cancel control message to the extension on abort', async () => {
    const port = nextPort();
    const bridge = createBridge(port);
    await bridge.start();

    const client = await connectClient(port);
    const received: any[] = [];
    client.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      received.push(msg);
    });

    const controller = new AbortController();
    const promise = bridge.callTool('browser_navigate', { url: 'http://x' }, undefined, controller.signal);
    await new Promise((r) => setTimeout(r, 30));
    controller.abort();
    await expect(promise).rejects.toThrow(/aborted/i);
    // Give the control message a tick to land.
    await new Promise((r) => setTimeout(r, 30));

    const cancelMsg = received.find((m) => m.type === 'cancel');
    expect(cancelMsg).toBeTruthy();
    expect(typeof cancelMsg.id).toBe('string');
  });

  it('forwards a cancel control message on timeout', async () => {
    const port = nextPort();
    // Non-idempotent tool with a tiny timeout so it fires deterministically.
    const bridge = new ExtensionBridge({ port, maxRetries: 0, pingIntervalMs: 60_000, defaultTimeoutMs: 60 });
    bridges.push(bridge);
    await bridge.start();

    const client = await connectClient(port);
    const received: any[] = [];
    client.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      received.push(msg);
    });

    await expect(bridge.callTool('browser_click', { ref: 'e1' })).rejects.toThrow(/timed out/i);
    // Give the control message a tick to flush through the WS.
    await new Promise((r) => setTimeout(r, 50));
    const cancelMsg = received.find((m) => m.type === 'cancel');
    expect(cancelMsg).toBeTruthy();
    expect(typeof cancelMsg.id).toBe('string');
  }, 15_000);

  it('rejects immediately if the signal is already aborted before send', async () => {
    const port = nextPort();
    const bridge = createBridge(port);
    await bridge.start();
    await connectClient(port);

    const controller = new AbortController();
    controller.abort();
    await expect(
      bridge.callTool('browser_click', { ref: 'e1' }, undefined, controller.signal)
    ).rejects.toThrow(/aborted before send/i);
  });

  it('a normally-completing call detaches the abort listener (no late reject)', async () => {
    const port = nextPort();
    const bridge = createBridge(port);
    await bridge.start();

    const client = await connectClient(port);
    client.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.tool) {
        client.send(JSON.stringify({ id: msg.id, success: true, result: { ok: 1 } }));
      }
    });

    const controller = new AbortController();
    const result = await bridge.callTool('browser_snapshot', { tabId: 1 }, undefined, controller.signal);
    expect(result).toEqual({ ok: 1 });
    // Aborting AFTER settlement must be a no-op (listener was removed).
    controller.abort();
    await new Promise((r) => setTimeout(r, 20));
    // No unhandled rejection thrown — test passing this far proves it.
  });

  // --- HTTP endpoint Origin gate (CORS hardening for /pair /status /kill) ---
  // The daemon serves /pair (auth token), /status, /kill over HTTP on the same
  // port as the WS. A web page open in a tab must NOT be able to fetch these —
  // especially /pair, which leaks the token. The gate rejects any request whose
  // Origin is present and not chrome-extension://, and CORS only reflects the
  // extension origin. Local clients (curl/scripts/tests) send no Origin and pass.
  async function httpGet(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; acao?: string }> {
    const http = await import('node:http');
    return new Promise((resolve, reject) => {
      const req = http.get(`http://localhost:${port}${path}`, { headers }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({
          status: res.statusCode ?? 0,
          body: data,
          acao: res.headers['access-control-allow-origin'] as string | undefined,
        }));
      });
      req.on('error', reject);
      setTimeout(() => reject(new Error('http timeout')), 4000);
    });
  }

  it('HTTP endpoints reject a web-page Origin (no token leak to sites)', async () => {
    const port = nextPort();
    const bridge = createBridge(port, { token: 'sekret' });
    bridge.registerHttpHandler(() => ({ token: 'sekret' })); // mimic /pair
    await bridge.start();

    // A site (https://evil.com) open in a tab carries its Origin on fetch().
    const res = await httpGet(port, '/pair', { Origin: 'https://evil.com' });
    expect(res.status).toBe(403);
    expect(res.body).toBe('Forbidden');
    // And no CORS reflection — browser would block the read even if it landed.
    expect(res.acao).toBeUndefined();
  });

  it('HTTP endpoints accept the extension-popup Origin', async () => {
    const port = nextPort();
    const bridge = createBridge(port, { token: 'sekret' });
    bridge.registerHttpHandler(() => ({ token: 'sekret' }));
    await bridge.start();

    const res = await httpGet(port, '/pair', { Origin: 'chrome-extension://abc123' });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).token).toBe('sekret');
    // CORS reflects the extension origin so the browser exposes the body to it.
    expect(res.acao).toBe('chrome-extension://abc123');
  });

  it('HTTP endpoints accept a no-Origin local client (curl/scripts/tests)', async () => {
    const port = nextPort();
    const bridge = createBridge(port);
    bridge.registerHttpHandler(() => ({ ok: true }));
    await bridge.start();

    const res = await httpGet(port, '/status'); // no Origin header
    expect(res.status).toBe(200);
  });

  // --- Exact-match on pinned extension ID (the "other malicious extension"
  //     gap a substring check leaves open) -----------------------------------
  // A co-installed hostile extension surfaces its OWN chrome-extension://<id>
  // Origin (the browser won't let JS forge another extension's origin). So once
  // the daemon has pinned the legit extension's ID on first contact, a request
  // from a DIFFERENT extension ID must be rejected — even though it also starts
  // with `chrome-extension://`. This is the case a `startsWith` gate misses.
  it('rejects a second, different extension ID after the first is pinned', async () => {
    const port = nextPort();
    const bridge = createBridge(port, { token: 'sekret' });
    bridge.registerHttpHandler(() => ({ ok: true }));
    await bridge.start();

    // First extension Origin → pinned (TOFU), request succeeds.
    const first = await httpGet(port, '/status', { Origin: 'chrome-extension://legitID' });
    expect(first.status).toBe(200);

    // Different extension ID (a hostile co-installed extension) → must 403,
    // because the pinned ID is legitID, not hostileID.
    const hostile = await httpGet(port, '/status', { Origin: 'chrome-extension://hostileID' });
    expect(hostile.status).toBe(403);
    expect(hostile.acao).toBeUndefined();
  });

  it('does not pin an extension origin until enrollment succeeds', async () => {
    const port = nextPort();
    const bridge = createBridge(port, {
      token: 'sekret',
      enrollmentSecret: 'enroll-secret',
    });
    bridge.registerHttpHandler(() => ({ ok: true }));
    await bridge.start();

    const hostile = await httpGet(port, '/status', {
      Origin: 'chrome-extension://hostileID',
      'X-BC-Enrollment': 'wrong',
    });
    expect(hostile.status).toBe(403);

    const legitimate = await httpGet(port, '/status', {
      Origin: 'chrome-extension://legitID',
      'X-BC-Enrollment': 'enroll-secret',
    });
    expect(legitimate.status).toBe(200);
    expect(legitimate.acao).toBe('chrome-extension://legitID');
  });

  it('keeps serving the pinned extension ID on subsequent requests', async () => {
    const port = nextPort();
    const bridge = createBridge(port, { token: 'sekret' });
    bridge.registerHttpHandler(() => ({ ok: true }));
    await bridge.start();

    const first = await httpGet(port, '/status', { Origin: 'chrome-extension://legitID' });
    expect(first.status).toBe(200);

    // Same ID again → still 200, and CORS reflects exactly that origin.
    const again = await httpGet(port, '/status', { Origin: 'chrome-extension://legitID' });
    expect(again.status).toBe(200);
    expect(again.acao).toBe('chrome-extension://legitID');
  });
});
