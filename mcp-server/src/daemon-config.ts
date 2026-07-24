import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

/**
 * Daemon configuration, IPC protocol, paths, and auth-token helpers.
 *
 * Architecture (see plan task 1.0):
 *   Agent (stdio) ──► thin MCP client (index.ts) ──IPC──► daemon (daemon.ts)
 *                                                              │ owns WS server :7225
 *                                                              ▼
 *                                                         Chrome extension
 *
 * The daemon is a pure multiplexer. It does NOT speak MCP. It ferries
 * `{id, tool, params}` calls between N stdio MCP clients (over a local IPC
 * socket) and the single Chrome extension (over WS), tagging every call with a
 * per-client `sessionId` so the extension can do per-agent tab locking (2.2).
 */

export const DEFAULT_WS_PORT = parseInt(process.env.WS_PORT || '7225', 10);
export const DEFAULT_WS_HOST = process.env.WS_HOST || '127.0.0.1';

/**
 * Directory under the user's home where daemon state lives (token, socket,
 * daemon.json, daemon.log). Override with BC_STATE_DIR for isolated tests so
 * the suite never touches the real ~/.browser-controller.
 */
export const STATE_DIR = process.env.BC_STATE_DIR || path.join(os.homedir(), '.browser-controller');

/** Local IPC socket the daemon listens on (thin clients connect here). */
export const IPC_SOCKET_PATH =
  process.platform === 'win32'
    ? '\\\\.\\pipe\\browser-controller'
    : path.join(STATE_DIR, 'daemon.sock');

/** Daemon metadata file: { pid, socket, port, startedAt }. */
export const DAEMON_INFO_FILE = path.join(STATE_DIR, 'daemon.json');

/** Auth token file (3.1): both IPC clients and the extension must present it. */
export const TOKEN_FILE = path.join(STATE_DIR, 'token.json');

// --- IPC / WS protocol message shapes --------------------------------------

export type IpcClientMessage =
  | { kind: 'hello'; token: string; agentName?: string }
  | { kind: 'call'; id: string; tool: string; params: Record<string, unknown> }
  | { kind: 'pong' }; // heartbeat reply — daemon evicts a silent client after 3 missed pings

export type IpcDaemonMessage =
  | { kind: 'welcome'; sessionId: string; ok: true }
  | { kind: 'denied'; reason: string; ok: false }
  | { kind: 'result'; id: string; success: boolean; result?: unknown; error?: string }
  | { kind: 'status'; connectionState: string; connectedSince: number | null }
  | { kind: 'ping' }; // heartbeat probe — client must reply with { kind: 'pong' }

/**
 * Message the daemon forwards to the extension. `sessionId` is included so the
 * extension can enforce per-agent tab locks (task 2.2). `id` is daemon-global.
 */
export interface ExtensionRequest {
  id: string;
  tool: string;
  params: Record<string, unknown>;
  sessionId: string;
}

// --- Idempotency (task 2.3) ------------------------------------------------

/**
 * Tools that are safe to retry on timeout because re-running them has no side
 * effects (they only read). Everything else is treated as non-idempotent and is
 * NOT retried — a click must never fire twice.
 *
 * NOTE: `browser_evaluate` runs ARBITRARY user JS (can submit forms, click,
 * mutate state) so it is NOT here despite "looking" like a read. `browser_tabs`
 * has lock/unlock/close side effects, so it is NOT here either.
 */
export const IDEMPOTENT_TOOLS = new Set<string>([
  'browser_snapshot',
  'browser_screenshot',
  'browser_text',
  'browser_find',
  'browser_console',
  'browser_network',
]);

export function isIdempotent(tool: string): boolean {
  return IDEMPOTENT_TOOLS.has(tool);
}

// --- Auth token (task 3.1) -------------------------------------------------

export interface StoredToken {
  token: string;
  createdAt: number;
}

/** Reads the existing token, or creates the state dir + token on first run. */
export function loadOrCreateToken(): StoredToken {
  try {
    const raw = fs.readFileSync(TOKEN_FILE, 'utf8');
    const parsed = JSON.parse(raw) as StoredToken;
    if (parsed.token && typeof parsed.token === 'string') return parsed;
  } catch {
    // missing or invalid — fall through to create
  }
  const created: StoredToken = { token: crypto.randomBytes(24).toString('hex'), createdAt: Date.now() };
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(created, null, 2), { mode: 0o600 });
  return created;
}

/** Reads the token without creating one (returns null if absent). */
export function readToken(): string | null {
  try {
    const raw = fs.readFileSync(TOKEN_FILE, 'utf8');
    const parsed = JSON.parse(raw) as StoredToken;
    return parsed.token ?? null;
  } catch {
    return null;
  }
}
