import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { ExtensionBridge } from '../mcp-server/src/bridge.js';

let portCounter = 19230;
function nextPort() { return portCounter++; }

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

  function createBridge(port: number, opts?: Partial<{ maxRetries: number; token: string }>): ExtensionBridge {
    const b = new ExtensionBridge({ port, maxRetries: opts?.maxRetries ?? 1, pingIntervalMs: 60_000, token: opts?.token });
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
});
