import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import {
  buildIpcHello,
  EXTENSION_PROTOCOL_CAPABILITIES,
  EXTENSION_PROTOCOL_VERSION,
} from '../../mcp-server/src/protocol.js';
import { createWebSocketClientProof, newAuthNonce } from '../../mcp-server/src/bridge-auth.js';

/**
 * Shared test fixtures for specs/003-website-agent-memory (tasks.md T011).
 * Everything here isolates its own BC_STATE_DIR; never ~/.browser-controller.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
export const DIST_DAEMON = path.join(ROOT, 'mcp-server', 'dist', 'daemon.js');
export const MEMORY_PAGES_DIR = path.join(ROOT, 'scripts', 'pages', 'memory');

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Isolated state directory
// ---------------------------------------------------------------------------

export function mkIsolatedStateDir(prefix = 'bc-memory-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function rmStateDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// Real daemon lifecycle (isolated state dir, own WS port)
// ---------------------------------------------------------------------------

export interface DaemonHandle {
  stateDir: string;
  sockPath: string;
  wsPort: number;
  token: string;
  enrollmentSecret: string;
  proc: ChildProcess;
  /** Everything the daemon wrote to stdout and stderr since this handle started it. */
  logs: { stdout: string; stderr: string };
}

function socketPath(stateDir: string): string {
  return path.join(stateDir, 'daemon.sock');
}

function readTokenAndEnrollment(stateDir: string): { token: string; enrollmentSecret: string } {
  const token = JSON.parse(fs.readFileSync(path.join(stateDir, 'token.json'), 'utf8')).token;
  const enrollmentSecret = JSON.parse(fs.readFileSync(path.join(stateDir, 'enrollment.json'), 'utf8')).secret;
  return { token, enrollmentSecret };
}

/** Spawn the real compiled daemon against an isolated state dir and WS port. */
export async function startIsolatedDaemon(
  stateDir: string,
  opts: { wsPort?: number; env?: Record<string, string> } = {},
): Promise<DaemonHandle> {
  if (!fs.existsSync(DIST_DAEMON)) throw new Error(`${DIST_DAEMON} missing — run \`npm run build\` first`);
  const wsPort = opts.wsPort ?? 31_000 + (process.pid % 5_000);
  const sockPath = socketPath(stateDir);
  const proc = spawn(process.execPath, [DIST_DAEMON], {
    env: {
      ...process.env,
      BC_STATE_DIR: stateDir,
      WS_PORT: String(wsPort),
      WS_HOST: '127.0.0.1',
      ...opts.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = { stdout: '', stderr: '' };
  proc.stdout?.on('data', (c) => { logs.stdout += c.toString(); });
  proc.stderr?.on('data', (c) => { logs.stderr += c.toString(); });

  for (let i = 0; i < 100; i++) {
    const up = await new Promise<boolean>((resolve) => {
      const probe = net.createConnection(sockPath);
      probe.once('connect', () => { probe.destroy(); resolve(true); });
      probe.once('error', () => resolve(false));
    });
    if (up) {
      const { token, enrollmentSecret } = readTokenAndEnrollment(stateDir);
      return { stateDir, sockPath, wsPort, token, enrollmentSecret, proc, logs };
    }
    await sleep(50);
  }
  throw new Error(`daemon never came up. stderr:\n${logs.stderr}`);
}

export async function stopIsolatedDaemon(handle: DaemonHandle): Promise<void> {
  if (handle.proc.killed || handle.proc.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => handle.proc.once('exit', () => resolve()));
  handle.proc.kill('SIGTERM');
  await exited;
  await sleep(50);
}

/** Stop and start on the same BC_STATE_DIR and port (quickstart.md's definition of "restart"). */
export async function restartIsolatedDaemon(handle: DaemonHandle, env?: Record<string, string>): Promise<DaemonHandle> {
  await stopIsolatedDaemon(handle);
  return startIsolatedDaemon(handle.stateDir, { wsPort: handle.wsPort, env });
}

// ---------------------------------------------------------------------------
// Raw IPC client (line-delimited JSON: hello/welcome/call/result/ping/pong)
// ---------------------------------------------------------------------------

export interface IpcClient {
  socket: net.Socket;
  sessionId: string;
  call(tool: string, params: Record<string, unknown>): Promise<any>;
  close(): void;
}

export function connectIpcClient(sockPath: string, token: string, agentName: string): Promise<IpcClient> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(sockPath);
    socket.setEncoding('utf8');
    const pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    let seq = 0;
    let buf = '';
    let resolved = false;
    const welcomeTimer = setTimeout(() => { if (!resolved) reject(new Error('no welcome within 5s')); }, 5000);

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
          clearTimeout(welcomeTimer);
          resolve({
            socket,
            sessionId: msg.sessionId,
            call(tool, params) {
              const id = `${agentName}-${++seq}`;
              return new Promise((callResolve, callReject) => {
                const callTimer = setTimeout(() => { pending.delete(id); callReject(new Error(`${tool} timed out`)); }, 10_000);
                pending.set(id, { resolve: callResolve, reject: callReject, timer: callTimer });
                socket.write(JSON.stringify({ kind: 'call', id, tool, params }) + '\n');
              });
            },
            close() { socket.destroy(); },
          });
          continue;
        }
        if (msg.kind === 'ping') { try { socket.write(JSON.stringify({ kind: 'pong' }) + '\n'); } catch { /* closing */ } continue; }
        if (msg.kind === 'result' && typeof msg.id === 'string') {
          const call = pending.get(msg.id);
          if (call) { pending.delete(msg.id); clearTimeout(call.timer); call.resolve(msg); }
        }
      }
    });
    socket.on('error', (e) => { if (!resolved) { clearTimeout(welcomeTimer); reject(e); } });
    socket.write(JSON.stringify(buildIpcHello(token, agentName)) + '\n');
  });
}

// ---------------------------------------------------------------------------
// Fake extension over a real daemon's WebSocket bridge
// ---------------------------------------------------------------------------

export interface SiteContextFixture {
  url: string;
  incognito?: boolean;
  topLevel?: boolean;
  stable?: boolean;
  lang?: string | null;
  dir?: 'ltr' | 'rtl' | null;
  passwordField?: boolean;
  anonymous?: boolean | null;
  anonymityReason?: string;
  /** The measured form's shape, when the page has one inside its main landmark (007). */
  formShape?: FormShapeFixture;
}

/** The shape of a measured form: counts and closed-vocabulary words (007). */
export interface FormShapeFixture {
  fields: number;
  required: number;
  types: string[];
  hidden: boolean;
}

/** The siteContext of a page whose form inside `main` was measured (007). */
export function formShapeSiteContext(url: string, shape: FormShapeFixture): SiteContextFixture {
  return {
    url,
    incognito: false,
    topLevel: true,
    stable: true,
    lang: 'en',
    dir: 'ltr',
    passwordField: false,
    anonymous: true,
    anonymityReason: 'ok',
    formShape: shape,
  };
}

export interface FakeExtensionOptions {
  /** Defaults to every capability including site-context; pass a list without it to simulate an old extension. */
  capabilities?: string[];
  /** Per-call siteContext for browser_navigate/browser_snapshot when params.observe is true. Keyed by URL. */
  siteContextByUrl?: Record<string, SiteContextFixture>;
  /** Override the default `{ from: browserId }` answer for a given tool. */
  onCall?: (tool: string, params: Record<string, unknown>) => any;
}

export interface FakeExtension {
  ws: WebSocket;
  browserId: string;
  calls: { tool: string; params: Record<string, unknown> }[];
  close(): void;
}

/**
 * Connects a fake extension to a REAL spawned daemon. The daemon proves itself with its
 * enrollment secret (checked by the real extension, not needed here); the extension proves
 * itself back with the IPC token (mcp-server/src/bridge.ts:306 verifies against `this.token`,
 * the same token.json value an MCP client's IPC hello uses — not the enrollment secret).
 */
export async function connectFakeExtension(
  handle: Pick<DaemonHandle, 'wsPort' | 'token'>,
  browserId: string,
  opts: FakeExtensionOptions = {},
): Promise<FakeExtension> {
  const capabilities = opts.capabilities ?? [...EXTENSION_PROTOCOL_CAPABILITIES, 'site-context'];
  const calls: { tool: string; params: Record<string, unknown> }[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${handle.wsPort}`);

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'hello') {
      const ack = {
        type: 'helloAck' as const,
        protocolVersion: EXTENSION_PROTOCOL_VERSION,
        appVersion: 'memory-fixture',
        capabilities,
        clientNonce: msg.clientNonce,
        instanceId: msg.instanceId,
        browserId,
        browserLabel: `Fixture ${browserId}`,
      };
      const authProof = createWebSocketClientProof(handle.token, {
        protocolVersion: ack.protocolVersion,
        clientNonce: ack.clientNonce,
        serverNonce: msg.serverNonce,
        instanceId: ack.instanceId,
        browserId: ack.browserId,
        browserLabel: ack.browserLabel,
        capabilities: ack.capabilities,
      });
      ws.send(JSON.stringify({ ...ack, authProof }));
      return;
    }
    if (msg.tool) {
      calls.push({ tool: msg.tool, params: msg.params ?? {} });
      const custom = opts.onCall?.(msg.tool, msg.params ?? {});
      // An Error answers as a failed call (an unreachable port, a closed tab), the way the real extension does.
      if (custom instanceof Error) { ws.send(JSON.stringify({ id: msg.id, success: false, error: custom.message })); return; }
      if (custom !== undefined) { ws.send(JSON.stringify({ id: msg.id, success: true, result: custom })); return; }

      const wantsObserve = (msg.params ?? {}).observe === true;
      const isObservable = msg.tool === 'browser_navigate' || msg.tool === 'browser_snapshot';
      const url: string | undefined = (msg.params ?? {}).url;
      const siteContext = wantsObserve && isObservable && url ? opts.siteContextByUrl?.[url] : undefined;
      const result: Record<string, unknown> = { from: browserId };
      if (siteContext) result.siteContext = siteContext;
      ws.send(JSON.stringify({ id: msg.id, success: true, result }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fake extension: WS did not open within 5s')), 5000);
    ws.once('open', () => { clearTimeout(timer); resolve(); });
    ws.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
  ws.send(JSON.stringify({ type: 'authInit', clientNonce: newAuthNonce() }));
  await sleep(80);
  return { ws, browserId, calls, close: () => { try { ws.close(); } catch { /* already closed */ } } };
}

// ---------------------------------------------------------------------------
// memory/policy.json read/write (data-model.md's MemoryPolicy)
// ---------------------------------------------------------------------------

export interface MemoryPolicy {
  schemaVersion: 1;
  enabled: boolean;
  enabledAt: string | null;
  excluded: string[];
  deletions: Record<string, string>;
  updatedAt: string;
}

function policyPath(stateDir: string): string {
  return path.join(stateDir, 'memory', 'policy.json');
}

export function readPolicy(stateDir: string): MemoryPolicy | null {
  try { return JSON.parse(fs.readFileSync(policyPath(stateDir), 'utf8')); } catch { return null; }
}

export function writePolicy(stateDir: string, policy: MemoryPolicy): void {
  const dir = path.dirname(policyPath(stateDir));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(policyPath(stateDir), JSON.stringify(policy, null, 2));
}

/** Convenience: an enabled policy with no exclusions or deletions, for tests that just need memory on. */
export function writeEnabledPolicy(stateDir: string, overrides: Partial<MemoryPolicy> = {}): MemoryPolicy {
  const now = new Date().toISOString();
  const policy: MemoryPolicy = {
    schemaVersion: 1,
    enabled: true,
    enabledAt: now,
    excluded: [],
    deletions: {},
    updatedAt: now,
    ...overrides,
  };
  writePolicy(stateDir, policy);
  return policy;
}

/** memory/sites/<sha256(origin)>.json, per data-model.md. */
export function siteRecordPath(stateDir: string, origin: string): string {
  const hash = crypto.createHash('sha256').update(origin, 'utf8').digest('hex');
  return path.join(stateDir, 'memory', 'sites', `${hash}.json`);
}

// ---------------------------------------------------------------------------
// Fake clock
// ---------------------------------------------------------------------------

/**
 * A plain, self-contained clock for computing expected timestamps in tests (e.g. AC-23's
 * "+10 years, restart, fact still current"). It is NOT wired into the daemon or any memory
 * module — whoever implements store.ts (T020) or the reconciliation logic (T053) decides
 * whether production code takes an injectable clock; this stays a test-local utility so that
 * decision isn't presumed here.
 */
export function makeFakeClock(startMs: number = Date.now()) {
  let current = startMs;
  return {
    now: () => new Date(current),
    nowIso: () => new Date(current).toISOString(),
    advance: (ms: number) => { current += ms; },
  };
}

// ---------------------------------------------------------------------------
// Fixture HTTP server (scripts/pages/memory/*.html)
// ---------------------------------------------------------------------------

const PATH_OVERRIDES: Record<string, string> = {
  '/account/login': 'login.html',
  '/login': 'changed.html',
};

const COOKIE_SETTERS: Record<string, (res: http.ServerResponse) => void> = {
  'consent-cookie.html': (res) => res.setHeader('Set-Cookie', 'CookieConsent=1; Path=/; SameSite=Lax'),
  'session-cookie.html': (res) => res.setHeader('Set-Cookie', 'sid=fixture-session-id; Path=/; HttpOnly; SameSite=Lax'),
};

export interface FixtureServer {
  origin: string;
  port: number;
  secondaryOrigin: string;
  secondaryPort: number;
  close(): Promise<void>;
}

function pageNameFor(urlPath: string): string {
  const withoutQuery = urlPath.split('?')[0];
  if (PATH_OVERRIDES[withoutQuery]) return PATH_OVERRIDES[withoutQuery];
  const name = withoutQuery === '/' ? 'public.html' : withoutQuery.replace(/^\//, '');
  return name.endsWith('.html') ? name : `${name}.html`;
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, secondaryOrigin: string): void {
  const urlPath = req.url ?? '/';
  if (urlPath.split('?')[0] === '/redirect') {
    res.statusCode = 302;
    res.setHeader('Location', `${secondaryOrigin}/public.html`);
    res.end();
    return;
  }
  const name = pageNameFor(urlPath);
  const filePath = path.join(MEMORY_PAGES_DIR, name);
  let body: string;
  try {
    body = fs.readFileSync(filePath, 'utf8');
  } catch {
    res.statusCode = 404;
    res.end('not found');
    return;
  }
  if (name === 'frame.html') body = body.replaceAll('{{SECONDARY_ORIGIN}}', secondaryOrigin);
  COOKIE_SETTERS[name]?.(res);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(body);
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
  });
}

/** Two loopback servers (primary + a secondary origin for redirect/cross-origin-iframe tests). */
export async function startFixtureServer(): Promise<FixtureServer> {
  let secondaryOrigin = '';
  const primary = http.createServer((req, res) => serveStatic(req, res, secondaryOrigin));
  const secondary = http.createServer((req, res) => serveStatic(req, res, secondaryOrigin));
  const secondaryPort = await listen(secondary);
  secondaryOrigin = `http://127.0.0.1:${secondaryPort}`;
  const port = await listen(primary);
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    port,
    secondaryOrigin,
    secondaryPort,
    close: () => Promise.all([
      new Promise<void>((r) => primary.close(() => r())),
      new Promise<void>((r) => secondary.close(() => r())),
    ]).then(() => undefined),
  };
}

// ---------------------------------------------------------------------------
// Network sink (FR-009/R-16: the memory module must perform no network I/O)
// ---------------------------------------------------------------------------

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost', '0.0.0.0']);

function isLoopbackHost(host: string | undefined | null): boolean {
  if (!host) return false;
  return LOOPBACK_HOSTS.has(host) || host.startsWith('127.');
}

export interface NetworkSink {
  violations: string[];
  restore(): void;
}

/** Fails any non-loopback net.connect/http(s).request/fetch/dns.lookup while installed. */
export function installNetworkSink(): NetworkSink {
  const violations: string[] = [];
  const originalConnect = net.connect;
  const originalCreateConnection = net.createConnection;
  const originalHttpRequest = http.request;
  const originalHttpsRequest = https.request;
  const originalFetch = globalThis.fetch;
  const originalLookup = dns.lookup;

  function guardHost(host: string | undefined, source: string): void {
    if (!isLoopbackHost(host)) {
      violations.push(`${source}: ${host ?? '(unknown host)'}`);
      throw new Error(`NETWORK_SINK: blocked non-loopback ${source} to ${host ?? '(unknown host)'}`);
    }
  }

  function hostFromArgs(args: unknown[]): string | undefined {
    const first = args[0];
    if (typeof first === 'string') { try { return new URL(first).hostname; } catch { return first; } }
    if (first && typeof first === 'object') return (first as { host?: string; hostname?: string }).host ?? (first as { hostname?: string }).hostname;
    return undefined;
  }

  // Test-only monkeypatch, restored in restore().
  net.connect = (...args: any[]) => { guardHost(hostFromArgs(args), 'net.connect'); return originalConnect(...(args as Parameters<typeof net.connect>)); };
  net.createConnection = (...args: any[]) => { guardHost(hostFromArgs(args), 'net.createConnection'); return originalCreateConnection(...(args as Parameters<typeof net.createConnection>)); };
  http.request = (...args: any[]) => { guardHost(hostFromArgs(args), 'http.request'); return originalHttpRequest(...(args as Parameters<typeof http.request>)); };
  https.request = (...args: any[]) => { guardHost(hostFromArgs(args), 'https.request'); return originalHttpsRequest(...(args as Parameters<typeof https.request>)); };
  if (originalFetch) {
    globalThis.fetch = (async (...args: any[]) => {
      const input = args[0];
      const url = typeof input === 'string' ? input : (input as Request)?.url;
      guardHost(url ? new URL(url).hostname : undefined, 'fetch');
      return originalFetch(...(args as Parameters<typeof fetch>));
    }) as typeof fetch;
  }
  // @ts-expect-error
  dns.lookup = (...args: any[]) => { guardHost(args[0] as string, 'dns.lookup'); return (originalLookup as any)(...args); };

  return {
    violations,
    restore() {
      net.connect = originalConnect;
      net.createConnection = originalCreateConnection;
      http.request = originalHttpRequest;
      https.request = originalHttpsRequest;
      if (originalFetch) globalThis.fetch = originalFetch;
      dns.lookup = originalLookup;
    },
  };
}
