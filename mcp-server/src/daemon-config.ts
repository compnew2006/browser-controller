import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ipcAnswers } from './ipc-probe.js';
import { pidAlive, reclaimLock, type LockIdentity, type ReclaimHooks } from './lock-file.js';

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
/**
 * The daemon's HTTP/WebSocket control plane is intentionally loopback-only.
 *
 * Do not make this configurable to 0.0.0.0: the extension-facing token gate is
 * useful for local pairing, but it is not a replacement for a network trust
 * boundary. Remote callers (including n8n) require a separately authenticated
 * transport and must not be given direct access to this browser socket.
 */
export const DEFAULT_WS_HOST = '127.0.0.1';

/** Directory under the user's home where daemon state lives. */
export const STATE_DIR = process.env.BC_STATE_DIR || path.join(os.homedir(), '.browser-controller');

/** Local IPC socket the daemon listens on (thin clients connect here). */
export const IPC_SOCKET_PATH =
  process.platform === 'win32'
    ? '\\\\.\\pipe\\browser-controller'
    : path.join(STATE_DIR, 'daemon.sock');

/** Daemon metadata file. */
export const DAEMON_INFO_FILE = path.join(STATE_DIR, 'daemon.json');

/** Daemon ownership lock; a live PID identifies the authoritative runtime. */
export const DAEMON_LOCK_FILE = path.join(STATE_DIR, 'daemon.lock');

/** A lock file younger than this that cannot be read is still being written by the daemon that created it. */
const LOCK_WRITE_GRACE_MS = 5_000;

/** A live pid is trusted this long after the lock was written; the IPC socket may not be listening yet. */
const LOCK_STARTUP_GRACE_MS = 10_000;

/** Test seam for the stale-lock race; empty in production. */
export const daemonLockReclaimHooks: ReclaimHooks = {};

/** Another daemon holds the runtime lock: this one lost the start race and must exit. */
export class DaemonLockHeldError extends Error {
  /** Pid of the holder; 0 when its lock file was still being written. */
  readonly ownerPid: number;
  constructor(ownerPid: number, options?: ErrorOptions) {
    super(ownerPid > 0
      ? `Browser Controller daemon lock is held by live process ${ownerPid}`
      : 'Browser Controller daemon lock is being taken by another daemon', options);
    this.name = 'DaemonLockHeldError';
    this.ownerPid = ownerPid;
  }
}

/**
 * Who holds daemon.lock: the pid of a live holder, 0 for a lock another daemon
 * is still writing (created, not yet filled), or null when the lock is free or
 * stale. A thin client that sees a holder waits for that daemon instead of
 * starting a competitor.
 */
export async function daemonLockHolder(): Promise<number | null> {
  return (await inspectDaemonLock()).holder;
}

/** Holder plus the identity of the lock file judged, so takeover can target exactly that file. */
async function inspectDaemonLock(): Promise<{ holder: number | null; judged: LockIdentity | null }> {
  let judged: LockIdentity;
  let mtimeMs: number;
  let raw: string;
  try {
    const st = fs.lstatSync(DAEMON_LOCK_FILE);
    judged = { dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs };
    mtimeMs = st.mtimeMs;
    raw = fs.readFileSync(DAEMON_LOCK_FILE, 'utf8');
  } catch { return { holder: null, judged: null }; }
  let ownerPid = 0;
  try { ownerPid = JSON.parse(raw).pid ?? 0; } catch { /* empty or corrupt */ }
  if (ownerPid > 0) {
    if (!pidAlive(ownerPid)) return { holder: null, judged };
    // A pid can be reused after a crash: past the startup grace the holder
    // must also answer on the IPC socket, or the lock is stale (audit F1-5).
    if (Date.now() - mtimeMs < LOCK_STARTUP_GRACE_MS || await ipcAnswers(IPC_SOCKET_PATH)) {
      return { holder: ownerPid, judged };
    }
    return { holder: null, judged };
  }
  // openSync('wx') creates the file before writeFileSync fills it: a daemon
  // that reads it in between must not take a fresh lock for a stale one.
  return { holder: Date.now() - mtimeMs < LOCK_WRITE_GRACE_MS ? 0 : null, judged };
}

/**
 * Acquire the runtime lock, removing only a demonstrably stale lock. Throws
 * DaemonLockHeldError when another daemon holds it.
 */
export async function acquireDaemonLock(): Promise<void> {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  for (;;) {
    try {
      const fd = fs.openSync(DAEMON_LOCK_FILE, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
      fs.closeSync(fd);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const { holder, judged } = await inspectDaemonLock();
      if (holder !== null) throw new DaemonLockHeldError(holder, { cause: err });
      // Compare-before-remove: only the file judged stale goes, never a
      // lock another starter created after our judgement.
      if (judged) reclaimLock(DAEMON_LOCK_FILE, judged, daemonLockReclaimHooks);
    }
  }
}

export function releaseDaemonLock(): void {
  try {
    if (JSON.parse(fs.readFileSync(DAEMON_LOCK_FILE, 'utf8')).pid === process.pid) {
      fs.unlinkSync(DAEMON_LOCK_FILE);
    }
  } catch { /* already gone */ }
}

/** Daemon stdout/stderr when a thin client or `npm run daemon:start` starts it. */
export const DAEMON_LOG_FILE = path.join(STATE_DIR, 'daemon.log');

/** Past this size daemon.log is moved to daemon.log.1 before a daemon starts; one old copy is kept. */
export const DAEMON_LOG_MAX_BYTES = 5_000_000;

/**
 * Open daemon.log for appending, as the stdout/stderr of a daemon about to
 * start. A log past maxBytes is first rotated to `<file>.1`, so restarts and
 * lost start races cannot grow it without bound.
 */
export function openDaemonLog(file = DAEMON_LOG_FILE, maxBytes = DAEMON_LOG_MAX_BYTES): number {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    if (fs.statSync(file).size > maxBytes) fs.renameSync(file, `${file}.1`);
  } catch { /* no log yet, or another client rotated it first */ }
  return fs.openSync(file, 'a', 0o600);
}

/** Auth token file (3.1): both IPC clients and the extension must present it. */
export const TOKEN_FILE = path.join(STATE_DIR, 'token.json');

/**
 * Enrollment secret file. A one-time out-of-band secret the legitimate
 * extension uses to authenticate signed daemon challenges and WebSocket
 * hellos. The secret itself is never sent over HTTP or WebSocket. It is
 * delivered to the user via MCP-client terminal output and entered in the
 * popup, or returned by the Chrome-gated native pairing host.
 */
export const ENROLLMENT_FILE = path.join(STATE_DIR, 'enrollment.json');

// --- IPC / WS protocol message shapes --------------------------------------

export type IpcClientMessage =
  | { kind: 'hello'; token: string; agentName?: string; protocolVersion?: number; capabilities?: string[] }
  | { kind: 'call'; id: string; tool: string; params: Record<string, unknown> }
  | { kind: 'pong' }; // heartbeat reply — daemon evicts a silent client after 3 missed pings

export type IpcDaemonMessage =
  | { kind: 'welcome'; sessionId: string; ok: true; protocolVersion: number; capabilities: readonly string[] }
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
// included browser_logs (which mutates on clear:true — M2).

// --- Auth token (task 3.1) -------------------------------------------------

export interface StoredToken {
  token: string;
  createdAt: number;
}

/**
 * Reads the existing `{ [field]: secret, createdAt }` file, or creates the state
 * dir and the file on first run. A missing or unreadable file behaves as absent,
 * so a corrupt file is regenerated rather than blocking the daemon.
 *
 * Shared by the auth token and the enrollment secret: both are 24 random bytes
 * rendered as hex, written 0600 inside a 0700 dir, and read back by one field.
 */
function loadOrCreateSecret<T extends { createdAt: number }>(file: string, field: keyof T & string): T {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    const value = parsed[field];
    if (value && typeof value === 'string') return parsed as unknown as T;
  } catch {
    // missing or invalid — fall through to create
  }
  const created = { [field]: crypto.randomBytes(24).toString('hex'), createdAt: Date.now() };
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(created, null, 2), { mode: 0o600 });
  return created as unknown as T;
}

/** Reads one field of that file without creating it (null when absent). */
function readSecret(file: string, field: string): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    return (parsed[field] as string | undefined) ?? null;
  } catch {
    return null;
  }
}

/** Reads the existing token, or creates the state dir + token on first run. */
export function loadOrCreateToken(): StoredToken {
  return loadOrCreateSecret<StoredToken>(TOKEN_FILE, 'token');
}

/** Reads the token without creating one (returns null if absent). */
export function readToken(): string | null {
  return readSecret(TOKEN_FILE, 'token');
}

// --- Enrollment secret (closes first-contact TOFU race) --------------------

export interface StoredEnrollment {
  secret: string;
  createdAt: number;
}

/**
 * Reads the existing enrollment secret, or creates one on first run. The
 * secret is stable across daemon restarts (persisted to enrollment.json), so
 * the user pairs once and the popup keeps working after reboots. Rotate it
 * with `npm run pairing:rotate` (scripts/pairing.mjs) and restart the daemon.
 *
 * Use readEnrollmentSecret() to peek without creating (e.g. index.ts decides
 * whether to print the "first run — here is your secret" banner).
 */
export function loadOrCreateEnrollment(): StoredEnrollment {
  return loadOrCreateSecret<StoredEnrollment>(ENROLLMENT_FILE, 'secret');
}

/** Reads the enrollment secret without creating one (returns null if absent). */
export function readEnrollmentSecret(): string | null {
  return readSecret(ENROLLMENT_FILE, 'secret');
}
