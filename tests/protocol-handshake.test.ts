import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ExtensionBridge } from '../mcp-server/src/bridge.js';
import {
  EXTENSION_PROTOCOL_CAPABILITIES,
  IPC_PROTOCOL_CAPABILITIES,
  PROTOCOL_VERSION,
  buildExtensionHelloAck,
  buildExtensionHello,
  buildIpcHello,
  buildIpcWelcome,
  validateProtocolVersion,
} from '../mcp-server/src/protocol.js';
import {
  PROTOCOL_VERSION as EXTENSION_PROTOCOL_VERSION,
  EXTENSION_PROTOCOL_CAPABILITIES as BROWSER_CAPABILITIES,
  buildExtensionHelloAck as buildBrowserHelloAck,
  validateDaemonHello,
} from '../extension/lib/protocol.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DIST_DAEMON = path.join(ROOT, 'mcp-server', 'dist', 'daemon.js');

let portCounter = 24_000 + (process.pid % 4_000);
function nextPort() { return portCounter++; }

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('protocol handshake contract', () => {
  it('builds versioned IPC hello/welcome frames with declared capabilities', () => {
    expect(buildIpcHello('token-1', 'Agent')).toEqual({
      kind: 'hello',
      token: 'token-1',
      agentName: 'Agent',
      protocolVersion: PROTOCOL_VERSION,
      capabilities: IPC_PROTOCOL_CAPABILITIES,
    });

    expect(buildIpcWelcome('s1')).toEqual({
      kind: 'welcome',
      sessionId: 's1',
      ok: true,
      protocolVersion: PROTOCOL_VERSION,
      capabilities: IPC_PROTOCOL_CAPABILITIES,
    });
  });

  it('builds versioned extension hello/ack frames with declared capabilities', () => {
    expect(buildExtensionHello('2.2.0')).toEqual({
      type: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      appVersion: '2.2.0',
      capabilities: EXTENSION_PROTOCOL_CAPABILITIES,
    });

    expect(buildExtensionHelloAck('2.2.0')).toEqual({
      type: 'helloAck',
      protocolVersion: PROTOCOL_VERSION,
      appVersion: '2.2.0',
      capabilities: EXTENSION_PROTOCOL_CAPABILITIES,
    });
  });

  it('accepts missing protocolVersion as legacy but rejects mismatched versions', () => {
    expect(validateProtocolVersion(undefined)).toEqual({ ok: true, legacy: true });
    expect(validateProtocolVersion(PROTOCOL_VERSION)).toEqual({ ok: true, legacy: false });
    expect(validateProtocolVersion(PROTOCOL_VERSION + 1)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/unsupported protocol/i),
    });
  });

  it('keeps the browser-side protocol contract in parity with the daemon', () => {
    expect(EXTENSION_PROTOCOL_VERSION).toBe(PROTOCOL_VERSION);
    expect(BROWSER_CAPABILITIES).toEqual(EXTENSION_PROTOCOL_CAPABILITIES);
    expect(buildBrowserHelloAck('2.2.0')).toEqual(buildExtensionHelloAck('2.2.0'));
    expect(validateDaemonHello(buildExtensionHello('2.2.0'))).toEqual({ ok: true, legacy: false });
    expect(validateDaemonHello({ ...buildExtensionHello('2.2.0'), protocolVersion: 999 })).toMatchObject({ ok: false });
    expect(validateDaemonHello({ ...buildExtensionHello('2.2.0'), capabilities: [] })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/missing required daemon capabilities/i),
    });
  });
});

describe('ExtensionBridge protocol handshake', () => {
  const bridges: ExtensionBridge[] = [];
  const clients: WebSocket[] = [];

  afterEach(async () => {
    clients.forEach((client) => { try { client.close(); } catch {} });
    clients.length = 0;
    bridges.forEach((bridge) => bridge.stop());
    bridges.length = 0;
    await sleep(40);
  });

  function createBridge(port: number, opts?: { defaultTimeoutMs?: number }): ExtensionBridge {
    const bridge = new ExtensionBridge({
      port,
      maxRetries: 0,
      pingIntervalMs: 60_000,
      defaultTimeoutMs: opts?.defaultTimeoutMs ?? 250,
    });
    bridges.push(bridge);
    return bridge;
  }

  // The bridge sends hello as soon as the socket opens. When that frame arrives in the
  // same chunk as the upgrade response, ws emits it before an `await` on 'open' resumes,
  // so the first message is captured from the start instead of after connecting.
  async function connectWs(port: number): Promise<{ client: WebSocket; hello: Promise<any> }> {
    const client = new WebSocket(`ws://localhost:${port}`);
    clients.push(client);
    const hello = new Promise<any>((resolve) => {
      client.once('message', (data) => resolve(JSON.parse(data.toString())));
    });
    await new Promise<void>((resolve, reject) => {
      client.once('open', resolve);
      client.once('error', reject);
    });
    return { client, hello };
  }

  it('sends extension hello immediately after the socket opens and accepts helloAck', async () => {
    const port = nextPort();
    const bridge = createBridge(port);
    await bridge.start();

    const { client, hello: firstMessage } = await connectWs(port);
    const hello = await firstMessage;

    expect(hello).toMatchObject({
      type: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      capabilities: expect.arrayContaining(['tool-dispatch', 'ping-pong']),
    });

    client.send(JSON.stringify(buildExtensionHelloAck()));

    client.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.tool) {
        client.send(JSON.stringify({ id: msg.id, success: true, result: { ok: true } }));
      }
    });

    await expect(bridge.callTool('browser_snapshot', { tabId: 1 })).resolves.toEqual({ ok: true });
  });

  it('rejects tool calls while extension protocol negotiation fails', async () => {
    const port = nextPort();
    const bridge = createBridge(port, { defaultTimeoutMs: 80 });
    await bridge.start();

    const { client, hello } = await connectWs(port);
    await hello;
    client.send(JSON.stringify({ type: 'helloAck', protocolVersion: PROTOCOL_VERSION + 1, capabilities: [] }));

    await expect(bridge.callTool('browser_snapshot', { tabId: 1 })).rejects.toThrow(/unsupported protocol/i);
  });

  it('allows legacy extensions after the handshake grace period when no helloAck arrives', async () => {
    const port = nextPort();
    const bridge = createBridge(port);
    await bridge.start();

    const { client } = await connectWs(port);
    client.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.tool) {
        client.send(JSON.stringify({ id: msg.id, success: true, result: { legacy: true } }));
      }
    });

    await expect(bridge.callTool('browser_snapshot', { tabId: 1 })).resolves.toEqual({ legacy: true });
  });
});

describe('daemon IPC protocol handshake', { timeout: 30_000 }, () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-proto-'));
  const sock = path.join(stateDir, 'daemon.sock');
  const tokenFile = path.join(stateDir, 'token.json');
  const wsPort = nextPort();
  let daemonProc: ChildProcess | null = null;
  let token = '';

  beforeAll(async () => {
    if (!fs.existsSync(DIST_DAEMON)) {
      throw new Error(`${DIST_DAEMON} missing - run npm run build first`);
    }
    daemonProc = spawn(process.execPath, [DIST_DAEMON], {
      env: {
        ...process.env,
        BC_STATE_DIR: stateDir,
        BC_HEARTBEAT_MS: '5000',
        WS_PORT: String(wsPort),
        WS_HOST: '127.0.0.1',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    daemonProc.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    for (let i = 0; i < 80; i++) {
      const ok = await new Promise<boolean>((resolve) => {
        const probe = net.createConnection(sock);
        probe.once('connect', () => { probe.destroy(); resolve(true); });
        probe.once('error', () => resolve(false));
      });
      if (ok) {
        const parsed = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
        token = parsed.token;
        return;
      }
      await sleep(50);
    }
    throw new Error(`daemon never came up. stderr:\n${stderr}`);
  });

  afterAll(async () => {
    if (daemonProc && !daemonProc.killed) {
      daemonProc.kill('SIGTERM');
      await sleep(120);
    }
    try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch {}
  });

  function connectRaw(hello: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(sock);
      socket.setEncoding('utf8');
      let buf = '';
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('ipc handshake timeout'));
      }, 5000);
      socket.on('data', (chunk) => {
        buf += chunk;
        const nl = buf.indexOf('\n');
        if (nl === -1) return;
        clearTimeout(timer);
        const line = buf.slice(0, nl).trim();
        socket.destroy();
        resolve(JSON.parse(line));
      });
      socket.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      socket.once('connect', () => {
        socket.write(JSON.stringify(hello) + '\n');
      });
    });
  }

  it('advertises IPC protocol version and capabilities in welcome', async () => {
    const welcome = await connectRaw(buildIpcHello(token, 'ProtoAgent'));

    expect(welcome).toMatchObject({
      kind: 'welcome',
      ok: true,
      protocolVersion: PROTOCOL_VERSION,
      capabilities: expect.arrayContaining(['heartbeat', 'tool-routing', 'session-locks']),
    });
  });

  it('rejects an IPC client with an unsupported protocol version before registering it', async () => {
    const denied = await connectRaw({
      kind: 'hello',
      token,
      agentName: 'TooNew',
      protocolVersion: PROTOCOL_VERSION + 1,
      capabilities: [],
    });

    expect(denied).toMatchObject({
      kind: 'denied',
      ok: false,
      reason: expect.stringMatching(/unsupported protocol/i),
    });
  });
});
