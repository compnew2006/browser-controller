#!/usr/bin/env node

/**
 * Thin MCP client (plan task 1.0).
 *
 * This is what `npx browser-controller` runs. It does NOT open a WebSocket server
 * — the daemon owns that. Instead it:
 *   1. Speaks MCP over stdio to the agent (Cursor / Claude).
 *   2. Forwards every tool call to the daemon over the local IPC socket.
 *   3. Spawns the daemon (as a detached child) if it isn't already running.
 *
 * Multiple instances of this process can run concurrently and all share the one
 * daemon, which is what lets two agents work in two tabs without fighting over
 * port 7225.
 */
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const setupIdx = process.argv.indexOf('--setup');
if (setupIdx !== -1) {
  const target = process.argv[setupIdx + 1] || '';
  const setupScript = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'agent-config', 'setup.mjs');
  spawn('node', [setupScript, target], { stdio: 'inherit' });
  process.exit(0);
}

/**
 * Parse `--agent <name>` (or `--agent=<name>`) from argv. This is the
 * user-facing way to name the agent in the MCP config, e.g.
 *   args: [".../index.js", "--agent", "Cursor"]
 * Takes priority over every other detection path. Returns null if absent.
 */
function parseAgentArg(): string | null {
  const args = process.argv;
  // --agent <name>  (two tokens)
  const idx = args.indexOf('--agent');
  if (idx !== -1 && idx + 1 < args.length) {
    const v = args[idx + 1].trim();
    if (v) return v;
  }
  // --agent=<name>  (one token)
  const eq = args.find((a) => a.startsWith('--agent='));
  if (eq) {
    const v = eq.slice('--agent='.length).trim();
    if (v) return v;
  }
  return null;
}

import net from 'node:net';
import fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { allTools } from './tools/index.js';
import { registerTools } from './register-tools.js';
import {
  DAEMON_INFO_FILE,
  IPC_SOCKET_PATH,
  STATE_DIR,
  loadOrCreateEnrollment,
  readEnrollmentSecret,
  readToken,
} from './daemon-config.js';

const SERVER_NAME = 'browser-controller';
const SERVER_VERSION = '2.0.0';
const DAEMON_STARTUP_MS = 8_000;
const CONNECT_RETRY_MS = 250;
const MAX_CONNECT_TRIES = 32; // ~8s

/**
 * Daemon connection: a line-delimited JSON socket speaking the IPC protocol
 * defined in daemon-config.ts (hello/welcome/call/result).
 */
class DaemonClient {
  private socket: net.Socket | null = null;
  private buf = '';
  /** Session id assigned by the daemon (visible to the extension for tab locking). */
  private _sessionId: string | null = null;
  /** @returns session id assigned by the daemon, for logging. */
  get sessionId(): string | null { return this._sessionId; }
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; t: ReturnType<typeof setTimeout> }>();
  private daemonCallId = 0;
  private connectResolvers: Array<() => void> = [];
  private closeHandlers: Array<() => void> = [];
  private readonly ipcPath: string;
  private readonly token: string;
  private readonly agentName: string;

  constructor(ipcPath: string, token: string, agentName: string) {
    this.ipcPath = ipcPath;
    this.token = token;
    this.agentName = agentName;
  }

  async connect(): Promise<void> {
    this.socket = net.createConnection(this.ipcPath);
    await new Promise<void>((resolve, reject) => {
      const onErr = (err: Error) => reject(err);
      this.socket!.once('connect', () => {
        this.socket!.off('error', onErr);
        resolve();
      });
      this.socket!.once('error', onErr);
    });

    this.socket.setEncoding('utf8');

    this.socket.on('data', (chunk: string) => {
      this.buf += chunk;
      let nl: number;
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        try {
          this.handleMessage(JSON.parse(line));
        } catch (err) {
          console.error(`[${SERVER_NAME}] daemon parse error:`, err);
        }
      }
    });

    this.socket.on('close', () => {
      this.failAll('daemon connection closed');
      this.closeHandlers.forEach(h => h());
    });
    this.socket.on('error', (err: Error) => {
      console.error(`[${SERVER_NAME}] daemon socket error:`, err.message);
    });

    // authenticate
    this.socket.write(JSON.stringify({ kind: 'hello', token: this.token, agentName: this.agentName }) + '\n');

    await this.waitForWelcome();
  }

  private waitForWelcome(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('daemon welcome timeout')), 5_000);
      this.connectResolvers.push(() => {
        clearTimeout(timer);
        resolve();
      });
      // also reject path captured via close
      this.closeHandlers.push(() => {
        clearTimeout(timer);
        reject(new Error('daemon closed before welcome'));
      });
    });
  }

  private handleMessage(msg: { kind: string; sessionId?: string; id?: string; success?: boolean; result?: unknown; error?: string; reason?: string }): void {
    switch (msg.kind) {
      case 'welcome':
        this._sessionId = msg.sessionId ?? null;
        this.connectResolvers.forEach(r => r());
        this.connectResolvers = [];
        console.error(`[${SERVER_NAME}] joined daemon as ${this.sessionId}`);
        break;
      case 'denied':
        console.error(`[${SERVER_NAME}] daemon denied: ${msg.reason}`);
        process.exit(1);
        break;
      case 'ping':
        // Heartbeat probe from the daemon — reply immediately or it will evict
        // us as a zombie after 3 missed pongs (~45s).
        try {
          this.socket?.write(JSON.stringify({ kind: 'pong' }) + '\n');
        } catch {
          // socket gone — close handler will fire
        }
        break;
      case 'result': {
        const id = msg.id;
        if (!id) return;
        const entry = this.pending.get(id);
        if (!entry) return;
        clearTimeout(entry.t);
        this.pending.delete(id);
        if (msg.success) entry.resolve(msg.result);
        else entry.reject(new Error(msg.error || 'Unknown daemon error'));
        break;
      }
      default:
        break;
    }
  }

  callTool(tool: string, params: Record<string, unknown>): Promise<unknown> {
    const id = String(++this.daemonCallId);
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) {
        reject(new Error('Not connected to daemon'));
        return;
      }
      // Client-side safety-net timeout (audit M4). The BRIDGE owns the real
      // per-tool timeout (each tool's `timeoutMs`, up to 60s) + retries
      // (×3 = 180s worst case for idempotent reads). This client timer must
      // always outlive the bridge's worst case so the bridge's own rejection
      // (with an actionable message) wins; the client timer is only a backstop
      // if the daemon itself hangs. 210s = 60s × 3 + 30s slack.
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Tool call timed out (client side): ${tool}`));
      }, 210_000);
      this.pending.set(id, { resolve, reject, t });
      try {
        this.socket.write(JSON.stringify({ kind: 'call', id, tool, params }) + '\n');
      } catch (err) {
        clearTimeout(t);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error('write failed'));
      }
    });
  }

  private failAll(reason: string): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.t);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
  }

  /** Register a handler fired when the daemon socket closes (audit m3 respawn). */
  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }
}

/** True if a daemon appears to be live (socket file + info file present). */
/**
 * Whether a daemon is worth reusing: the IPC socket file exists, the info file
 * is fresh (< 1h), AND — critically — the socket actually ACCEPTS a connection.
 * The connect-probe is what stops a second MCP client from spawning a NEW
 * daemon on top of one that's hung in `accept()` (the info file is stale-proof
 * but a crashed-but-not-yet-reaped daemon leaves the socket file behind for a
 * few seconds). Combining the cheap file check with a 250ms TCP probe gives a
 * reliable signal without blocking startup when no daemon exists.
 *
 * Retry-once-on-failure: when the info file is FRESH (startedAt < 10s ago) but
 * the IPC connect probe failed, the daemon is likely still mid-startup (the
 * socket file may exist before the daemon calls listen() on it, or a sibling
 * MCP client just spawned one). We wait 300ms and probe again before declaring
 * the daemon dead and spawning a competitor. This closes the
 * spawn-kill-restart loop where N concurrent clients each spawned a daemon,
 * hit EADDRINUSE, and SIGTERM'd each other's healthy daemon.
 */
async function daemonLooksAlive(): Promise<boolean> {
  // Active probe: try to open+close the IPC socket. A live daemon accepts
  // immediately; a crashed-but-not-reaped process refuses or hangs. 250ms is
  // plenty on localhost and far below the spawn-daemon startup cost.
  const connectProbe = (): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      const s = net.createConnection(IPC_SOCKET_PATH);
      const t = setTimeout(() => { s.destroy(); resolve(false); }, 250);
      s.once('connect', () => { clearTimeout(t); s.destroy(); resolve(true); });
      s.once('error', () => { clearTimeout(t); resolve(false); });
    });

  try {
    // Fast-fail when no daemon was ever started here. We check the INFO file
    // (daemon.json), NOT the socket: the IPC socket path can exceed the
    // kernel's AF_UNIX sun_path limit on macOS (104 bytes), in which case the
    // kernel truncates the on-disk name and fs.existsSync reports false
    // FOREVER — even though net.createConnection still connects (both sides
    // truncate identically). The connect-probe below is the ground truth; the
    // info file is just a cheap "was a daemon ever spawned here" pre-check.
    if (!fs.existsSync(DAEMON_INFO_FILE)) return false;
    const info = JSON.parse(fs.readFileSync(DAEMON_INFO_FILE, 'utf8'));
    const ageMs = Date.now() - info.startedAt;
    if (ageMs > 60 * 60 * 1000) return false;

    if (await connectProbe()) return true;

    // First probe failed. If the daemon is brand new (< 10s old) it may simply
    // not have finished binding the IPC socket yet — retry once instead of
    // spawning a competitor. This is the cheap, deterministic fix for the
    // spawn race that previously caused mutual SIGTERM between concurrent
    // MCP clients.
    if (ageMs < 10_000) {
      await new Promise((r) => setTimeout(r, 300));
      return await connectProbe();
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Best-effort detection of which MCP client launched us, so the popup can show
 * "Cursor" / "Claude Desktop" instead of the opaque session id or the bare
 * "agent" fallback. Checks env vars first (cheap, deterministic), then the
 * parent process name (catches the case where the IDE sets no marker env var).
 * Override explicitly with MCP_AGENT_NAME / BROWSER_CONTROLLER_AGENT_NAME.
 */
function deriveAgentName(): string {
  const env = process.env;
  if (env.CURSOR_TRACE_ID || env.TERM_PROGRAM === 'cursor') return 'Cursor';
  if (env.CLAUDE_DESKTOP || env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT) return 'Claude';
  if (env.WINDSURF_USER || env.WS_SURVEY_DATA) return 'Windsurf';
  if (env.CLINE_IDE) return 'Cline';
  if (env.TERM_PROGRAM) return env.TERM_PROGRAM;
  // Env-based detection missed — inspect the parent process name. This catches
  // launches where the IDE set no marker env var (the common cause of the bare
  // "agent" label seen in the popup). ps is fast and always available on the
  // daemon's host.
  try {
    const parent = execSync(`ps -p ${process.ppid} -o comm=`, { encoding: 'utf8' }).trim();
    if (/cursor/i.test(parent)) return 'Cursor';
    if (/claude/i.test(parent)) return 'Claude';
    if (/windsurf/i.test(parent)) return 'Windsurf';
    if (/cline/i.test(parent)) return 'Cline';
    if (parent) return parent.split('/').pop() || parent; // last path segment of the binary
  } catch {
    // ps unavailable (non-Unix?) — fall through
  }
  return 'agent';
}

/** Spawn the daemon as a detached background process. */
function spawnDaemon(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const daemonEntry = join(here, 'daemon.js');
  if (!fs.existsSync(daemonEntry)) {
    throw new Error(`Daemon entry not found at ${daemonEntry}. Run 'npm run build' first.`);
  }
  console.error(`[${SERVER_NAME}] starting daemon (detached)…`);
  // Daemon log lives in STATE_DIR (~/.browser-controller) alongside the token
  // and daemon.json. (Previously this wrote to ~/.real-browser-mcp/ — the old
  // product name — splitting state across two directories.)
  const logPath = join(STATE_DIR, 'daemon.log');
  fs.mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
  const out = fs.openSync(logPath, 'a', 0o600);
  const child = spawn(process.execPath, [daemonEntry], {
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.unref();
}

/** Wait until the IPC socket becomes connectable. */
async function waitForDaemon(): Promise<void> {
  for (let i = 0; i < MAX_CONNECT_TRIES; i++) {
    // Probe the socket directly rather than gating on fs.existsSync: the IPC
    // socket path can exceed the kernel's AF_UNIX sun_path limit on macOS
    // (104 bytes), truncating the on-disk name so existsSync never sees it —
    // while createConnection still succeeds (both sides truncate identically).
    const ok = await new Promise<boolean>((resolve) => {
      const s = net.createConnection(IPC_SOCKET_PATH);
      s.once('connect', () => { s.destroy(); resolve(true); });
      s.once('error', () => resolve(false));
    });
    if (ok) return;
    await new Promise(r => setTimeout(r, CONNECT_RETRY_MS));
  }
  throw new Error(`Daemon did not become reachable within ${DAEMON_STARTUP_MS / 1000}s`);
}

async function main(): Promise<void> {
  // 1) ensure a token exists (daemon may not have created one yet → create + it
  //    will reuse the same file on next start). If absent, create it here so the
  //    spawned daemon reads the identical token.
  let token = readToken();
  if (!token) {
    // create lazily via daemon-config's loadOrCreateToken path
    const { loadOrCreateToken } = await import('./daemon-config.js');
    token = loadOrCreateToken().token;
  }

  // Enrollment is shown only by this foreground client on first creation. The
  // detached daemon must never copy the secret into its persistent log.
  const existingEnrollment = readEnrollmentSecret();
  const enrollment = existingEnrollment ?? loadOrCreateEnrollment().secret;
  if (!existingEnrollment) {
    console.error(`[${SERVER_NAME}] enrollment secret (enter in the popup once): ${enrollment}`);
  }

  // 2) ensure daemon is up
  if (!(await daemonLooksAlive())) {
    spawnDaemon();
    await waitForDaemon();
  }

  // 3) connect to daemon. Resolve a human-readable agent name for the popup UI.
  //    Priority: --agent flag > env vars > parent-process detection > 'agent'.
  //    The --agent flag is the documented user-facing way to set it in the MCP
  //    config (args: [".../index.js", "--agent", "Cursor"]).
  const agentName =
    parseAgentArg() ||
    process.env.MCP_AGENT_NAME ||
    process.env.BROWSER_CONTROLLER_AGENT_NAME ||
    deriveAgentName();

  // 3) connect to daemon
  const client = new DaemonClient(IPC_SOCKET_PATH, token, agentName);
  await client.connect();

  // One-shot daemon respawn on disconnect (audit m3). If the daemon dies after
  // startup, the thin client used to reject every subsequent call forever — the
  // MCP host had to be restarted by its parent. Now we attempt exactly ONE
  // respawn+reconnect before giving up. The `respawned` flag prevents infinite
  // respawn loops if the daemon can't stay up.
  let respawned = false;
  client.onClose(() => {
    if (respawned) return;
    respawned = true;
    void (async () => {
      try {
        if (await daemonLooksAlive()) {
          console.error(`[${SERVER_NAME}] daemon connection lost — reconnecting to live daemon`);
        } else {
          console.error(`[${SERVER_NAME}] daemon connection lost — attempting one respawn`);
          spawnDaemon();
          await waitForDaemon();
        }
        await client.connect();
        console.error(`[${SERVER_NAME}] reconnected to daemon`);
      } catch (err) {
        console.error(`[${SERVER_NAME}] reconnect failed:`, err);
      }
    })();
  });

  // 4) wire MCP <-> daemon
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  // Progressive disclosure (Anthropic "Code Execution with MCP" pattern):
  // Instead of registering all 22 tools upfront (~4200 tokens in system prompt),
  // only browser_tools (the meta tool) is visible, and the agent discovers +
  // activates other tools on demand via browser_tools {action:"details"}.
  //
  // Default is FULL mode (all tools visible) for safety — existing agents that
  // call browser_click directly will work without changes. Opt INTO progressive
  // disclosure with BROWSER_CONTROLLER_PROGRESSIVE=1: the initial tools/list
  // drops ~96% (~150 vs ~4200 tokens); a typical task that activates 3-5 tools
  // via browser_tools still nets ~75-80% savings.
  const fullMode = !process.env.BROWSER_CONTROLLER_PROGRESSIVE;

  // Registration logic lives in register-tools.ts so the disable/enable wiring
  // is covered by tests/register-tools.test.ts (this main() needs a live daemon).
  registerTools(server, client, fullMode, (msg) => console.error(`[${SERVER_NAME}] ${msg}`));

  if (!fullMode) {
    console.error(`[${SERVER_NAME}] progressive disclosure: ON (${allTools.length} tools hidden, use browser_tools to discover)`);
  } else {
    console.error(`[${SERVER_NAME}] full tool mode: ${allTools.length + 1} tools visible (set BROWSER_CONTROLLER_PROGRESSIVE=1 to cut initial tool tokens ~96%)`);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[${SERVER_NAME}] MCP server connected (via daemon as ${client.sessionId ?? '?'})`);

  process.on('SIGINT', () => { client.close(); process.exit(0); });
  process.on('SIGTERM', () => { client.close(); process.exit(0); });
}

main().catch((err) => {
  console.error(`[${SERVER_NAME}] Fatal:`, err);
  process.exit(1);
});
