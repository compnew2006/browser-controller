import { describe, it, expect, afterAll } from 'vitest';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { buildIpcHello, buildSessionId, newDaemonInstanceId } from '../mcp-server/src/protocol/index.js';
import { newAuthNonce } from '../mcp-server/src/bridge-auth.js';
import { freePort } from './helpers/free-port.js';

/**
 * WP6 item 1a/1b (daemon side): session ids must not repeat across daemon
 * restarts (a new agent must never inherit a dead agent's tab locks), and the
 * daemon announces its instance id in the extension hello.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DIST_DAEMON = path.join(ROOT, 'mcp-server', 'dist', 'daemon.js');

const STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-wp6-'));
const SOCK = path.join(STATE, 'daemon.sock');
const TOKEN_FILE = path.join(STATE, 'token.json');
// An OS-assigned ephemeral port, not a pid-derived band another test process
// can land in at the same time.
const WS_PORT = await freePort();

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let proc: ChildProcess | null = null;

async function startDaemon(): Promise<{ token: string; enrollment: string }> {
  if (!fs.existsSync(DIST_DAEMON)) throw new Error(`${DIST_DAEMON} missing - run npm run build first`);
  proc = spawn(process.execPath, [DIST_DAEMON], {
    env: { ...process.env, BC_STATE_DIR: STATE, WS_PORT: String(WS_PORT), WS_HOST: '127.0.0.1' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  for (let i = 0; i < 80; i++) {
    const up = await new Promise<boolean>((resolve) => {
      const probe = net.createConnection(SOCK);
      probe.once('connect', () => { probe.destroy(); resolve(true); });
      probe.once('error', () => resolve(false));
    });
    if (up) {
      return {
        token: JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')).token,
        enrollment: JSON.parse(fs.readFileSync(path.join(STATE, 'enrollment.json'), 'utf8')).secret,
      };
    }
    await sleep(50);
  }
  throw new Error('daemon never came up');
}

async function stopDaemon(): Promise<void> {
  if (!proc || proc.killed) return;
  const exited = new Promise<void>((r) => proc!.once('exit', () => r()));
  proc.kill('SIGTERM');
  await exited;
  proc = null;
  await sleep(100);
}

/** One IPC client: hello, then the welcome's session id. */
function ipcSessionId(token: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(SOCK);
    socket.setEncoding('utf8');
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const msg = JSON.parse(buf.slice(0, nl));
      socket.destroy();
      resolve(msg.sessionId);
    });
    socket.on('error', reject);
    socket.once('connect', () => socket.write(JSON.stringify(buildIpcHello(token, 'Restart')) + '\n'));
  });
}

/** The fake extension's view: the instance id in the daemon's hello. */
function extensionHello(enrollment: string): Promise<{ instanceId?: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
    const timer = setTimeout(() => { ws.close(); reject(new Error('no hello within 5s')); }, 5000);
    ws.once('message', (data) => {
      clearTimeout(timer);
      ws.close();
      resolve(JSON.parse(data.toString()));
    });
    ws.once('error', reject);
    ws.once('open', () => ws.send(JSON.stringify({ type: 'authInit', clientNonce: newAuthNonce() })));
  });
}

afterAll(async () => {
  await stopDaemon();
  try { fs.rmSync(STATE, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('instance and session id helpers', () => {
  it('instance ids are 8 base36 characters and do not repeat', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newDaemonInstanceId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[0-9a-z]{8}$/);
  });

  it('a session id carries the daemon instance and its counter', () => {
    expect(buildSessionId('k3j9x2m1', 4)).toBe('s-k3j9x2m1-4');
  });
});

describe('daemon restart (integration, built daemon)', { timeout: 30_000 }, () => {
  it('session ids and the extension hello instance id change across a restart', async () => {
    const daemon1 = await startDaemon();
    const session1 = await ipcSessionId(daemon1.token);
    const hello1 = await extensionHello(daemon1.enrollment);
    await stopDaemon();

    const daemon2 = await startDaemon();
    const session2 = await ipcSessionId(daemon2.token);
    const hello2 = await extensionHello(daemon2.enrollment);

    expect(session1).toMatch(/^s-[0-9a-z]{8}-1$/);
    expect(session2).toMatch(/^s-[0-9a-z]{8}-1$/);
    expect(session2).not.toBe(session1); // a new agent must not inherit the old session's locks
    expect(hello1.instanceId).toMatch(/^[0-9a-z]{8}$/);
    expect(hello2.instanceId).toMatch(/^[0-9a-z]{8}$/);
    expect(hello2.instanceId).not.toBe(hello1.instanceId);
    expect(session1.startsWith(`s-${hello1.instanceId}-`)).toBe(true);
    expect(session2.startsWith(`s-${hello2.instanceId}-`)).toBe(true);
  });
});
