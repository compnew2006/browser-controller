import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Integration tests for the daemon's client-lifecycle behavior:
 *   - dedup by agentName (no zombie accumulation)
 *   - heartbeat eviction of a silent client
 *   - /kill endpoint
 *   - auth token rejection
 *   - --agent flag naming
 *
 * These run the REAL compiled daemon as a subprocess (the daemon calls
 * process.exit on SIGINT/SIGTERM, which would kill the vitest process), with a
 * throwaway STATE_DIR (BC_STATE_DIR) so the user's real ~/.browser-controller
 * is untouched. The heartbeat cadence is shrunk via BC_HEARTBEAT_MS=200 so
 * eviction completes in ~600ms instead of the production 45s.
 *
 * Each test connects raw IPC sockets speaking the line-delimited JSON protocol
 * (hello/welcome/call/result/ping/pong) — the same wire format index.ts uses.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DIST_DAEMON = path.join(ROOT, 'mcp-server', 'dist', 'daemon.js');
const DIST_INDEX = path.join(ROOT, 'mcp-server', 'dist', 'index.js');

const TMP_STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-test-'));
const SOCK = path.join(TMP_STATE, 'daemon.sock');
const TOKEN_FILE = path.join(TMP_STATE, 'token.json');
const WS_PORT = 19240 + Math.floor(Math.random() * 50);

let token = '';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function tokenFromDisk(): string {
  // the daemon creates token.json on start; poll briefly for it to appear.
  const born = Date.now();
  while (Date.now() - born < 4000) {
    try {
      const raw = fs.readFileSync(TOKEN_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed.token) return parsed.token;
    } catch {
      // not yet
    }
    // synchronous spin for a short slice (file IO is the slow part)
    const end = Date.now() + 50;
    while (Date.now() < end) { /* spin */ }
  }
  throw new Error('token file never appeared');
}

let daemonProc: ChildProcess | null = null;

async function startDaemon(): Promise<void> {
  daemonProc = spawn(process.execPath, [DIST_DAEMON], {
    env: {
      ...process.env,
      BC_STATE_DIR: TMP_STATE, // isolate state from real ~/.browser-controller
      BC_HEARTBEAT_MS: '200',  // fast heartbeat for the eviction test
      BC_HEARTBEAT_MAX_MISSED: '3',
      WS_PORT: String(WS_PORT),
      WS_HOST: '127.0.0.1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  daemonProc.stderr?.on('data', (c) => { stderr += c.toString(); });
  for (let i = 0; i < 80; i++) {
    if (fs.existsSync(SOCK)) {
      const ok = await new Promise<boolean>((resolve) => {
        const s = net.createConnection(SOCK);
        s.once('connect', () => { s.destroy(); resolve(true); });
        s.once('error', () => resolve(false));
      });
      if (ok) {
        token = tokenFromDisk();
        return;
      }
    }
    await sleep(50);
  }
  throw new Error(`daemon never came up. stderr:\n${stderr}`);
}

interface Client {
  socket: net.Socket;
  sessionId: string;
}

/** Connect a raw IPC client and complete the hello/welcome handshake. */
function connectClient(name: string, opts?: { replyToPing?: boolean }): Promise<Client> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(SOCK);
    socket.setEncoding('utf8');
    let buf = '';
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) reject(new Error('no welcome within 5s'));
    }, 5000);
    socket.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: any;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.kind === 'welcome' && !resolved) {
          resolved = true;
          clearTimeout(timer);
          resolve({ socket, sessionId: msg.sessionId });
          continue;
        }
        // heartbeat probe — reply unless the caller explicitly wants silence
        // (used by the eviction test to simulate a dead client).
        if (msg.kind === 'ping' && opts?.replyToPing !== false) {
          try { socket.write(JSON.stringify({ kind: 'pong' }) + '\n'); } catch {}
        }
      }
    });
    socket.on('error', (e) => { if (!resolved) { clearTimeout(timer); reject(e); } });
    socket.write(JSON.stringify({ kind: 'hello', token, agentName: name }) + '\n');
  });
}

function httpGet(pathAndQuery: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${WS_PORT}${pathAndQuery}`, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', reject);
    setTimeout(() => reject(new Error('http timeout')), 4000);
  });
}

const fetchStatus = () => httpGet('/status');
const killSession = (sid: string) => httpGet(`/kill?sessionId=${encodeURIComponent(sid)}`);

afterAll(async () => {
  if (daemonProc && !daemonProc.killed) {
    daemonProc.kill('SIGTERM');
    await sleep(150);
  }
  try { fs.rmSync(TMP_STATE, { recursive: true, force: true }); } catch {}
});

afterEach(async () => {
  await sleep(30);
});

describe('daemon client lifecycle', { timeout: 30_000 }, () => {
  beforeAll(async () => {
    if (!fs.existsSync(DIST_DAEMON)) {
      throw new Error(`${DIST_DAEMON} missing — run \`npm run build\` first`);
    }
    await startDaemon();
  });

  it('admits a client and assigns a session id', async () => {
    const { sessionId, socket } = await connectClient('TestAgent');
    expect(sessionId).toMatch(/^s\d+$/);
    socket.destroy();
  });

  it('dedups by agentName: a second client with the same name replaces the first', async () => {
    const first = await connectClient('Dedup');
    const before = await fetchStatus();
    const countBefore = before.agents.filter((a: any) => a.name === 'Dedup').length;
    expect(countBefore).toBe(1);

    const second = await connectClient('Dedup');
    await sleep(150);
    const after = await fetchStatus();
    const dedupRows = after.agents.filter((a: any) => a.name === 'Dedup');
    expect(dedupRows.length).toBe(1);
    expect(dedupRows[0].sessionId).toBe(second.sessionId);

    second.socket.destroy();
    first.socket.destroy();
  });

  it('evicts a silent client via the heartbeat after the max-missed count', async () => {
    // replyToPing:false → never answer → daemon destroys after
    // BC_HEARTBEAT_MAX_MISSED (3) × BC_HEARTBEAT_MS (200ms) ≈ 600ms.
    const { sessionId, socket } = await connectClient('Silent', { replyToPing: false });
    const closed = await new Promise<boolean>((resolve) => {
      socket.on('close', () => resolve(true));
      setTimeout(() => resolve(false), 3000);
    });
    expect(closed).toBe(true);
    const status = await fetchStatus();
    expect(status.agents.some((a: any) => a.sessionId === sessionId)).toBe(false);
  });

  it('keeps a pong-replying client alive across many heartbeat cycles', async () => {
    const { sessionId, socket } = await connectClient('Healthy');
    // survive well beyond the eviction window
    await sleep(1500);
    const status = await fetchStatus();
    expect(status.agents.some((a: any) => a.sessionId === sessionId)).toBe(true);
    socket.destroy();
  });

  it('GET /kill destroys a live client session immediately', async () => {
    const { sessionId } = await connectClient('Killable');
    const before = await fetchStatus();
    expect(before.agents.some((a: any) => a.sessionId === sessionId)).toBe(true);

    const res = await killSession(sessionId);
    expect(res.ok).toBe(true);
    await sleep(150);

    const after = await fetchStatus();
    expect(after.agents.some((a: any) => a.sessionId === sessionId)).toBe(false);
  });

  it('GET /kill on an unknown session returns ok:false', async () => {
    const res = await killSession('s-nope');
    expect(res.ok).toBe(false);
  });

  it('rejects a hello with a bad token', async () => {
    await expect(
      new Promise<void>((resolve, reject) => {
        const socket = net.createConnection(SOCK);
        socket.setEncoding('utf8');
        const timer = setTimeout(() => reject(new Error('no denial')), 4000);
        socket.on('data', (chunk) => {
          const line = chunk.trim();
          try {
            const msg = JSON.parse(line);
            if (msg.kind === 'denied') {
              clearTimeout(timer);
              socket.destroy();
              resolve();
            }
          } catch { /* partial */ }
        });
        socket.on('close', () => { clearTimeout(timer); resolve(); });
        socket.on('error', (e) => { clearTimeout(timer); reject(e); });
        socket.write(JSON.stringify({ kind: 'hello', token: 'wrong-token', agentName: 'Bad' }) + '\n');
      })
    ).resolves.toBeUndefined();
  });
});

describe('--agent flag naming', { timeout: 15_000 }, () => {
  it('the --agent flag sets the name the daemon registers', async () => {
    if (!fs.existsSync(DIST_INDEX)) {
      throw new Error(`${DIST_INDEX} missing — run \`npm run build\` first`);
    }
    // The thin client (index.js) connects to OUR daemon via the throwaway
    // state dir. Pass --agent FlaggedName and confirm it shows up in /status.
    const child = spawn(process.execPath, [DIST_INDEX, '--agent', 'FlaggedName'], {
      env: {
        ...process.env,
        BC_STATE_DIR: TMP_STATE,
        WS_PORT: String(WS_PORT),
        WS_HOST: '127.0.0.1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    await sleep(2500); // let it connect + send hello
    try {
      const status = await fetchStatus();
      const flagged = status.agents.filter((a: any) => a.name === 'FlaggedName');
      expect(flagged.length).toBeGreaterThanOrEqual(1);
    } finally {
      child.kill('SIGTERM');
    }
  });
});
