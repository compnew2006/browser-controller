import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { AtomicWriteAborted, atomicWriteFile, type AtomicWriteOptions } from './atomic-file.js';
import {
  ALLOWLIST,
  matchControlName,
  matchPath,
  matchSearchName,
  primaryLanguage,
  type FactKind,
  type FactValue,
} from './allowlist.js';
import { canonicalOrigin } from './policy.js';

export const SITE_SCHEMA_VERSION = 1;
export const MAX_FACTS = 64;
export const MAX_PROFILES = 16;
export const MAX_VERIFICATIONS = 64;
export const MAX_SITE_BYTES = 64 * 1024;
export const MAX_ORIGINS = 5_000;
export const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_FACT_ID = 120;
const MAX_PATH = 120;
const DEFAULT_CACHE_ENTRIES = 512;
const SITE_FILE = /^[0-9a-f]{64}\.json$/u;
const QUARANTINED_FILE = /^([0-9a-f]{64}\.json)\.corrupt-\d+$/u;
const FACT_ID = /^(?:site\.language|ui\.search|ui\.login|ui\.control:[a-z]+:.+)$/u;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;
const FACT_KINDS: readonly string[] = ['site.language', 'ui.search', 'ui.login', 'ui.control'];
const TOOLS: readonly string[] = ['browser_snapshot', 'browser_navigate'];
const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

export type MemoryStoreErrorCode = 'MEMORY_CORRUPT' | 'MEMORY_FULL' | 'MEMORY_UNAVAILABLE' | 'INVALID_ARGUMENT';

export class MemoryStoreError extends Error {
  readonly code: MemoryStoreErrorCode;

  constructor(code: MemoryStoreErrorCode, message: string) {
    super(message);
    this.name = 'MemoryStoreError';
    this.code = code;
  }
}

export interface SiteFact {
  factId: string;
  kind: FactKind;
  value: FactValue;
  firstObserved: string;
  lastObserved: string;
  status: 'current';
}

export interface ProfileVisit {
  firstAt: string;
  lastAt: string;
  count: number;
}

export interface ProfileVerification {
  at: string;
  tool: 'browser_snapshot' | 'browser_navigate';
  path: string;
}

export interface ProfileSiteState {
  visit?: ProfileVisit | null;
  verifications?: Record<string, ProfileVerification>;
}

/** `memory/sites/<sha256(origin)>.json`. */
export interface SiteRecord {
  schemaVersion: 1;
  origin: string;
  facts: SiteFact[];
  profiles: Record<string, ProfileSiteState>;
  commitSeq: number;
  updatedAt: string;
}

export interface PutSiteOptions {
  /** Aborting before the rename discards the write and removes its temp file. */
  signal?: AbortSignal;
}

export interface MemoryStoreStatus {
  origins: number;
  totalBytes: number;
  /** Files set aside as `<name>.corrupt-<ts>`. Their origins start empty. */
  corrupt: Array<{ file: string; quarantinedAs: string }>;
}

/** What the queue and service need from any backing store. */
export interface MemoryStore {
  getSite(origin: string): Promise<SiteRecord | null>;
  putSite(record: SiteRecord, options?: PutSiteOptions): Promise<void>;
  deleteSite(origin: string): Promise<boolean>;
  deleteAll(): Promise<number>;
  listSites(): Promise<SiteRecord[]>;
  status(): Promise<MemoryStoreStatus>;
}

export interface StoreLimits {
  maxOrigins?: number;
  maxTotalBytes?: number;
}

export interface JsonMemoryStoreOptions extends Pick<AtomicWriteOptions, 'platform' | 'rename' | 'sleep' | 'afterTempWrite'> {
  /** Only names quarantined files; stored times always come from the caller. */
  now?: () => number;
  limits?: StoreLimits;
  cacheEntries?: number;
}

export function siteFileName(origin: string): string {
  return `${crypto.createHash('sha256').update(origin).digest('hex')}.json`;
}

type Mode = 'read' | 'write';

function bad(mode: Mode, message: string): MemoryStoreError {
  return new MemoryStoreError(mode === 'read' ? 'MEMORY_CORRUPT' : 'INVALID_ARGUMENT', message);
}

function full(mode: Mode, message: string): MemoryStoreError {
  return new MemoryStoreError(mode === 'read' ? 'MEMORY_CORRUPT' : 'MEMORY_FULL', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTime(value: unknown): value is string {
  return typeof value === 'string' && ISO_UTC.test(value) && Number.isFinite(Date.parse(value));
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], mode: Mode, label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw bad(mode, `${label} has an unknown field`);
  }
}

function validateFactValue(fact: SiteFact, mode: Mode): void {
  const value = fact.value as unknown;
  if (!isRecord(value) || Object.keys(value).length > 2) throw bad(mode, 'fact.value is not a small object');
  if (mode === 'read') return;
  // Write-time defence in depth: a stored string must equal an allowlist entry.
  const strict = (ok: boolean): void => {
    if (!ok) throw bad(mode, `fact ${fact.kind} holds a value outside the allowlist`);
  };
  switch (fact.kind) {
    case 'site.language':
      onlyKeys(value, ['lang', 'dir'], mode, 'site.language');
      strict(fact.factId === 'site.language' && typeof value.lang === 'string' && primaryLanguage(value.lang) === value.lang);
      strict(value.dir === 'ltr' || value.dir === 'rtl' || value.dir === null);
      return;
    case 'ui.search':
      onlyKeys(value, ['role', 'name'], mode, 'ui.search');
      strict(fact.factId === 'ui.search' && (ALLOWLIST.searchRoles as readonly string[]).includes(value.role as string));
      strict(typeof value.name === 'string' && matchSearchName(value.name) === value.name);
      return;
    case 'ui.login':
      onlyKeys(value, ['path'], mode, 'ui.login');
      strict(fact.factId === 'ui.login');
      strict(value.path === null || (typeof value.path === 'string' && matchPath(value.path) === value.path));
      return;
    case 'ui.control':
      onlyKeys(value, ['role', 'name'], mode, 'ui.control');
      strict((ALLOWLIST.controlRoles as readonly string[]).includes(value.role as string));
      strict(typeof value.name === 'string' && matchControlName(value.name) === value.name);
      strict(fact.factId === `ui.control:${String(value.role)}:${String(value.name)}`);
      return;
    default:
      throw bad(mode, 'unknown fact kind');
  }
}

function validateFact(raw: unknown, mode: Mode): SiteFact {
  if (!isRecord(raw)) throw bad(mode, 'fact is not an object');
  onlyKeys(raw, ['factId', 'kind', 'value', 'firstObserved', 'lastObserved', 'status'], mode, 'fact');
  const { factId, kind } = raw;
  if (typeof factId !== 'string' || factId.length > MAX_FACT_ID || !FACT_ID.test(factId)) throw bad(mode, 'fact.factId is invalid');
  if (typeof kind !== 'string' || !FACT_KINDS.includes(kind)) throw bad(mode, 'fact.kind is invalid');
  if (factId !== kind && !factId.startsWith(`${kind}:`)) throw bad(mode, 'fact.factId does not match fact.kind');
  if (!isTime(raw.firstObserved) || !isTime(raw.lastObserved)) throw bad(mode, 'fact times are not UTC times');
  if (raw.status !== 'current') throw bad(mode, 'fact.status is not current');
  const fact: SiteFact = {
    factId,
    kind: kind as FactKind,
    value: raw.value as FactValue,
    firstObserved: raw.firstObserved,
    lastObserved: raw.lastObserved,
    status: 'current',
  };
  validateFactValue(fact, mode);
  return fact;
}

function validateProfile(raw: unknown, mode: Mode): ProfileSiteState {
  if (!isRecord(raw)) throw bad(mode, 'profile state is not an object');
  onlyKeys(raw, ['visit', 'verifications'], mode, 'profile state');
  const state: ProfileSiteState = {};
  if (raw.visit !== undefined) {
    if (raw.visit === null) {
      state.visit = null;
    } else {
      const visit = raw.visit;
      if (!isRecord(visit)) throw bad(mode, 'profile.visit is not an object');
      onlyKeys(visit, ['firstAt', 'lastAt', 'count'], mode, 'profile.visit');
      if (!isTime(visit.firstAt) || !isTime(visit.lastAt)) throw bad(mode, 'profile.visit times are not UTC times');
      if (!Number.isInteger(visit.count) || (visit.count as number) < 1) throw bad(mode, 'profile.visit.count is invalid');
      state.visit = { firstAt: visit.firstAt, lastAt: visit.lastAt, count: visit.count as number };
    }
  }
  if (raw.verifications !== undefined) {
    if (!isRecord(raw.verifications)) throw bad(mode, 'profile.verifications is not an object');
    const entries = Object.entries(raw.verifications);
    if (entries.length > MAX_VERIFICATIONS) throw full(mode, `a profile holds at most ${MAX_VERIFICATIONS} verifications`);
    const verifications: Record<string, ProfileVerification> = {};
    for (const [key, entry] of entries) {
      if (UNSAFE_KEYS.has(key) || key.length > MAX_FACT_ID || !FACT_ID.test(key)) throw bad(mode, 'verification key is not a fact id');
      if (!isRecord(entry)) throw bad(mode, 'verification is not an object');
      onlyKeys(entry, ['at', 'tool', 'path'], mode, 'verification');
      if (!isTime(entry.at)) throw bad(mode, 'verification.at is not a UTC time');
      if (typeof entry.tool !== 'string' || !TOOLS.includes(entry.tool)) throw bad(mode, 'verification.tool is invalid');
      if (typeof entry.path !== 'string' || entry.path.length > MAX_PATH || !/^\/[^?#]*$/u.test(entry.path)) {
        throw bad(mode, 'verification.path is invalid');
      }
      verifications[key] = { at: entry.at, tool: entry.tool as ProfileVerification['tool'], path: entry.path };
    }
    state.verifications = verifications;
  }
  return state;
}

/** Validate and copy a record. `read` failures are MEMORY_CORRUPT; `write` failures are INVALID_ARGUMENT or MEMORY_FULL. */
export function validateSiteRecord(raw: unknown, mode: Mode): SiteRecord {
  if (!isRecord(raw)) throw bad(mode, 'site record is not an object');
  if (raw.schemaVersion !== SITE_SCHEMA_VERSION) throw bad(mode, 'unknown site schemaVersion');
  onlyKeys(raw, ['schemaVersion', 'origin', 'facts', 'profiles', 'commitSeq', 'updatedAt'], mode, 'site record');
  if (typeof raw.origin !== 'string' || raw.origin.length > 300 || canonicalOrigin(raw.origin) !== raw.origin) {
    throw bad(mode, 'site.origin is not a canonical http(s) origin');
  }
  if (!Number.isInteger(raw.commitSeq) || (raw.commitSeq as number) < 1) throw bad(mode, 'site.commitSeq is invalid');
  if (!isTime(raw.updatedAt)) throw bad(mode, 'site.updatedAt is not a UTC time');
  if (!Array.isArray(raw.facts)) throw bad(mode, 'site.facts is not an array');
  if (!isRecord(raw.profiles)) throw bad(mode, 'site.profiles is not an object');
  if (raw.facts.length > MAX_FACTS) throw full(mode, `a site holds at most ${MAX_FACTS} facts`);
  const profileEntries = Object.entries(raw.profiles);
  if (profileEntries.length > MAX_PROFILES) throw full(mode, `a site holds at most ${MAX_PROFILES} profiles`);

  const facts = raw.facts.map((fact) => validateFact(fact, mode));
  if (new Set(facts.map((fact) => fact.factId)).size !== facts.length) throw bad(mode, 'site.facts holds a duplicate factId');
  const profiles: Record<string, ProfileSiteState> = {};
  for (const [id, state] of profileEntries) {
    if (UNSAFE_KEYS.has(id) || id === '' || id.length > 200) throw bad(mode, 'profile id is invalid');
    profiles[id] = validateProfile(state, mode);
  }
  return { schemaVersion: SITE_SCHEMA_VERSION, origin: raw.origin, facts, profiles, commitSeq: raw.commitSeq as number, updatedAt: raw.updatedAt };
}

function requireOrigin(origin: string): string {
  const canonical = typeof origin === 'string' ? canonicalOrigin(origin) : null;
  if (!canonical || canonical !== origin) throw new MemoryStoreError('INVALID_ARGUMENT', 'origin must be a canonical http or https origin');
  return canonical;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

interface Usage {
  sizes: Map<string, number>;
  bytes: number;
}

/**
 * The default store: one atomically replaced JSON file per origin under
 * `<memoryDir>/sites/`, named after sha256(origin). One writer: all
 * mutations run through a single promise chain. Reads see only committed
 * state; the cache changes after the rename, never before. Local files only.
 */
export class JsonMemoryStore implements MemoryStore {
  readonly sitesDir: string;
  private readonly memoryDir: string;
  private readonly options: JsonMemoryStoreOptions;
  private readonly platform: NodeJS.Platform;
  private readonly maxOrigins: number;
  private readonly maxTotalBytes: number;
  private readonly cacheEntries: number;
  private readonly cache = new Map<string, SiteRecord>();
  private writeTail: Promise<void> = Promise.resolve();
  private readyPromise: Promise<void> | null = null;
  private usage: Usage | null = null;

  constructor(memoryDir: string, options: JsonMemoryStoreOptions = {}) {
    this.memoryDir = path.resolve(memoryDir);
    this.sitesDir = path.join(this.memoryDir, 'sites');
    this.options = options;
    this.platform = options.platform ?? process.platform;
    this.maxOrigins = options.limits?.maxOrigins ?? MAX_ORIGINS;
    this.maxTotalBytes = options.limits?.maxTotalBytes ?? MAX_TOTAL_BYTES;
    this.cacheEntries = options.cacheEntries ?? DEFAULT_CACHE_ENTRIES;
  }

  async getSite(origin: string): Promise<SiteRecord | null> {
    requireOrigin(origin);
    await this.ready();
    const cached = this.cache.get(origin);
    if (cached) {
      this.remember(origin, cached);
      return structuredClone(cached);
    }
    const record = await this.readSiteFile(siteFileName(origin));
    if (!record) return null;
    this.remember(origin, record);
    return structuredClone(record);
  }

  putSite(record: SiteRecord, options: PutSiteOptions = {}): Promise<void> {
    return this.serialize(async () => {
      const valid = validateSiteRecord(record, 'write');
      await this.ready();
      if (options.signal?.aborted) throw new MemoryStoreError('MEMORY_UNAVAILABLE', 'write abandoned before it started');
      const data = `${JSON.stringify(valid)}\n`;
      const bytes = Buffer.byteLength(data);
      if (bytes > MAX_SITE_BYTES) throw new MemoryStoreError('MEMORY_FULL', `a site file is limited to ${MAX_SITE_BYTES} bytes`);
      const fileName = siteFileName(valid.origin);
      const usage = await this.loadUsage();
      const previous = usage.sizes.get(fileName);
      if (previous === undefined && usage.sizes.size >= this.maxOrigins) {
        throw new MemoryStoreError('MEMORY_FULL', `at most ${this.maxOrigins} origins can be stored`);
      }
      if (usage.bytes - (previous ?? 0) + bytes > this.maxTotalBytes) {
        throw new MemoryStoreError('MEMORY_FULL', 'the total size limit for stored memory was reached');
      }
      try {
        await atomicWriteFile(this.sitesDir, fileName, data, {
          platform: this.options.platform,
          rename: this.options.rename,
          sleep: this.options.sleep,
          afterTempWrite: this.options.afterTempWrite,
          signal: options.signal,
        });
      } catch (error) {
        if (error instanceof AtomicWriteAborted) throw new MemoryStoreError('MEMORY_UNAVAILABLE', 'write abandoned before the rename');
        const code = errorCode(error);
        if (code === 'ENOSPC' || code === 'EDQUOT') throw new MemoryStoreError('MEMORY_FULL', 'no space left for memory');
        throw new MemoryStoreError('MEMORY_UNAVAILABLE', 'site file could not be written');
      }
      usage.bytes += bytes - (previous ?? 0);
      usage.sizes.set(fileName, bytes);
      this.remember(valid.origin, structuredClone(valid));
    });
  }

  deleteSite(origin: string): Promise<boolean> {
    return this.serialize(async () => {
      requireOrigin(origin);
      await this.ready();
      const fileName = siteFileName(origin);
      let removed = false;
      try {
        await fsp.unlink(path.join(this.sitesDir, fileName));
        removed = true;
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw new MemoryStoreError('MEMORY_UNAVAILABLE', 'site file could not be deleted');
      }
      for (const name of await this.listDir()) {
        if (name.startsWith(`${fileName}.corrupt-`)) await fsp.rm(path.join(this.sitesDir, name), { force: true });
      }
      this.cache.delete(origin);
      if (this.usage) {
        this.usage.bytes -= this.usage.sizes.get(fileName) ?? 0;
        this.usage.sizes.delete(fileName);
      }
      return removed;
    });
  }

  deleteAll(): Promise<number> {
    return this.serialize(async () => {
      await this.ready();
      let removed = 0;
      for (const name of await this.listDir()) {
        const isSite = SITE_FILE.test(name);
        if (!isSite && !QUARANTINED_FILE.test(name)) continue;
        try {
          await fsp.unlink(path.join(this.sitesDir, name));
          if (isSite) removed += 1;
        } catch (error) {
          if (errorCode(error) !== 'ENOENT') throw new MemoryStoreError('MEMORY_UNAVAILABLE', 'site file could not be deleted');
        }
      }
      this.cache.clear();
      this.usage = { sizes: new Map(), bytes: 0 };
      return removed;
    });
  }

  async listSites(): Promise<SiteRecord[]> {
    await this.ready();
    const sites: SiteRecord[] = [];
    for (const name of (await this.listDir()).filter((entry) => SITE_FILE.test(entry)).sort()) {
      try {
        const record = await this.readSiteFile(name);
        if (record) sites.push(record);
      } catch (error) {
        if (error instanceof MemoryStoreError && error.code === 'MEMORY_CORRUPT') continue;
        throw error;
      }
    }
    return sites;
  }

  async status(): Promise<MemoryStoreStatus> {
    await this.ready();
    const usage = await this.loadUsage();
    const corrupt = (await this.listDir())
      .sort()
      .flatMap((name) => {
        const match = QUARANTINED_FILE.exec(name);
        return match ? [{ file: match[1], quarantinedAs: name }] : [];
      });
    return { origins: usage.sizes.size, totalBytes: usage.bytes, corrupt };
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const result = this.writeTail.then(task);
    this.writeTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private remember(origin: string, record: SiteRecord): void {
    this.cache.delete(origin);
    this.cache.set(origin, record);
    while (this.cache.size > this.cacheEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  /** Once per store: check the directory is private and remove temp files a crash left behind. A failure is retried on the next call. */
  private ready(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = this.prepare().catch((error: unknown) => {
        this.readyPromise = null;
        throw error;
      });
    }
    return this.readyPromise;
  }

  private async prepare(): Promise<void> {
    let st;
    try {
      st = await fsp.lstat(this.sitesDir);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        await this.removeTemps(this.memoryDir, /^policy\.json\..+\.tmp$/u);
        return;
      }
      throw new MemoryStoreError('MEMORY_UNAVAILABLE', 'memory directory could not be read');
    }
    this.assertPrivate(st, 'directory');
    await this.removeTemps(this.sitesDir, /\.tmp$/u);
    await this.removeTemps(this.memoryDir, /^policy\.json\..+\.tmp$/u);
  }

  private async removeTemps(dir: string, pattern: RegExp): Promise<void> {
    let names: string[];
    try {
      names = await fsp.readdir(dir);
    } catch {
      return;
    }
    await Promise.all(names.filter((name) => pattern.test(name)).map((name) => fsp.rm(path.join(dir, name), { force: true }).catch(() => undefined)));
  }

  /** The POSIX owner and mode-bit check; win32 has no comparable mode bits, so it is skipped there. */
  private assertPrivate(st: Awaited<ReturnType<typeof fsp.lstat>>, kind: 'directory' | 'file'): void {
    if (st.isSymbolicLink() || (kind === 'directory' ? !st.isDirectory() : !st.isFile())) {
      throw new MemoryStoreError('MEMORY_UNAVAILABLE', `memory ${kind} is not a regular ${kind}`);
    }
    if (this.platform === 'win32') return;
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (uid !== undefined && st.uid !== uid) throw new MemoryStoreError('MEMORY_UNAVAILABLE', `memory ${kind} is owned by another user`);
    if ((Number(st.mode) & 0o077) !== 0) throw new MemoryStoreError('MEMORY_UNAVAILABLE', `memory ${kind} permissions allow other users`);
  }

  private async listDir(): Promise<string[]> {
    try {
      return await fsp.readdir(this.sitesDir);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return [];
      throw new MemoryStoreError('MEMORY_UNAVAILABLE', 'memory directory could not be read');
    }
  }

  private async loadUsage(): Promise<Usage> {
    if (this.usage) return this.usage;
    const sizes = new Map<string, number>();
    let bytes = 0;
    for (const name of await this.listDir()) {
      if (!SITE_FILE.test(name)) continue;
      try {
        const size = (await fsp.stat(path.join(this.sitesDir, name))).size;
        sizes.set(name, size);
        bytes += size;
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw new MemoryStoreError('MEMORY_UNAVAILABLE', 'memory directory could not be read');
      }
    }
    this.usage = { sizes, bytes };
    return this.usage;
  }

  /** Read one site file. Unreadable content is quarantined and reported as MEMORY_CORRUPT; the origin then starts empty. */
  private async readSiteFile(fileName: string): Promise<SiteRecord | null> {
    const file = path.join(this.sitesDir, fileName);
    let st;
    try {
      st = await fsp.lstat(file);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null;
      throw new MemoryStoreError('MEMORY_UNAVAILABLE', 'site file could not be read');
    }
    this.assertPrivate(st, 'file');
    if (st.size > MAX_SITE_BYTES) return this.quarantine(fileName, 'site file is too large');
    let text: string;
    try {
      text = await fsp.readFile(file, 'utf8');
    } catch {
      throw new MemoryStoreError('MEMORY_UNAVAILABLE', 'site file could not be read');
    }
    let record: SiteRecord;
    try {
      record = validateSiteRecord(JSON.parse(text), 'read');
    } catch (error) {
      return this.quarantine(fileName, error instanceof MemoryStoreError ? error.message : 'site file is not valid JSON');
    }
    if (siteFileName(record.origin) !== fileName) return this.quarantine(fileName, 'site origin does not match its file name');
    return record;
  }

  private async quarantine(fileName: string, reason: string): Promise<never> {
    const now = this.options.now ?? Date.now;
    try {
      await fsp.rename(path.join(this.sitesDir, fileName), path.join(this.sitesDir, `${fileName}.corrupt-${now()}`));
    } catch {
      // The read still fails closed; status keeps reporting the file until it can be moved.
    }
    if (this.usage) {
      this.usage.bytes -= this.usage.sizes.get(fileName) ?? 0;
      this.usage.sizes.delete(fileName);
    }
    throw new MemoryStoreError('MEMORY_CORRUPT', reason);
  }
}
