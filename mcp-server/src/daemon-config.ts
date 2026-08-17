import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

/**
 * App version, single-sourced from package.json (extension/manifest.json and
 * daemon.json report the same value). Previously three literals drifted
 * silently (audit finding). Runs from src/ (vitest) or dist/ (installed) —
 * package.json sits two levels up from both.
 */
export const APP_VERSION: string = (() => {
  try {
    const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
    const v = (JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string }).version;
    return typeof v === 'string' && v ? v : '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

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

/**
 * Parse an integer env var, falling back to `def` when unset, non-numeric, or
 * outside [min, max]. Bare `parseInt(process.env.X || '…')` yields NaN for
 * garbage values — a NaN WS port crashes listen() and a NaN heartbeat interval
 * fires pings ~every 1ms.
 */
export function envInt(name: string, def: number, min = 1, max?: number): number {
  const raw = parseInt(process.env[name] ?? '', 10);
  if (Number.isFinite(raw) && raw >= min && (max === undefined || raw <= max)) return raw;
  return def;
}

export const DEFAULT_WS_PORT = envInt('WS_PORT', 7225, 1, 65535);
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

/**
 * Enrollment secret file. A one-time out-of-band secret the legitimate
 * extension must present (via the X-BC-Enrollment header) on EVERY HTTP
 * endpoint — most importantly /pair, which is how it first obtains the auth
 * token. This closes the first-contact TOFU race: even if a co-installed
 * hostile extension wins the Origin-pinning race, it cannot obtain the token
 * because it does not know the enrollment secret (delivered to the user via
 * MCP-client terminal output and entered manually in the popup
 * once). See SECURITY.md "First-contact TOFU window".
 */
export const ENROLLMENT_FILE = path.join(STATE_DIR, 'enrollment.json');

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

// --- Idempotency -----------------------------------------------------------
// MOVED to mcp-server/src/tools/index.ts (isIdempotent), derived from each
// tool's `idempotent` flag. It was previously a hand-maintained string set
// here that silently drifted from the real registry (audit C1/m5) and wrongly
// included browser_console/browser_network (which mutate on clear:true — M2).

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
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
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

// --- Enrollment secret (closes first-contact TOFU race) --------------------

export interface StoredEnrollment {
  secret: string;
  createdAt: number;
}

/**
 * Reads the existing enrollment secret, or creates one on first run. The
 * secret is stable across daemon restarts (persisted to enrollment.json), so
 * the user pairs once and the popup keeps working after reboots. Rotating it
 * means deleting enrollment.json and re-running the server (the
 * daemon prints the new secret on next start).
 *
 * Use readEnrollmentSecret() to peek without creating (e.g. index.ts decides
 * whether to print the "first run — here is your secret" banner).
 */
export function loadOrCreateEnrollment(): StoredEnrollment {
  try {
    const raw = fs.readFileSync(ENROLLMENT_FILE, 'utf8');
    const parsed = JSON.parse(raw) as StoredEnrollment;
    if (parsed.secret && typeof parsed.secret === 'string') return parsed;
  } catch {
    // missing or invalid — fall through to create
  }
  const created: StoredEnrollment = { secret: crypto.randomBytes(24).toString('hex'), createdAt: Date.now() };
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(ENROLLMENT_FILE, JSON.stringify(created, null, 2), { mode: 0o600 });
  return created;
}

/** Reads the enrollment secret without creating one (returns null if absent). */
export function readEnrollmentSecret(): string | null {
  try {
    const raw = fs.readFileSync(ENROLLMENT_FILE, 'utf8');
    const parsed = JSON.parse(raw) as StoredEnrollment;
    return parsed.secret ?? null;
  } catch {
    return null;
  }
}
