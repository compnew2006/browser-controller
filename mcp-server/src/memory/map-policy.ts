/**
 * `memory/map-policy.json` (specs/004-site-navigation-map research R-04, R-05, R-13): the site map is enabled
 * per browser profile, path prefixes are excluded per origin, and deletions leave tombstones so queued work
 * cannot bring entries back. Kept apart from 003's policy.json, whose validation drops unknown keys.
 */
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFile } from './atomic-file.js';
import { MAP_LIMITS } from './map-allowlist.js';
import { canonicalPrefix, pathUnderPrefix, samePath } from './map-text.js';
import { MemoryPolicyError, canonicalOrigin, type MemoryPolicy } from './policy.js';

export const MAP_POLICY_SCHEMA_VERSION = 1;
export const MAX_MAP_PROFILES = 16;
export const MAX_MAP_TOMBSTONES = 1_024;
/** How long a tombstone is kept after the queue drained past it. */
export const MAP_TOMBSTONE_RETENTION_MS = 7 * 24 * 3_600_000;
const MAX_POLICY_BYTES = 1024 * 1024;
const EPOCH = '1970-01-01T00:00:00.000Z';
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;
const FILE = 'map-policy.json';
const QUARANTINED = /^map-policy\.json\.corrupt-\d+$/u;

export interface MapTombstone {
  /** A browserId, or "*" for every profile. */
  profile: string;
  /** A canonical origin, or "*" for every origin. */
  origin: string;
  /** Entries at or under this path (segment boundary): a path exclusion. */
  pathPrefix?: string;
  /** Exactly this page: a page delete (AC-16). Neither field: the whole origin. */
  path?: string;
  at: string;
}

export interface MapPolicy {
  schemaVersion: 1;
  profiles: Record<string, { enabled: boolean; enabledAt: string | null }>;
  excludedPaths: Record<string, string[]>;
  deletions: MapTombstone[];
  updatedAt: string;
}

export function defaultMapPolicy(): MapPolicy {
  return { schemaVersion: MAP_POLICY_SCHEMA_VERSION, profiles: {}, excludedPaths: {}, deletions: [], updatedAt: EPOCH };
}

type Mode = 'read' | 'write';
const invalid = (mode: Mode, message: string): MemoryPolicyError => new MemoryPolicyError(mode === 'read' ? 'MEMORY_CORRUPT' : 'INVALID_ARGUMENT', message);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isTime = (value: unknown): value is string => typeof value === 'string' && ISO_UTC.test(value) && Number.isFinite(Date.parse(value));
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const validProfile = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200 && !UNSAFE_KEYS.has(value);

function validateMapPolicy(raw: unknown, mode: Mode): MapPolicy {
  if (!isRecord(raw)) throw invalid(mode, 'map policy is not an object');
  for (const key of Object.keys(raw)) {
    if (!['schemaVersion', 'profiles', 'excludedPaths', 'deletions', 'updatedAt'].includes(key)) throw invalid(mode, 'map policy has an unknown field');
  }
  if (raw.schemaVersion !== MAP_POLICY_SCHEMA_VERSION) throw invalid(mode, 'unknown map policy schemaVersion');
  if (!isTime(raw.updatedAt)) throw invalid(mode, 'map policy updatedAt is not a UTC time');

  if (!isRecord(raw.profiles)) throw invalid(mode, 'map policy profiles is not an object');
  const profileEntries = Object.entries(raw.profiles);
  if (profileEntries.length > MAX_MAP_PROFILES) throw new MemoryPolicyError(mode === 'read' ? 'MEMORY_CORRUPT' : 'MEMORY_FULL', `at most ${MAX_MAP_PROFILES} profiles`);
  const profiles: MapPolicy['profiles'] = {};
  for (const [id, state] of profileEntries) {
    if (!validProfile(id) || !isRecord(state)) throw invalid(mode, 'map policy holds an invalid profile');
    if (Object.keys(state).some((key) => key !== 'enabled' && key !== 'enabledAt')) throw invalid(mode, 'map policy profile has an unknown field');
    if (typeof state.enabled !== 'boolean' || (state.enabledAt !== null && !isTime(state.enabledAt))) throw invalid(mode, 'map policy profile is invalid');
    profiles[id] = { enabled: state.enabled, enabledAt: state.enabledAt as string | null };
  }

  if (!isRecord(raw.excludedPaths)) throw invalid(mode, 'map policy excludedPaths is not an object');
  const excludedPaths: MapPolicy['excludedPaths'] = {};
  for (const [origin, prefixes] of Object.entries(raw.excludedPaths)) {
    if (canonicalOrigin(origin) !== origin || !Array.isArray(prefixes)) throw invalid(mode, 'map policy excludedPaths is invalid');
    if (prefixes.length > MAP_LIMITS.excludedPrefixesPerOrigin) throw new MemoryPolicyError(mode === 'read' ? 'MEMORY_CORRUPT' : 'MEMORY_FULL', 'too many excluded prefixes');
    const unique = new Set<string>();
    for (const prefix of prefixes) {
      if (canonicalPrefix(prefix) !== prefix || unique.has(prefix)) throw invalid(mode, 'map policy holds an invalid prefix');
      unique.add(prefix);
    }
    excludedPaths[origin] = [...unique];
  }

  if (!Array.isArray(raw.deletions) || raw.deletions.length > MAX_MAP_TOMBSTONES) throw invalid(mode, 'map policy deletions is not a bounded array');
  const deletions: MapTombstone[] = [];
  for (const entry of raw.deletions) {
    if (!isRecord(entry)) throw invalid(mode, 'map tombstone is not an object');
    if (Object.keys(entry).some((key) => !['profile', 'origin', 'pathPrefix', 'path', 'at'].includes(key))) throw invalid(mode, 'map tombstone has an unknown field');
    if (!(entry.profile === '*' || validProfile(entry.profile))) throw invalid(mode, 'map tombstone profile is invalid');
    if (!(entry.origin === '*' || (typeof entry.origin === 'string' && canonicalOrigin(entry.origin) === entry.origin))) throw invalid(mode, 'map tombstone origin is invalid');
    for (const field of [entry.pathPrefix, entry.path]) {
      if (field !== undefined && (typeof field !== 'string' || !field.startsWith('/') || field.length > MAP_LIMITS.pathChars)) throw invalid(mode, 'map tombstone path is invalid');
    }
    if (entry.pathPrefix !== undefined && entry.path !== undefined) throw invalid(mode, 'map tombstone has both a path and a prefix');
    if (!isTime(entry.at)) throw invalid(mode, 'map tombstone time is invalid');
    deletions.push({
      profile: entry.profile as string,
      origin: entry.origin as string,
      ...(entry.pathPrefix !== undefined ? { pathPrefix: entry.pathPrefix as string } : {}),
      ...(entry.path !== undefined ? { path: entry.path as string } : {}),
      at: entry.at,
    });
  }
  return { schemaVersion: MAP_POLICY_SCHEMA_VERSION, profiles, excludedPaths, deletions, updatedAt: raw.updatedAt };
}

const cache = new Map<string, { key: string; policy: MapPolicy }>();

/** Read the map policy. Missing file: the disabled default. Unreadable content: MEMORY_CORRUPT (the map is off). */
export function readMapPolicy(memoryDir: string): MapPolicy {
  const file = path.join(memoryDir, FILE);
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultMapPolicy();
    throw new MemoryPolicyError('MEMORY_UNAVAILABLE', 'map policy file could not be read');
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new MemoryPolicyError('MEMORY_UNAVAILABLE', 'map policy file is not a regular file');
    if (process.platform !== 'win32') {
      const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
      if (uid !== undefined && st.uid !== uid) throw new MemoryPolicyError('MEMORY_UNAVAILABLE', 'map policy file is owned by another user');
      if ((st.mode & 0o022) !== 0) throw new MemoryPolicyError('MEMORY_UNAVAILABLE', 'map policy file can be written by other users');
    }
    if (st.size > MAX_POLICY_BYTES) throw new MemoryPolicyError('MEMORY_CORRUPT', 'map policy file is too large');
    const key = `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
    const hit = cache.get(file);
    if (hit && hit.key === key) return structuredClone(hit.policy);
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(fd, 'utf8'));
    } catch {
      throw new MemoryPolicyError('MEMORY_CORRUPT', 'map policy file is not valid JSON');
    }
    const policy = validateMapPolicy(parsed, 'read');
    cache.set(file, { key, policy: structuredClone(policy) });
    return policy;
  } finally {
    fs.closeSync(fd);
  }
}

export async function writeMapPolicy(memoryDir: string, policy: MapPolicy): Promise<void> {
  const data = `${JSON.stringify(validateMapPolicy(policy, 'write'), null, 2)}\n`;
  try {
    await atomicWriteFile(memoryDir, FILE, data);
  } catch {
    throw new MemoryPolicyError('MEMORY_UNAVAILABLE', 'map policy file could not be written');
  }
}

export function quarantineMapPolicy(memoryDir: string, now: number): void {
  try {
    fs.renameSync(path.join(memoryDir, FILE), path.join(memoryDir, `${FILE}.corrupt-${now}`));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new MemoryPolicyError('MEMORY_UNAVAILABLE', 'map policy file could not be set aside');
  }
}

export function countQuarantinedMapPolicies(memoryDir: string): number {
  try {
    return fs.readdirSync(memoryDir).filter((name) => QUARANTINED.test(name)).length;
  } catch {
    return 0;
  }
}

function requireProfile(profile: string): string {
  if (!validProfile(profile) || profile === 'default') throw new MemoryPolicyError('INVALID_ARGUMENT', 'a verified browser profile is required');
  return profile;
}

function requireOrigin(origin: string): string {
  const canonical = canonicalOrigin(origin);
  if (!canonical) throw new MemoryPolicyError('INVALID_ARGUMENT', 'origin must be an http or https origin');
  return canonical;
}

export function enableMapProfile(policy: MapPolicy, profile: string, now: string): MapPolicy {
  const id = requireProfile(profile);
  const current = policy.profiles[id];
  if (!current && Object.keys(policy.profiles).length >= MAX_MAP_PROFILES) throw new MemoryPolicyError('MEMORY_FULL', `the map can be enabled for at most ${MAX_MAP_PROFILES} profiles`);
  const enabledAt = current?.enabled && current.enabledAt ? current.enabledAt : now;
  return { ...policy, profiles: { ...policy.profiles, [id]: { enabled: true, enabledAt } }, updatedAt: now };
}

/** Disable keeps the profile's entry (and its data on disk) so a later enable or delete still finds it (R-05). */
export function disableMapProfile(policy: MapPolicy, profile: string, now: string): MapPolicy {
  const id = requireProfile(profile);
  if (!policy.profiles[id]) return { ...policy, updatedAt: now };
  return { ...policy, profiles: { ...policy.profiles, [id]: { enabled: false, enabledAt: null } }, updatedAt: now };
}

export function excludeMapPath(policy: MapPolicy, origin: string, prefix: string, now: string): MapPolicy {
  const key = requireOrigin(origin);
  const canonical = canonicalPrefix(prefix);
  if (!canonical) throw new MemoryPolicyError('INVALID_ARGUMENT', 'path must start with "/", must not be "/", and must have no query or fragment');
  const list = policy.excludedPaths[key] ?? [];
  if (list.some((entry) => entry.toLowerCase() === canonical.toLowerCase())) return { ...policy, updatedAt: now };
  if (list.length >= MAP_LIMITS.excludedPrefixesPerOrigin) throw new MemoryPolicyError('MEMORY_FULL', `at most ${MAP_LIMITS.excludedPrefixesPerOrigin} paths can be excluded per site`);
  return { ...policy, excludedPaths: { ...policy.excludedPaths, [key]: [...list, canonical] }, updatedAt: now };
}

export function includeMapPath(policy: MapPolicy, origin: string, prefix: string, now: string): MapPolicy {
  const key = requireOrigin(origin);
  const canonical = canonicalPrefix(prefix);
  if (!canonical) throw new MemoryPolicyError('INVALID_ARGUMENT', 'path must start with "/", must not be "/", and must have no query or fragment');
  const list = (policy.excludedPaths[key] ?? []).filter((entry) => entry.toLowerCase() !== canonical.toLowerCase());
  const excludedPaths = { ...policy.excludedPaths };
  if (list.length) excludedPaths[key] = list;
  else delete excludedPaths[key];
  return { ...policy, excludedPaths, updatedAt: now };
}

/** Record a tombstone; the oldest are dropped past the bound (their work has long been committed or dropped). */
export function addMapTombstone(policy: MapPolicy, tombstone: MapTombstone): MapPolicy {
  const deletions = [...policy.deletions, tombstone].slice(-MAX_MAP_TOMBSTONES);
  return { ...policy, deletions, updatedAt: tombstone.at };
}

/** Delete-all for every profile: the default policy keeps nothing, not even disabled profiles. */
export function forgetMapProfile(policy: MapPolicy, profile: string, now: string): MapPolicy {
  const profiles = { ...policy.profiles };
  delete profiles[profile];
  return { ...policy, profiles, updatedAt: now };
}

/**
 * Drop tombstones the queue has drained past and that are older than the retention. Reads apply tombstones too
 * (MapService.applyPolicy), and every commit rewrites its file through them, so a delete whose rewrite failed is
 * neither served nor kept past the next commit to that file within the retention. A tombstone from the drain's own
 * millisecond stays, as tombstoneBlocks still covers observations from that millisecond.
 */
export function pruneMapTombstones(policy: MapPolicy, drainedThrough: string, now: string): MapPolicy {
  const limit = Math.min(Date.parse(drainedThrough), Date.parse(now) - MAP_TOMBSTONE_RETENTION_MS);
  const keep = policy.deletions.filter((entry) => Date.parse(entry.at) >= limit);
  return keep.length === policy.deletions.length ? policy : { ...policy, deletions: keep, updatedAt: now };
}

/** What a capture is about, for the commit-time checks. Paths are the raw and the stored (masked) forms. */
export interface MapTarget {
  profile: string;
  origin: string;
  rawPath?: string;
  path?: string;
  /** When the observation was made; a newer tombstone drops it. */
  at: string;
}

export type MapVerdict = 'ok' | 'disabled' | 'excluded' | 'deleted';

export function isPathExcluded(policy: MapPolicy, origin: string, ...paths: Array<string | undefined>): boolean {
  const prefixes = policy.excludedPaths[origin] ?? [];
  return prefixes.some((prefix) => paths.some((candidate) => candidate !== undefined && pathUnderPrefix(candidate, prefix)));
}

/** True when a tombstone newer than the observation covers it. */
export function tombstoneBlocks(policy: MapPolicy, target: MapTarget): boolean {
  const at = Date.parse(target.at);
  return policy.deletions.some((entry) => {
    if (Date.parse(entry.at) < at) return false;
    if (entry.profile !== '*' && entry.profile !== target.profile) return false;
    if (entry.origin !== '*' && entry.origin !== target.origin) return false;
    if (entry.path !== undefined) return [target.rawPath, target.path].some((candidate) => candidate !== undefined && samePath(candidate, entry.path as string));
    if (entry.pathPrefix === undefined) return true;
    return [target.rawPath, target.path].some((candidate) => candidate !== undefined && pathUnderPrefix(candidate, entry.pathPrefix as string));
  });
}

/** The whole gate: website memory on, map on for this profile (and since before the observation), site and path not excluded, no newer tombstone. */
export function mapVerdict(memory: MemoryPolicy, map: MapPolicy, target: MapTarget): MapVerdict {
  const state = map.profiles[target.profile];
  if (!memory.enabled || !state?.enabled) return 'disabled';
  if (memory.enabledAt && Date.parse(target.at) < Date.parse(memory.enabledAt)) return 'disabled';
  if (state.enabledAt && Date.parse(target.at) < Date.parse(state.enabledAt)) return 'disabled';
  if (memory.excluded.includes(target.origin)) return 'excluded';
  if (isPathExcluded(map, target.origin, target.rawPath, target.path)) return 'excluded';
  // 003's site delete and delete-all both apply; either one newer than the observation drops it.
  for (const memoryTombstone of [memory.deletions[target.origin], memory.deletions['*']]) {
    if (memoryTombstone && Date.parse(memoryTombstone) >= Date.parse(target.at)) return 'deleted';
  }
  if (tombstoneBlocks(map, target)) return 'deleted';
  return 'ok';
}
