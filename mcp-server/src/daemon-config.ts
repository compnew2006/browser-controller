import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ipcAnswers } from './ipc-probe.js';
import { pidAlive, reclaimLock, type LockIdentity, type ReclaimHooks } from './lock-file.js';
import { ERROR_CODES, formatError } from './core/error-codes.js';

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

/**
 * Remove daemon.lock only when it is demonstrably stale, by the same judgement the daemon uses
 * to start (live pid, startup grace, IPC probe). Used by `scripts/daemon.mjs stop`.
 *  - 'absent': there was no lock.
 *  - 'held': a live or still-starting daemon holds it, or a fresh lock replaced the stale one.
 *  - 'reclaimed': the stale lock was removed.
 */
export async function reclaimStaleDaemonLock(): Promise<'reclaimed' | 'held' | 'absent'> {
  const { holder, judged } = await inspectDaemonLock();
  if (!judged) return 'absent';
  if (holder !== null) return 'held';
  return reclaimLock(DAEMON_LOCK_FILE, judged, daemonLockReclaimHooks) ? 'reclaimed' : 'held';
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

export const MEMORY_ADMIN_COMMANDS = ['status', 'enable', 'disable', 'exclude', 'include', 'inspect', 'export', 'delete', 'map'] as const;
export type MemoryAdminCommand = (typeof MEMORY_ADMIN_COMMANDS)[number];
export const MAP_ADMIN_COMMANDS = ['status', 'enable', 'disable', 'exclude-path', 'include-path', 'inspect', 'export', 'delete'] as const;
export type MapAdminCommand = (typeof MAP_ADMIN_COMMANDS)[number];

/** The `map` sub-command (specs/004-site-navigation-map/contracts/map-policy-actions.schema.json). */
export interface MapAdminRequest {
  command: MapAdminCommand;
  /** browserId; required for enable and disable. */
  browser?: string;
  origin?: string;
  path?: string;
  all?: boolean;
}

/** Owner CLI -> daemon, after the token hello. Shape: contracts/memory-admin-ipc.schema.json. */
export interface MemoryAdminRequest {
  kind: 'memory-admin';
  id: string;
  command: MemoryAdminCommand;
  origin?: string;
  all?: boolean;
  /** Only with command `map`. */
  map?: MapAdminRequest;
}

/** Per-profile `map status`: counts and dates only, never origins, paths, titles or names. */
export interface MapAdminProfileStatus {
  enabled: boolean;
  files: number;
  bytes: number;
  oldestEntryDate: string | null;
  quarantined: number;
  dropped: number;
  counters: Record<string, number | string> | null;
}

export interface MemoryAdminStatus {
  enabled: boolean;
  origins: number;
  bytes: number;
  queueDepth: number;
  dropped: Record<string, number>;
  lastError: { code: string; at: string } | null;
  quarantined: number;
}

export interface MemoryAdminResult {
  kind: 'memory-admin-result';
  id: string;
  success: boolean;
  /** `CODE: message` (INVALID_ARGUMENT, MEMORY_UNAVAILABLE, MEMORY_CORRUPT). */
  error?: string;
  status?: Partial<MemoryAdminStatus>;
  /** inspect/export: SiteRecord objects as stored, or MapRecord objects for `map`. Owner-only full view. */
  records?: unknown[];
  /** `map` commands: keyed by browserId. */
  mapStatus?: Record<string, MapAdminProfileStatus>;
  /** `map` commands: the error code when the counters file could not be read; `mapStatus` then shows no counters. */
  mapCountersError?: string;
}

export type IpcClientMessage =
  | { kind: 'hello'; token: string; agentName?: string; protocolVersion?: number; capabilities?: string[] }
  | { kind: 'call'; id: string; tool: string; params: Record<string, unknown>; cid?: string }
  | MemoryAdminRequest
  | { kind: 'pong' }; // heartbeat reply — daemon evicts a silent client after 3 missed pings

export type IpcDaemonMessage =
  | { kind: 'welcome'; sessionId: string; ok: true; protocolVersion: number; capabilities: readonly string[] }
  | { kind: 'denied'; reason: string; ok: false }
  | { kind: 'result'; id: string; cid?: string; success: boolean; result?: unknown; error?: string }
  | MemoryAdminResult
  | { kind: 'status'; connectionState: string; connectedSince: number | null }
  | { kind: 'ping' }; // heartbeat probe — client must reply with { kind: 'pong' }

const MEMORY_ADMIN_ORIGIN = /^https?:\/\/[^/?#\s]+$/;
const MEMORY_ADMIN_ORIGIN_COMMANDS: ReadonlySet<string> = new Set(['exclude', 'include', 'inspect']);

/**
 * Validates an untrusted `memory-admin` line against the contract. Unknown fields are rejected.
 * `origin` is required for exclude/include/inspect, and for delete unless `all` is true; it is
 * refused where it has no meaning. The origin is returned as given: canonicalizing is the store's job.
 */
export function parseMemoryAdminRequest(raw: unknown): { ok: true; request: MemoryAdminRequest } | { ok: false; error: string } {
  const bad = (message: string) => ({ ok: false as const, error: formatError(ERROR_CODES.INVALID_ARGUMENT, message) });
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return bad('memory-admin request must be an object');
  const msg = raw as Record<string, unknown>;
  for (const key of Object.keys(msg)) {
    if (!['kind', 'id', 'command', 'origin', 'all', 'map'].includes(key)) return bad(`unknown field ${key.slice(0, 40)}`);
  }
  if (msg.kind !== 'memory-admin') return bad('kind must be memory-admin');
  if (typeof msg.id !== 'string' || msg.id.length === 0 || msg.id.length > 64) return bad('id must be a string of 1-64 characters');
  const command = MEMORY_ADMIN_COMMANDS.find((candidate) => candidate === msg.command);
  if (!command) return bad('unknown command');
  if (command === 'map' || msg.map !== undefined) {
    if (command !== 'map' || msg.origin !== undefined || msg.all !== undefined) return bad('map takes only its map field');
    const map = parseMapAdminRequest(msg.map);
    return typeof map === 'string' ? bad(map) : { ok: true, request: { kind: 'memory-admin', id: msg.id, command, map } };
  }
  if (msg.all !== undefined && typeof msg.all !== 'boolean') return bad('all must be a boolean');
  if (msg.all === true && command !== 'delete') return bad('all is only valid with delete');
  if (msg.origin !== undefined) {
    if (typeof msg.origin !== 'string' || msg.origin.length > 300 || !MEMORY_ADMIN_ORIGIN.test(msg.origin)) return bad('origin must be an http(s) origin');
    if (!MEMORY_ADMIN_ORIGIN_COMMANDS.has(command) && command !== 'delete') return bad(`origin is not valid with ${command}`);
    if (command === 'delete' && msg.all === true) return bad('delete takes an origin or all, not both');
  } else if (MEMORY_ADMIN_ORIGIN_COMMANDS.has(command) || (command === 'delete' && msg.all !== true)) {
    return bad(`${command} needs an origin${command === 'delete' ? ' or all' : ''}`);
  }
  return {
    ok: true,
    request: {
      kind: 'memory-admin',
      id: msg.id,
      command,
      ...(msg.origin !== undefined ? { origin: msg.origin as string } : {}),
      ...(msg.all !== undefined ? { all: msg.all as boolean } : {}),
    },
  };
}

const MAP_ADMIN_PATH = /^\/[^?#]*$/;
const MAP_ADMIN_FIELDS: Record<MapAdminCommand, { required: readonly string[]; allowed: readonly string[] }> = {
  status: { required: [], allowed: ['browser'] },
  enable: { required: ['browser'], allowed: ['browser'] },
  disable: { required: ['browser'], allowed: ['browser'] },
  'exclude-path': { required: ['origin', 'path'], allowed: ['origin', 'path'] },
  'include-path': { required: ['origin', 'path'], allowed: ['origin', 'path'] },
  inspect: { required: ['origin'], allowed: ['browser', 'origin'] },
  export: { required: [], allowed: ['browser'] },
  delete: { required: [], allowed: ['browser', 'origin', 'path', 'all'] },
};

/** Validates the `map` field; a string is the reason it is invalid. Origins and paths are canonicalized by the service. */
function parseMapAdminRequest(raw: unknown): MapAdminRequest | string {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'map must be an object';
  const map = raw as Record<string, unknown>;
  for (const key of Object.keys(map)) if (!['command', 'browser', 'origin', 'path', 'all'].includes(key)) return `unknown map field ${key.slice(0, 40)}`;
  const command = MAP_ADMIN_COMMANDS.find((candidate) => candidate === map.command);
  if (!command) return 'unknown map command';
  const rule = MAP_ADMIN_FIELDS[command];
  for (const key of Object.keys(map)) if (key !== 'command' && !rule.allowed.includes(key)) return `${key} is not valid with map ${command}`;
  for (const key of rule.required) if (map[key] === undefined) return `map ${command} needs ${key}`;
  if (map.browser !== undefined && (typeof map.browser !== 'string' || map.browser.length === 0 || map.browser.length > 200)) return 'browser must be a browserId';
  if (map.origin !== undefined && (typeof map.origin !== 'string' || map.origin.length > 300 || !MEMORY_ADMIN_ORIGIN.test(map.origin))) return 'origin must be an http(s) origin';
  if (map.path !== undefined && (typeof map.path !== 'string' || map.path.length < 1 || map.path.length > 200 || !MAP_ADMIN_PATH.test(map.path))) return 'path must start with "/" and have no query or fragment';
  if (map.all !== undefined && typeof map.all !== 'boolean') return 'all must be a boolean';
  if (command === 'delete') {
    if (map.all === true && (map.origin !== undefined || map.path !== undefined)) return 'map delete takes an origin or all, not both';
    if (map.all !== true && map.origin === undefined) return 'map delete needs an origin or all';
  }
  return {
    command,
    ...(map.browser !== undefined ? { browser: map.browser as string } : {}),
    ...(map.origin !== undefined ? { origin: map.origin as string } : {}),
    ...(map.path !== undefined ? { path: map.path as string } : {}),
    ...(map.all !== undefined ? { all: map.all as boolean } : {}),
  };
}

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
