#!/usr/bin/env node
/**
 * R-18 workload runner for specs/003-website-agent-memory (tasks.md T012, T065).
 *
 * Owns an isolated BC_STATE_DIR and daemon; never touches ~/.browser-controller or a
 * user's real Chrome. Drives the daemon the same way scripts/smoke-real-chrome.mjs does
 * (raw IPC, line-delimited JSON), but against a FAKE extension over WebSocket instead of
 * real Chrome, because R-18 only needs the daemon's own overhead, not a browser.
 *
 * Usage: node scripts/memory-bench.mjs [--mode baseline|on-empty|on-seeded] [--iterations 200]
 *
 * `browser_memory`/`browser_memory_policy` and the memory module (Phase 2/3, tasks.md) do
 * not exist yet at the time this script was written. Calls to them fail with "unknown
 * tool", counted and reported as UNAVAILABLE rather than crashing the run — so only
 * `--mode baseline` is meaningfully different from the others today; on-empty/on-seeded
 * are kept so this same script measures the real thing once Phase 2/3 land.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST_DAEMON = path.join(ROOT, 'mcp-server', 'dist', 'daemon.js');
const OUT_FILE = path.join(ROOT, 'specs', '003-website-agent-memory', 'baseline.md');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const out = { mode: 'baseline', iterations: 200, clients: 4, seeded: 1000 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--mode') out.mode = argv[++i];
    else if (argv[i] === '--iterations') out.iterations = Number(argv[++i]);
    else if (argv[i] === '--clients') out.clients = Number(argv[++i]);
    else if (argv[i] === '--seeded') out.seeded = Number(argv[++i]);
  }
  if (!['baseline', 'on-empty', 'on-seeded'].includes(out.mode)) {
    throw new Error(`--mode must be baseline|on-empty|on-seeded, got ${out.mode}`);
  }
  return out;
}

function percentile(sortedMs, p) {
  if (sortedMs.length === 0) return null;
  const idx = Math.min(sortedMs.length - 1, Math.ceil((p / 100) * sortedMs.length) - 1);
  return sortedMs[Math.max(0, idx)];
}

function summarize(samplesMs) {
  if (samplesMs.length === 0) return { p50: null, p95: null, p99: null, n: 0 };
  const sorted = [...samplesMs].sort((a, b) => a - b);
  return { p50: percentile(sorted, 50), p95: percentile(sorted, 95), p99: percentile(sorted, 99), n: sorted.length };
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function rssOf(pid) {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).WorkingSet64`]);
      return Number(stdout.trim()) / 1024; // bytes -> KiB, to match ps -o rss= (KiB)
    }
    const { stdout } = await execFileAsync('ps', ['-o', 'rss=', '-p', String(pid)]);
    return Number(stdout.trim());
  } catch {
    return null; // UNAVAILABLE: ps/PowerShell not reachable in this environment
  }
}

// --- isolated daemon lifecycle (same contract as tests/helpers/memory-fixtures.ts) ---

async function startIsolatedDaemon(stateDir, wsPort, env = {}) {
  if (!fs.existsSync(DIST_DAEMON)) throw new Error(`${DIST_DAEMON} missing — run \`npm run build\` first`);
  const sockPath = path.join(stateDir, 'daemon.sock');
  const startedAt = Date.now();
  const proc = spawn(process.execPath, [DIST_DAEMON], {
    env: { ...process.env, BC_STATE_DIR: stateDir, WS_PORT: String(wsPort), WS_HOST: '127.0.0.1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  proc.stderr?.on('data', (c) => { stderr += c.toString(); });
  for (let i = 0; i < 100; i++) {
    const up = await new Promise((resolve) => {
      const probe = net.createConnection(sockPath);
      probe.once('connect', () => { probe.destroy(); resolve(true); });
      probe.once('error', () => resolve(false));
    });
    if (up) {
      const startMs = Date.now() - startedAt;
      const token = JSON.parse(fs.readFileSync(path.join(stateDir, 'token.json'), 'utf8')).token;
      const enrollmentSecret = JSON.parse(fs.readFileSync(path.join(stateDir, 'enrollment.json'), 'utf8')).secret;
      return { proc, sockPath, wsPort, token, enrollmentSecret, startMs };
    }
    await sleep(50);
  }
  throw new Error(`daemon never came up. stderr:\n${stderr}`);
}

async function stopIsolatedDaemon(handle, signal = 'SIGTERM') {
  if (!handle.proc || handle.proc.killed || handle.proc.exitCode !== null) return;
  const exited = new Promise((resolve) => handle.proc.once('exit', () => resolve()));
  handle.proc.kill(signal);
  await exited;
  await sleep(50);
}

// --- raw IPC client (hello/welcome/call/result), built from the compiled daemon's own protocol ---

async function connectIpcClient(sockPath, token, agentName, buildIpcHello) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(sockPath);
    socket.setEncoding('utf8');
    const pending = new Map();
    let seq = 0;
    let buf = '';
    let resolved = false;
    const timer = setTimeout(() => { if (!resolved) reject(new Error('no welcome within 5s')); }, 5000);
    socket.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.kind === 'welcome' && !resolved) {
          resolved = true;
          clearTimeout(timer);
          resolve({
            socket,
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
    socket.on('error', (e) => { if (!resolved) { clearTimeout(timer); reject(e); } });
    socket.write(JSON.stringify(buildIpcHello(token, agentName)) + '\n');
  });
}

// --- fake extension: no real Chrome, just enough to answer navigate/snapshot/batch sub-calls ---

// The daemon proves itself with its enrollment secret; the extension (here, the fake)
// proves itself back with the IPC token — mcp-server/src/bridge.ts:306 verifies against
// `this.token`, the same token.json value an MCP client's IPC hello uses.
async function connectFakeExtension(wsPort, token, protocolMod, authMod) {
  const { EXTENSION_PROTOCOL_CAPABILITIES, EXTENSION_PROTOCOL_VERSION } = protocolMod;
  const { createWebSocketClientProof, newAuthNonce } = authMod;
  let nextTabId = 1;
  const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'hello') {
      const ack = {
        type: 'helloAck',
        protocolVersion: EXTENSION_PROTOCOL_VERSION,
        appVersion: 'memory-bench',
        capabilities: [...EXTENSION_PROTOCOL_CAPABILITIES],
        clientNonce: msg.clientNonce,
        instanceId: msg.instanceId,
        browserId: 'bench',
        browserLabel: 'Memory bench',
      };
      const authProof = createWebSocketClientProof(token, {
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
      const params = msg.params ?? {};
      let result;
      if (msg.tool === 'browser_navigate') result = { tabId: params.tabId ?? nextTabId++, url: params.url ?? 'about:blank' };
      else if (msg.tool === 'browser_snapshot') result = { text: 'generic "fixture" [e1]', tabId: params.tabId };
      else result = { from: 'bench' };
      ws.send(JSON.stringify({ id: msg.id, success: true, result }));
    }
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fake extension: WS did not open within 5s')), 5000);
    ws.once('open', () => { clearTimeout(timer); resolve(); });
    ws.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
  ws.send(JSON.stringify({ type: 'authInit', clientNonce: newAuthNonce() }));
  await sleep(80);
  return ws;
}

// --- memory/policy.json + synthetic sites (Phase 2/3 code does not exist yet; this prepares
//     the state dir so the same script measures the real thing once it does) ---

function writePolicy(stateDir, enabled) {
  const dir = path.join(stateDir, 'memory');
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(dir, 'policy.json'), JSON.stringify({
    schemaVersion: 1, enabled, enabledAt: enabled ? now : null, excluded: [], deletions: {}, updatedAt: now,
  }, null, 2));
}

function seedSiteRecords(stateDir, count) {
  const dir = path.join(stateDir, 'memory', 'sites');
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  for (let i = 0; i < count; i++) {
    const origin = `http://bench-${i}.example.test`;
    const hash = crypto.createHash('sha256').update(origin, 'utf8').digest('hex');
    const record = {
      schemaVersion: 1,
      origin,
      facts: [{ factId: 'ui.search', kind: 'ui.search', text: 'searchbox "Search"', verifiedAt: now }],
      profiles: {},
      commitSeq: 1,
    };
    fs.writeFileSync(path.join(dir, `${hash}.json`), JSON.stringify(record));
  }
}

function storeBytes(stateDir) {
  const dir = path.join(stateDir, 'memory');
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) total += fs.statSync(path.join(entry.parentPath ?? dir, entry.name)).size;
  }
  return total;
}

// --- workload ---

async function runTool(client, tool, params) {
  const started = performance.now();
  const response = await client.call(tool, params);
  const elapsedMs = performance.now() - started;
  const unavailable = response.success === false && /^(UNKNOWN_TOOL|MEMORY_)/.test(String(response.error ?? ''));
  return { elapsedMs, ok: response.success !== false, unavailable, size: JSON.stringify(response).length };
}

async function withClients(count, work) {
  return Promise.all(Array.from({ length: count }, (_, i) => work(i)));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-memory-bench-'));
  const wsPort = await freePort();

  const protocolMod = await import(pathToFileURL(path.join(ROOT, 'mcp-server', 'dist', 'protocol.js')).href);
  const authMod = await import(pathToFileURL(path.join(ROOT, 'mcp-server', 'dist', 'bridge-auth.js')).href);

  writePolicy(stateDir, args.mode !== 'baseline');
  if (args.mode === 'on-seeded') seedSiteRecords(stateDir, args.seeded);

  const handle = await startIsolatedDaemon(stateDir, wsPort);
  const extensionWs = await connectFakeExtension(wsPort, handle.token, protocolMod, authMod);
  await sleep(100); // let the daemon register the fake extension before load starts

  const idleRssKb = await rssOf(handle.proc.pid);

  const samples = { browser_navigate: [], 'browser_navigate_snapshot': [], browser_snapshot: [], browser_memory: [], batch: [] };
  const unavailableTools = new Set();
  let peakRssKb = idleRssKb ?? 0;
  const rssInterval = setInterval(async () => {
    const rss = await rssOf(handle.proc.pid);
    if (rss !== null) peakRssKb = Math.max(peakRssKb, rss);
  }, 200);

  const url = 'http://127.0.0.1:1/public.html'; // no real page needed: the fake extension answers directly

  const clients = await withClients(args.clients, (i) => connectIpcClient(handle.sockPath, handle.token, `Bench${i}`, protocolMod.buildIpcHello));

  async function iterate(tool, run) {
    await withClients(args.clients, async (i) => {
      for (let n = 0; n < Math.ceil(args.iterations / args.clients); n++) {
        const outcome = await run(clients[i]);
        if (outcome.unavailable) { unavailableTools.add(tool); continue; }
        samples[tool].push(outcome.elapsedMs);
      }
    });
  }

  await iterate('browser_navigate', (c) => runTool(c, 'browser_navigate', { url }));
  await iterate('browser_navigate_snapshot', (c) => runTool(c, 'browser_navigate', { url, snapshot: true }));
  await iterate('browser_snapshot', async (c) => {
    const nav = await c.call('browser_navigate', { url });
    return runTool(c, 'browser_snapshot', { tabId: nav.result?.tabId });
  });
  await iterate('browser_memory', (c) => runTool(c, 'browser_memory', { tabId: 1 }));
  await iterate('batch', (c) => runTool(c, 'browser_batch', {
    steps: [
      { tool: 'browser_navigate', params: { url } },
      { tool: 'browser_snapshot', params: {} },
      { tool: 'browser_navigate', params: { url, snapshot: true } },
      { tool: 'browser_wait', params: { ms: 1 } },
      { tool: 'browser_snapshot', params: {} },
    ],
  }));

  clearInterval(rssInterval);
  for (const client of clients) client.close();
  try { extensionWs.close(); } catch { /* already closed */ }

  // Recovery time: kill -9 the daemon, then time a fresh start on the same state dir.
  await stopIsolatedDaemon(handle, 'SIGKILL');
  const recoveryHandle = await startIsolatedDaemon(stateDir, wsPort);
  const recoveryMs = recoveryHandle.startMs;
  await stopIsolatedDaemon(recoveryHandle);

  const bytes = storeBytes(stateDir);
  fs.rmSync(stateDir, { recursive: true, force: true });

  const report = {
    mode: args.mode,
    node: process.version,
    platform: `${process.platform}/${os.arch()}`,
    clients: args.clients,
    iterations: args.iterations,
    seeded: args.mode === 'on-seeded' ? args.seeded : 0,
    startMs: handle.startMs,
    recoveryMs,
    idleRssKb,
    peakRssKb,
    storeBytes: bytes,
    tools: Object.fromEntries(Object.entries(samples).map(([tool, ms]) => [tool, summarize(ms)])),
    unavailableTools: [...unavailableTools],
    queueDrops: 'UNAVAILABLE (queue.ts not implemented yet)',
  };

  appendReport(report);
  console.log(JSON.stringify(report, null, 2));
}

function appendReport(report) {
  const header = `## ${report.mode} — Node ${report.node}, ${report.platform} (${new Date().toISOString()})\n`;
  const lines = [header];
  lines.push(`- clients: ${report.clients}, iterations/tool: ${report.iterations}, seeded origins: ${report.seeded}`);
  lines.push(`- daemon start: ${report.startMs} ms; recovery after SIGKILL: ${report.recoveryMs} ms`);
  lines.push(`- idle RSS: ${report.idleRssKb ?? 'UNAVAILABLE'} KiB; peak RSS: ${report.peakRssKb ?? 'UNAVAILABLE'} KiB`);
  lines.push(`- store bytes: ${report.storeBytes}`);
  lines.push(`- queue drops: ${report.queueDrops}`);
  if (report.unavailableTools.length) lines.push(`- unavailable in this build: ${report.unavailableTools.join(', ')} (not implemented yet — Phase 2/3)`);
  lines.push('');
  lines.push('| Tool | n | p50 ms | p95 ms | p99 ms |');
  lines.push('|---|---|---|---|---|');
  for (const [tool, s] of Object.entries(report.tools)) {
    lines.push(`| ${tool} | ${s.n} | ${s.p50?.toFixed(2) ?? '—'} | ${s.p95?.toFixed(2) ?? '—'} | ${s.p99?.toFixed(2) ?? '—'} |`);
  }
  lines.push('');
  const outDir = path.dirname(OUT_FILE);
  fs.mkdirSync(outDir, { recursive: true });
  const prior = fs.existsSync(OUT_FILE) ? fs.readFileSync(OUT_FILE, 'utf8') : '# Baseline measurements (R-18)\n\nGenerated by scripts/memory-bench.mjs. Append-only: each run adds one section.\n\n';
  fs.writeFileSync(OUT_FILE, prior + lines.join('\n') + '\n');
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
