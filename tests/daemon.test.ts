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
const ENROLLMENT_FILE = path.join(TMP_STATE, 'enrollment.json');
const WS_PORT = 30_000 + (process.pid % 5_000);

let token = '';
let enrollment = '';

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
        // the daemon also writes enrollment.json on start; read it so the
        // HTTP helpers can send X-BC-Enrollment (required since the gate landed).
        try {
          const eparsed = JSON.parse(fs.readFileSync(ENROLLMENT_FILE, 'utf8'));
          enrollment = eparsed.secret ?? '';
        } catch { /* not yet */ }
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

function httpGet(pathAndQuery: string, opts?: { headers?: http.OutgoingHttpHeaders; raw?: boolean }): Promise<any> {
  return new Promise((resolve, reject) => {
    const headers: http.OutgoingHttpHeaders = { 'X-BC-Enrollment': enrollment, ...(opts?.headers ?? {}) };
    const req = http.get(`http://127.0.0.1:${WS_PORT}${pathAndQuery}`, { headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (opts?.raw) { resolve({ status: res.statusCode, body: data }); return; }
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

  it('replaces a DEAD client (missed pongs) when a new one with the same name connects', async () => {
    // First client deliberately ignores pings → its missedPongs climbs toward
    // HEARTBEAT_MAX_MISSED. We wait long enough for it to be flagged dead, then
    // connect a second client with the same name — the dead one must be replaced.
    const first = await connectClient('DedupDead', { replyToPing: false });
    const countBefore = (await fetchStatus()).agents.filter((a: any) => a.name === 'DedupDead').length;
    expect(countBefore).toBe(1);

    // Wait for the heartbeat to mark first as dead (BC_HEARTBEAT_MAX_MISSED=3
    // × BC_HEARTBEAT_MS=200ms ≈ 600ms + buffer).
    await sleep(200 * (3 + 1) + 250);

    const second = await connectClient('DedupDead');
    await sleep(150);
    const rows = (await fetchStatus()).agents.filter((a: any) => a.name === 'DedupDead');
    expect(rows.length).toBe(1);
    expect(rows[0].sessionId).toBe(second.sessionId);

    second.socket.destroy();
    first.socket.destroy();
  });

  it('co-exists multiple LIVE clients with the same agentName (multi-process support)', async () => {
    // Two genuinely live clients (replying to pings) with the same name must
    // BOTH stay connected — this is the fix for the destructive sibling race
    // where 3 concurrent MCP processes sharing one agentName kept destroying
    // each other. Each gets its own unique sessionId.
    const a = await connectClient('Coexist');
    const b = await connectClient('Coexist');
    await sleep(150);
    const rows = (await fetchStatus()).agents.filter((x: any) => x.name === 'Coexist');
    expect(rows.length).toBe(2);
    const ids = rows.map((r: any) => r.sessionId).sort();
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids).toContain(a.sessionId);
    expect(ids).toContain(b.sessionId);

    // Closing one must NOT evict the other (the close handler's stillAlive
    // check keeps the survivor's tab locks intact).
    a.socket.destroy();
    await sleep(150);
    const after = (await fetchStatus()).agents.filter((x: any) => x.name === 'Coexist');
    expect(after.length).toBe(1);
    expect(after[0].sessionId).toBe(b.sessionId);

    b.socket.destroy();
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
          const line = String(chunk).trim();
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

describe('daemon per-session rate limiting', { timeout: 30_000 }, () => {
  // Separate daemon instance with a tiny budget so the test is fast and doesn't
  // interfere with the shared daemon's clients above.
  const RL_PORT = 19310 + Math.floor(Math.random() * 50);
  const RL_STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-rl-'));
  const RL_SOCK = path.join(RL_STATE, 'daemon.sock');
  const RL_TOKEN_FILE = path.join(RL_STATE, 'token.json');
  const BUDGET = 2;
  let rlDaemon: ChildProcess | null = null;
  let rlToken = '';

  beforeAll(async () => {
    rlDaemon = spawn(process.execPath, [DIST_DAEMON], {
      env: {
        ...process.env,
        BC_STATE_DIR: RL_STATE,
        BC_HEARTBEAT_MS: '60000',   // don't evict mid-test
        BC_HEARTBEAT_MAX_MISSED: '3',
        WS_PORT: String(RL_PORT),
        WS_HOST: '127.0.0.1',
        BC_RATE_LIMIT_PER_MIN: String(BUDGET),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    rlDaemon.stderr?.on('data', (c) => { stderr += c.toString(); });
    for (let i = 0; i < 80; i++) {
      if (fs.existsSync(RL_SOCK)) {
        const ok = await new Promise<boolean>((resolve) => {
          const s = net.createConnection(RL_SOCK);
          s.once('connect', () => { s.destroy(); resolve(true); });
          s.once('error', () => resolve(false));
        });
        if (ok) {
          // token from disk (mirrors tokenFromDisk, scoped to this instance)
          const born = Date.now();
          while (Date.now() - born < 4000) {
            try {
              const parsed = JSON.parse(fs.readFileSync(RL_TOKEN_FILE, 'utf8'));
              if (parsed.token) { rlToken = parsed.token; break; }
            } catch { /* not yet */ }
            const end = Date.now() + 50; while (Date.now() < end) { /* spin */ }
          }
          if (rlToken) return;
        }
      }
      await sleep(50);
    }
    throw new Error(`rate-limit daemon never came up. stderr:\n${stderr}`);
  });

  afterAll(async () => {
    if (rlDaemon && !rlDaemon.killed) {
      rlDaemon.kill('SIGTERM');
      await sleep(150);
    }
    try { fs.rmSync(RL_STATE, { recursive: true, force: true }); } catch {}
  });

  /**
   * Connect, handshake, then send N `browser_snapshot` calls. Calls don't need
   * the extension connected — the daemon replies with a timeout error after the
   * rate check. We only care whether the rejection is the rate-limit message
   * (refused before the bridge hop) vs. a normal timeout/extension error
   * (allowed through and then failed downstream).
   */
  function connectAndFireCalls(count: number): Promise<{ sessionId: string; results: string[] }> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(RL_SOCK);
      socket.setEncoding('utf8');
      let buf = '';
      let sessionId = '';
      const results: string[] = [];
      let callsSent = 0;
      const timer = setTimeout(() => reject(new Error('rate-limit test timed out')), 8000);
      socket.on('data', (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let msg: any;
          try { msg = JSON.parse(line); } catch { continue; }
          if (msg.kind === 'welcome' && !sessionId) {
            sessionId = msg.sessionId;
            // Send all calls back-to-back. No pongs needed (heartbeat is 60s).
            for (let i = 0; i < count; i++) {
              socket.write(JSON.stringify({ kind: 'call', id: `c${i}`, tool: 'browser_snapshot', params: { tabId: 1 } }) + '\n');
              callsSent++;
            }
            continue;
          }
          if (msg.kind === 'result') {
            results.push(msg.success ? 'ok' : msg.error || 'error');
            if (results.length === callsSent) {
              clearTimeout(timer);
              socket.destroy();
              resolve({ sessionId, results });
            }
          }
        }
      });
      socket.on('error', (e) => { clearTimeout(timer); reject(e); });
      socket.write(JSON.stringify({ kind: 'hello', token: rlToken, agentName: 'RlAgent' }) + '\n');
    });
  }

  it(`refuses calls past the per-minute budget (${BUDGET}) with a rate-limit error`, async () => {
    // Budget = 2 → first 2 calls are admitted (then fail as no extension),
    // the 3rd+ are refused outright with the rate-limit message.
    const { results } = await connectAndFireCalls(BUDGET + 2);
    expect(results.length).toBe(BUDGET + 2);
    const rateLimited = results.filter((r) => r.startsWith('Rate limit exceeded'));
    const admitted = results.filter((r) => !r.startsWith('Rate limit exceeded'));
    // Exactly the overflow count was refused on rate grounds...
    expect(rateLimited.length).toBe(2);
    // ...and the admitted ones are NOT rate-limit errors (they fail downstream).
    expect(admitted.length).toBe(BUDGET);
    admitted.forEach((r) => expect(r.startsWith('Rate limit exceeded')).toBe(false));
  });

  it('fresh budget after reconnect (new session = new window)', async () => {
    // A brand-new client should get its own full budget, proving the limit is
    // per-session, not global.
    const { results } = await connectAndFireCalls(BUDGET);
    expect(results.length).toBe(BUDGET);
    results.forEach((r) => expect(r.startsWith('Rate limit exceeded')).toBe(false));
  });
});

describe('daemon enrollment gate (closes first-contact TOFU race)', { timeout: 30_000 }, () => {
  // Self-contained daemon instance (own state dir + own port + own
  // enrollment.json), so this describe block can be run in isolation — the
  // gate must NOT depend on the shared lifecycle daemon above being booted.
  const E_PORT = 19410 + Math.floor(Math.random() * 50);
  const E_STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-enr-'));
  const E_SOCK = path.join(E_STATE, 'daemon.sock');
  const E_TOKEN_FILE = path.join(E_STATE, 'token.json');
  const E_ENROLLMENT_FILE = path.join(E_STATE, 'enrollment.json');
  let eDaemon: ChildProcess | null = null;
  let eToken = '';
  let eEnrollment = '';

  beforeAll(async () => {
    eDaemon = spawn(process.execPath, [DIST_DAEMON], {
      env: {
        ...process.env,
        BC_STATE_DIR: E_STATE,
        BC_HEARTBEAT_MS: '60000',
        BC_HEARTBEAT_MAX_MISSED: '3',
        WS_PORT: String(E_PORT),
        WS_HOST: '127.0.0.1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    eDaemon.stderr?.on('data', (c) => { stderr += c.toString(); });
    for (let i = 0; i < 80; i++) {
      if (fs.existsSync(E_SOCK)) {
        const ok = await new Promise<boolean>((resolve) => {
          const s = net.createConnection(E_SOCK);
          s.once('connect', () => { s.destroy(); resolve(true); });
          s.once('error', () => resolve(false));
        });
        if (ok) {
          // Read both token and enrollment from disk (both written on start).
          const born = Date.now();
          while (Date.now() - born < 4000) {
            try {
              if (!eToken) {
                const tp = JSON.parse(fs.readFileSync(E_TOKEN_FILE, 'utf8'));
                if (tp.token) eToken = tp.token;
              }
              if (!eEnrollment) {
                const ep = JSON.parse(fs.readFileSync(E_ENROLLMENT_FILE, 'utf8'));
                if (ep.secret) eEnrollment = ep.secret;
              }
              if (eToken && eEnrollment) break;
            } catch { /* not yet */ }
            const end = Date.now() + 50; while (Date.now() < end) { /* spin */ }
          }
          if (eToken && eEnrollment) return;
        }
      }
      await sleep(50);
    }
    throw new Error(`enrollment daemon never came up. stderr:\n${stderr}`);
  });

  afterAll(async () => {
    if (eDaemon && !eDaemon.killed) {
      eDaemon.kill('SIGTERM');
      await sleep(150);
    }
    try { fs.rmSync(E_STATE, { recursive: true, force: true }); } catch {}
  });

  // Local http helper (separate port/state from the shared daemon's httpGet).
  function eHttp(pathAndQuery: string, opts?: { headers?: http.OutgoingHttpHeaders; raw?: boolean }): Promise<any> {
    return new Promise((resolve, reject) => {
      const headers: http.OutgoingHttpHeaders = { 'X-BC-Enrollment': eEnrollment, ...(opts?.headers ?? {}) };
      const req = http.get(`http://127.0.0.1:${E_PORT}${pathAndQuery}`, { headers }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (opts?.raw) { resolve({ status: res.statusCode, body: data }); return; }
          try { resolve(JSON.parse(data)); } catch { resolve(null); }
        });
      });
      req.on('error', reject);
      setTimeout(() => reject(new Error('http timeout')), 4000);
    });
  }

  it('/pair WITHOUT the X-BC-Enrollment header is rejected (403)', async () => {
    const res = await eHttp('/pair', { headers: { 'X-BC-Enrollment': '' }, raw: true });
    expect(res.status).toBe(403);
    expect(res.body).not.toContain(eToken);
  });

  it('/pair WITH a WRONG enrollment secret is rejected (403)', async () => {
    const res = await eHttp('/pair', { headers: { 'X-BC-Enrollment': 'wrong-secret' }, raw: true });
    expect(res.status).toBe(403);
    expect(res.body).not.toContain(eToken);
  });

  it('/pair WITH the CORRECT enrollment secret returns the token', async () => {
    const res = await eHttp('/pair', { headers: { 'X-BC-Enrollment': eEnrollment }, raw: true });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).token).toBe(eToken);
  });

  it('/status and /kill also require the enrollment secret (no bypass via other routes)', async () => {
    const statusNoKey = await eHttp('/status', { headers: { 'X-BC-Enrollment': '' }, raw: true });
    expect(statusNoKey.status).toBe(403);

    const killWrongKey = await eHttp('/kill?sessionId=s1', { headers: { 'X-BC-Enrollment': 'wrong' }, raw: true });
    expect(killWrongKey.status).toBe(403);

    const statusOk = await eHttp('/status', { headers: { 'X-BC-Enrollment': eEnrollment }, raw: true });
    expect(statusOk.status).toBe(200);
  });

  it('a hostile extension that wins the Origin-pin race STILL cannot get the token (the whole point)', async () => {
    // Simulate a hostile extension that reaches the daemon first with its OWN
    // chrome-extension://<hostile-id> Origin (which the browser would set for it
    // and which it cannot forge to be OUR id). It wins the pin. But it does NOT
    // know the enrollment secret, so /pair must still reject it.
    const hostileOrigin = 'chrome-extension://hostileID';
    const res = await eHttp('/pair', {
      headers: {
        Origin: hostileOrigin,            // hostile wins the pin
        'X-BC-Enrollment': '',            // but has no enrollment secret
      },
      raw: true,
    });
    expect(res.status).toBe(403);
    expect(res.body).not.toContain(eToken);
    // The hostile extension leaves empty-handed: no token, no WS, no control.
  });
});
