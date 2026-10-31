import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFile } from './atomic-file.js';
import { isRecord } from '../core/guards.js';
import { ERROR_CODES } from '../core/error-codes.js';

export const POLICY_SCHEMA_VERSION = 1;
export const MAX_EXCLUDED_ORIGINS = 5_000;
const MAX_POLICY_BYTES = 4 * 1024 * 1024;
const EPOCH = '1970-01-01T00:00:00.000Z';
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;

export type MemoryPolicyErrorCode =
  | typeof ERROR_CODES.MEMORY_CORRUPT
  | typeof ERROR_CODES.MEMORY_FULL
  | typeof ERROR_CODES.MEMORY_UNAVAILABLE
  | typeof ERROR_CODES.INVALID_ARGUMENT;

export class MemoryPolicyError extends Error {
  readonly code: MemoryPolicyErrorCode;

  constructor(code: MemoryPolicyErrorCode, message: string) {
    super(message);
    this.name = 'MemoryPolicyError';
    this.code = code;
  }
}

/** `memory/policy.json`. Absent or missing fields mean disabled (FR-004). */
export interface MemoryPolicy {
  schemaVersion: 1;
  enabled: boolean;
  /** Set on each disabled → enabled transition; captures enqueued before it never commit (AC-06). */
  enabledAt: string | null;
  /** Canonical origins, unique, at most MAX_EXCLUDED_ORIGINS. */
  excluded: string[];
  /** Tombstones: origin or "*" (delete all) → deletion time. */
  deletions: Record<string, string>;
  updatedAt: string;
}

export function policyPath(memoryDir: string): string {
  return path.join(memoryDir, 'policy.json');
}

/** `URL.origin` of an http(s) URL; null for any other scheme or an unparsable value. */
export function canonicalOrigin(value: string): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

export function defaultPolicy(): MemoryPolicy {
  return { schemaVersion: POLICY_SCHEMA_VERSION, enabled: false, enabledAt: null, excluded: [], deletions: {}, updatedAt: EPOCH };
}

type Mode = 'read' | 'write';

function invalid(mode: Mode, message: string): MemoryPolicyError {
  return new MemoryPolicyError(mode === 'read' ? ERROR_CODES.MEMORY_CORRUPT : ERROR_CODES.INVALID_ARGUMENT, message);
}

function isTime(value: unknown): value is string {
  return typeof value === 'string' && ISO_UTC.test(value) && Number.isFinite(Date.parse(value));
}

/** Strict validation: a safety control that cannot be understood must not be silently relaxed. */
function validatePolicy(raw: unknown, mode: Mode): MemoryPolicy {
  if (!isRecord(raw)) throw invalid(mode, 'policy is not an object');
  if (raw.schemaVersion !== POLICY_SCHEMA_VERSION) throw invalid(mode, 'unknown policy schemaVersion');

  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') throw invalid(mode, 'policy.enabled is not a boolean');
  const enabledAt = raw.enabledAt ?? null;
  if (enabledAt !== null && !isTime(enabledAt)) throw invalid(mode, 'policy.enabledAt is not a UTC time');
  const updatedAt = raw.updatedAt ?? EPOCH;
  if (!isTime(updatedAt)) throw invalid(mode, 'policy.updatedAt is not a UTC time');

  const excludedRaw = raw.excluded ?? [];
  if (!Array.isArray(excludedRaw)) throw invalid(mode, 'policy.excluded is not an array');
  if (excludedRaw.length > MAX_EXCLUDED_ORIGINS) {
    throw new MemoryPolicyError(mode === 'read' ? ERROR_CODES.MEMORY_CORRUPT : ERROR_CODES.MEMORY_FULL, `policy.excluded exceeds ${MAX_EXCLUDED_ORIGINS} origins`);
  }
  const seen = new Set<string>();
  for (const entry of excludedRaw) {
    if (typeof entry !== 'string' || canonicalOrigin(entry) !== entry) throw invalid(mode, 'policy.excluded holds a non-canonical origin');
    if (seen.has(entry)) throw invalid(mode, 'policy.excluded holds a duplicate origin');
    seen.add(entry);
  }

  const deletionsRaw = raw.deletions ?? {};
  if (!isRecord(deletionsRaw)) throw invalid(mode, 'policy.deletions is not an object');
  const deletions: Record<string, string> = {};
  for (const [key, time] of Object.entries(deletionsRaw)) {
    if (key !== '*' && canonicalOrigin(key) !== key) throw invalid(mode, 'policy.deletions holds a non-canonical origin');
    if (!isTime(time)) throw invalid(mode, 'policy.deletions holds a non-UTC time');
    deletions[key] = time;
  }

  return {
    schemaVersion: POLICY_SCHEMA_VERSION,
    enabled: raw.enabled === true,
    enabledAt,
    excluded: [...(excludedRaw as string[])],
    deletions,
    updatedAt,
  };
}

/**
 * Read the policy. A missing file is the disabled default. Unreadable content
 * throws MEMORY_CORRUPT (callers treat memory as unavailable and capture
 * nothing); an I/O failure other than "missing" throws MEMORY_UNAVAILABLE.
 */
export function readPolicy(memoryDir: string): MemoryPolicy {
  const file = policyPath(memoryDir);
  let fd: number;
  try {
    // O_NOFOLLOW refuses a symlink; O_NONBLOCK keeps a FIFO from blocking the daemon at open.
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultPolicy();
    throw new MemoryPolicyError(ERROR_CODES.MEMORY_UNAVAILABLE, 'policy file could not be read');
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new MemoryPolicyError(ERROR_CODES.MEMORY_UNAVAILABLE, 'policy file is not a regular file');
    if (process.platform !== 'win32') {
      const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
      if (uid !== undefined && st.uid !== uid) throw new MemoryPolicyError(ERROR_CODES.MEMORY_UNAVAILABLE, 'policy file is owned by another user');
      if ((st.mode & 0o022) !== 0) throw new MemoryPolicyError(ERROR_CODES.MEMORY_UNAVAILABLE, 'policy file can be written by other users');
    }
    if (st.size > MAX_POLICY_BYTES) throw new MemoryPolicyError(ERROR_CODES.MEMORY_CORRUPT, 'policy file is too large');
    // Replacing the file (as writePolicy does) changes its inode and times, so the cache never serves a stale policy.
    const key = `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
    const hit = policyCache.get(file);
    if (hit && hit.key === key) return structuredClone(hit.policy);
    let text: string;
    try {
      text = fs.readFileSync(fd, 'utf8');
    } catch {
      throw new MemoryPolicyError(ERROR_CODES.MEMORY_UNAVAILABLE, 'policy file could not be read');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new MemoryPolicyError(ERROR_CODES.MEMORY_CORRUPT, 'policy file is not valid JSON');
    }
    const policy = validatePolicy(parsed, 'read');
    policyCache.set(file, { key, policy: structuredClone(policy) });
    return policy;
  } finally {
    fs.closeSync(fd);
  }
}

const policyCache = new Map<string, { key: string; policy: MemoryPolicy }>();

function requireOrigin(value: string): string {
  const origin = canonicalOrigin(value);
  if (!origin) throw new MemoryPolicyError(ERROR_CODES.INVALID_ARGUMENT, 'origin must be an http or https origin');
  return origin;
}

export function enablePolicy(policy: MemoryPolicy, now: string): MemoryPolicy {
  return { ...policy, enabled: true, enabledAt: policy.enabled && policy.enabledAt ? policy.enabledAt : now, updatedAt: now };
}

export function disablePolicy(policy: MemoryPolicy, now: string): MemoryPolicy {
  return { ...policy, enabled: false, enabledAt: null, updatedAt: now };
}

export function excludeOrigin(policy: MemoryPolicy, origin: string, now: string): MemoryPolicy {
  const canonical = requireOrigin(origin);
  if (policy.excluded.includes(canonical)) return { ...policy, updatedAt: now };
  if (policy.excluded.length >= MAX_EXCLUDED_ORIGINS) {
    throw new MemoryPolicyError(ERROR_CODES.MEMORY_FULL, `at most ${MAX_EXCLUDED_ORIGINS} origins can be excluded`);
  }
  return { ...policy, excluded: [...policy.excluded, canonical], updatedAt: now };
}

export function includeOrigin(policy: MemoryPolicy, origin: string, now: string): MemoryPolicy {
  const canonical = requireOrigin(origin);
  return { ...policy, excluded: policy.excluded.filter((entry) => entry !== canonical), updatedAt: now };
}

/** Record a deletion tombstone for one origin, or for everything with "*". The newest time wins. */
export function recordDeletion(policy: MemoryPolicy, origin: string, now: string): MemoryPolicy {
  const key = origin === '*' ? '*' : requireOrigin(origin);
  const previous = policy.deletions[key];
  const time = previous !== undefined && Date.parse(previous) > Date.parse(now) ? previous : now;
  return { ...policy, deletions: { ...policy.deletions, [key]: time }, updatedAt: now };
}

/**
 * Drop tombstones older than `drainedThrough`, once the queue has drained past them. A tombstone from the drain's own
 * millisecond stays: an operation enqueued in that millisecond is still covered by it (`queuedAt <= deletedAt`).
 * Returns the same object when nothing is pruned.
 */
export function pruneDeletions(policy: MemoryPolicy, drainedThrough: string, now: string): MemoryPolicy {
  const limit = Date.parse(drainedThrough);
  const keep = Object.entries(policy.deletions).filter(([, time]) => Date.parse(time) >= limit);
  if (keep.length === Object.keys(policy.deletions).length) return policy;
  return { ...policy, deletions: Object.fromEntries(keep), updatedAt: now };
}

export interface WritePolicyOptions {
  platform?: NodeJS.Platform;
  rename?: (from: string, to: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Replace policy.json atomically: temp (0o600) → fsync → rename → directory
 * fsync. The directory is created 0o700. A failure leaves the previous file
 * and no temp file behind.
 */
export async function writePolicy(memoryDir: string, policy: MemoryPolicy, options: WritePolicyOptions = {}): Promise<void> {
  const data = `${JSON.stringify(validatePolicy(policy, 'write'), null, 2)}\n`;
  try {
    await atomicWriteFile(memoryDir, 'policy.json', data, options);
  } catch {
    throw new MemoryPolicyError(ERROR_CODES.MEMORY_UNAVAILABLE, 'policy file could not be written');
  }
}

const QUARANTINED_POLICY = /^policy\.json\.corrupt-\d+$/u;

/**
 * Set an unreadable policy aside as `policy.json.corrupt-<ts>` so the owner can reset memory. Only the reset
 * commands (`disable`, `delete`) call this; afterwards the policy reads as the disabled default.
 */
export function quarantinePolicy(memoryDir: string, now: number): void {
  try {
    fs.renameSync(policyPath(memoryDir), path.join(memoryDir, `policy.json.corrupt-${now}`));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new MemoryPolicyError(ERROR_CODES.MEMORY_UNAVAILABLE, 'policy file could not be set aside');
  }
}

/** How many unreadable policy files have been set aside. */
export function countQuarantinedPolicies(memoryDir: string): number {
  try {
    return fs.readdirSync(memoryDir).filter((name) => QUARANTINED_POLICY.test(name)).length;
  } catch {
    return 0;
  }
}
