import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { authenticatedHttpGet } from '../mcp-server/src/bridge-auth.js';

/**
 * Daemon restarts with real processes: the compiled daemon and thin MCP
 * clients (mcp-server/dist), each test in its own BC_STATE_DIR and port so the
 * user's ~/.browser-controller is untouched.
 *
 * Seen on 2026-10-21: after a second `npm run daemon:restart`, MCP clients that
 * had used their one reconnect answered every call `NOT_CONNECTED: Not
 * connected to daemon`, and clients racing to start a daemon left a 228 MB
 * daemon.log of `Fatal: … lock is held by live process` stacks.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST_DAEMON = path.join(ROOT, 'mcp-server', 'dist', 'daemon.js');
const DIST_INDEX = path.join(ROOT, 'mcp-server', 'dist', 'index.js');

const children: ChildProcess[] = [];
const stateDirs: string[] = [];
let nextPort = 21_000 + Math.floor(Math.random() * 900) * 4;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

interface State { dir: string; port: number; enrollment: string }

/** A state folder with the token and enrollment secret already written (as after a first run). */
function makeState(): State {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-restart-'));
  stateDirs.push(dir);
  const enrollment = 'e'.repeat(48);
  fs.writeFileSync(path.join(dir, 'token.json'), JSON.stringify({ token: 't'.repeat(48), createdAt: Date.now() }), { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'enrollment.json'), JSON.stringify({ secret: enrollment, createdAt: Date.now() }), { mode: 0o600 });
  return { dir, port: nextPort++, enrollment };
}

function env(state: State, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, BC_STATE_DIR: state.dir, WS_PORT: String(state.port), WS_HOST: '127.0.0.1', BC_HEARTBEAT_MS: '60000', ...extra };
}

function track(child: ChildProcess): ChildProcess {
  children.push(child);
  return child;
}

function output(child: ChildProcess): () => string {
  let text = '';
  child.stdout?.on('data', (c) => { text += c.toString(); });
  child.stderr?.on('data', (c) => { text += c.toString(); });
  return () => text;
}

function exited(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`pid ${child.pid} still running after ${timeoutMs} ms`)), timeoutMs);
    child.once('exit', (code) => { clearTimeout(t); resolve(code); });
  });
}

async function waitUntil(what: string, check: () => Promise<boolean> | boolean, timeoutMs: number): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function socketAnswers(state: State): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createConnection(path.join(state.dir, 'daemon.sock'));
    const t = setTimeout(() => { s.destroy(); resolve(false); }, 250);
    s.once('connect', () => { clearTimeout(t); s.destroy(); resolve(true); });
    s.once('error', () => { clearTimeout(t); resolve(false); });
  });
}

async function status(state: State): Promise<{ pid: number; agents: Array<{ name: string }> } | null> {
  try {
    const response = await authenticatedHttpGet(`http://127.0.0.1:${state.port}`, '/status', state.enrollment, {
      signal: AbortSignal.timeout(1500),
    });
    return response.ok ? JSON.parse(response.body) : null;
  } catch {
    return null;
  }
}

async function agentsPresent(state: State, names: string[]): Promise<boolean> {
  const s = await status(state);
  return !!s && names.every((n) => s.agents.some((a) => a.name === n));
}

/** Start a daemon this test owns and wait until it accepts IPC connections. */
async function startDaemon(state: State): Promise<ChildProcess> {
  const child = track(spawn(process.execPath, [DIST_DAEMON], { env: env(state), stdio: ['ignore', 'pipe', 'pipe'] }));
  const log = output(child);
  await waitUntil(`daemon to start\n${log()}`, () => socketAnswers(state), 8_000);
  return child;
}

async function stopDaemon(child: ChildProcess): Promise<void> {
  child.kill('SIGTERM');
  await exited(child, 5_000);
}

function startClient(state: State, agent: string, extra: Record<string, string> = {}): ChildProcess {
  return track(spawn(process.execPath, [DIST_INDEX, '--agent', agent], { env: env(state, extra), stdio: ['pipe', 'pipe', 'pipe'] }));
}

/** Minimal MCP over the client's stdio: newline-delimited JSON-RPC. */
function mcp(child: ChildProcess) {
  const waiters = new Map<number, (msg: any) => void>();
  let buf = '';
  let id = 0;
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      try { const msg = JSON.parse(line); waiters.get(msg.id)?.(msg); } catch { /* not a message */ }
    }
  });
  const send = (msg: object) => child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  const request = (method: string, params: object) => new Promise<any>((resolve) => {
    const myId = ++id;
    waiters.set(myId, resolve);
    send({ id: myId, method, params });
  });
  return {
    async initialize() {
      await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'restart-test', version: '1' } });
      send({ method: 'notifications/initialized' });
    },
    call: (name: string, args: object) => request('tools/call', { name, arguments: args }),
  };
}

beforeAll(() => {
  for (const file of [DIST_DAEMON, DIST_INDEX]) {
    if (!fs.existsSync(file)) throw new Error(`${file} missing — run \`npm run build\` first`);
  }
});

afterEach(async () => {
  // Clients first, so none starts a daemon again; then the daemons they started.
  for (const child of children.reverse()) {
    if (child.exitCode === null) { child.kill('SIGTERM'); await exited(child, 5_000).catch(() => child.kill('SIGKILL')); }
  }
  children.length = 0;
  for (const dir of stateDirs) {
    try {
      const { pid } = JSON.parse(fs.readFileSync(path.join(dir, 'daemon.json'), 'utf8'));
      if (pid && alive(pid)) process.kill(pid, 'SIGTERM');
    } catch { /* no daemon left */ }
    await sleep(100);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  stateDirs.length = 0;
});

describe('daemon start race', { timeout: 30_000 }, () => {
  it('a daemon that finds the lock held exits at once: one line, exit code 0, no stack', async () => {
    const state = makeState();
    const first = await startDaemon(state);
    const second = track(spawn(process.execPath, [DIST_DAEMON], { env: env(state), stdio: ['ignore', 'pipe', 'pipe'] }));
    const text = output(second);
    expect(await exited(second, 5_000)).toBe(0);
    const lines = text().trim().split('\n');
    expect(lines).toEqual([expect.stringMatching(new RegExp(`lock is held by live process ${first.pid}; this daemon exits and clients use that one$`))]);
    expect(text()).not.toMatch(/Fatal/);
    // The winner keeps serving.
    expect((await status(state))?.pid).toBe(first.pid);
  });
});

describe('thin clients across daemon restarts', { timeout: 60_000 }, () => {
  it('a connect-mode client rejoins after every restart, and a call made while the daemon is down waits for it', async () => {
    const state = makeState();
    let daemon = await startDaemon(state);
    const client = startClient(state, 'Rejoin', { BROWSER_CONTROLLER_DAEMON_MODE: 'connect' });
    const clientLog = output(client);
    await waitUntil('the client to join', () => agentsPresent(state, ['Rejoin']), 10_000);

    // The reported failure came on the SECOND restart: go past it.
    for (let restart = 1; restart <= 3; restart++) {
      await stopDaemon(daemon);
      daemon = await startDaemon(state);
      await waitUntil(`the client to rejoin after restart ${restart}\n${clientLog()}`, () => agentsPresent(state, ['Rejoin']), 15_000);
    }

    const session = mcp(client);
    await session.initialize();
    await stopDaemon(daemon);
    const pending = session.call('browser_tabs', { action: 'list' });
    await sleep(1_500);
    await startDaemon(state);
    const res = await pending;
    // Without an extension the daemon answers about the extension; never that the daemon is unreachable.
    expect(res.result?.content?.[0]?.text).toEqual(expect.any(String));
    const text = JSON.stringify(res);
    expect(text).not.toMatch(/Not connected to daemon|daemon connection closed/);
    expect(await agentsPresent(state, ['Rejoin'])).toBe(true);
  });

  it('three self-starting clients race to start the daemon and all rejoin it after each of two restarts; the log has no fatal stack', async () => {
    const state = makeState();
    const names = ['RaceA', 'RaceB', 'RaceC'];
    const clients = names.map((n) => startClient(state, n));
    const logs = clients.map(output);
    const show = () => logs.map((l) => l()).join('\n---\n');
    await waitUntil(`all clients to join\n${show()}`, () => agentsPresent(state, names), 20_000);

    for (let restart = 1; restart <= 2; restart++) {
      const { pid } = JSON.parse(fs.readFileSync(path.join(state.dir, 'daemon.json'), 'utf8'));
      process.kill(pid, 'SIGTERM');
      await waitUntil(`daemon ${pid} to exit`, () => !alive(pid), 5_000);
      await waitUntil(`all clients to rejoin a new daemon after restart ${restart}\n${show()}`, async () => {
        const s = await status(state);
        return !!s && s.pid !== pid && names.every((n) => s.agents.some((a) => a.name === n));
      }, 20_000);
    }

    const daemonLog = fs.readFileSync(path.join(state.dir, 'daemon.log'), 'utf8');
    expect(daemonLog).not.toMatch(/Fatal/);
    expect(daemonLog).not.toMatch(/^\s+at /m);
    for (const line of daemonLog.split('\n').filter((l) => /daemon lock is/.test(l))) {
      expect(line).toMatch(/; this daemon exits and clients use that one$/);
    }
    expect(show()).not.toMatch(/gave up reconnecting/);
  });
});
