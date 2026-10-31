/**
 * The site-map store (specs/004-site-navigation-map research R-02): one atomically replaced JSON file per
 * (browser profile, origin) under `<memoryDir>/maps/<sha256(profile)>/`, plus `<memoryDir>/map-counters.json`.
 * One writer: every mutation runs through a single promise chain, and the cache changes only after a rename.
 * Local files only.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { AtomicWriteAborted, atomicWriteFile, errorCode, isVanished, quarantineName, removeTemps, type AtomicWriteOptions } from '../core/json-store.js';
import {
  MAX_MAP_BYTES,
  MAX_MAP_FILES_PER_PROFILE,
  MAX_MAP_TOTAL_BYTES,
  mapFileName,
  mapProfileDir,
  validateMapRecord,
  type MapRecord,
} from './map-record.js';
import { canonicalOrigin } from './policy.js';
import { assertPrivate } from './record-files.js';
import { MemoryStoreError } from './site-record.js';
import { isRecord } from '../core/guards.js';
import { ERROR_CODES } from '../core/error-codes.js';

const DEFAULT_CACHE_ENTRIES = 128;
const PROFILE_DIR = /^[0-9a-f]{64}$/u;
const MAP_FILE = /^[0-9a-f]{64}\.json$/u;
const QUARANTINED = /\.corrupt-\d+$/u;
const COUNTERS_FILE = 'map-counters.json';
const MAX_COUNTERS_BYTES = 64 * 1024;
const STALE_POLICY_TEMP_MS = 60_000;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;

export const COUNTER_FIELDS = ['lookups', 'usesWorked', 'usesFailed', 'loadsSavedEstimate', 'charsSavedEstimate'] as const;
export type CounterField = (typeof COUNTER_FIELDS)[number];
export type MapCounters = Record<CounterField, number> & { since: string };
export interface MapCountersFile {
  schemaVersion: 1;
  profiles: Record<string, MapCounters>;
}

export interface MapStoreStatus {
  profiles: number;
  files: number;
  totalBytes: number;
  /** Map and counter files set aside as `<name>.corrupt-<ts>`. A count only: names would reveal nothing useful and paths are private. */
  corrupt: number;
}

export interface MapStoreLimits {
  maxFileBytes?: number;
  maxFilesPerProfile?: number;
  maxTotalBytes?: number;
}

export interface JsonMapStoreOptions extends Pick<AtomicWriteOptions, 'platform' | 'rename' | 'sleep' | 'afterTempWrite'> {
  /** Only names quarantined files; stored times always come from the caller. */
  now?: () => number;
  limits?: MapStoreLimits;
  cacheEntries?: number;
}

export function emptyCounters(): MapCountersFile {
  return { schemaVersion: 1, profiles: {} };
}

function requireOrigin(origin: string): void {
  if (typeof origin !== 'string' || canonicalOrigin(origin) !== origin) throw new MemoryStoreError(ERROR_CODES.INVALID_ARGUMENT, 'origin must be a canonical http or https origin');
}

function requireProfile(profile: string): void {
  if (typeof profile !== 'string' || profile.length === 0 || profile.length > 200) throw new MemoryStoreError(ERROR_CODES.INVALID_ARGUMENT, 'a browser profile is required');
}


function validateCounters(raw: unknown, mode: 'read' | 'write'): MapCountersFile {
  const fail = (message: string): MemoryStoreError => new MemoryStoreError(mode === 'read' ? ERROR_CODES.MEMORY_CORRUPT : ERROR_CODES.INVALID_ARGUMENT, message);
  if (!isRecord(raw) || raw.schemaVersion !== 1 || !isRecord(raw.profiles)) throw fail('map counters are invalid');
  if (Object.keys(raw).some((key) => key !== 'schemaVersion' && key !== 'profiles')) throw fail('map counters have an unknown field');
  const profiles: Record<string, MapCounters> = {};
  for (const [id, entry] of Object.entries(raw.profiles)) {
    if (!id || id.length > 200 || id === '__proto__' || !isRecord(entry)) throw fail('map counters hold an invalid profile');
    if (Object.keys(entry).some((key) => key !== 'since' && !(COUNTER_FIELDS as readonly string[]).includes(key))) throw fail('map counters have an unknown field');
    if (typeof entry.since !== 'string' || !ISO_UTC.test(entry.since)) throw fail('map counters since is invalid');
    const counters = { since: entry.since } as MapCounters;
    for (const field of COUNTER_FIELDS) {
      const value = entry[field];
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw fail('map counter is not a count');
      counters[field] = value;
    }
    profiles[id] = counters;
  }
  return { schemaVersion: 1, profiles };
}

interface Usage {
  /** profile dir → file name → bytes */
  profiles: Map<string, Map<string, number>>;
  bytes: number;
}

export class JsonMapStore {
  readonly mapsDir: string;
  private readonly memoryDir: string;
  private readonly options: JsonMapStoreOptions;
  private readonly platform: NodeJS.Platform;
  private readonly maxFileBytes: number;
  private readonly maxFilesPerProfile: number;
  private readonly maxTotalBytes: number;
  private readonly cacheEntries: number;
  private readonly cache = new Map<string, MapRecord>();
  private writeTail: Promise<void> = Promise.resolve();
  private epoch = 0;
  private readyPromise: Promise<void> | null = null;
  private usage: Usage | null = null;
  private usageLoading: Promise<Usage> | null = null;

  constructor(memoryDir: string, options: JsonMapStoreOptions = {}) {
    this.memoryDir = path.resolve(memoryDir);
    this.mapsDir = path.join(this.memoryDir, 'maps');
    this.options = options;
    this.platform = options.platform ?? process.platform;
    this.maxFileBytes = options.limits?.maxFileBytes ?? MAX_MAP_BYTES;
    this.maxFilesPerProfile = options.limits?.maxFilesPerProfile ?? MAX_MAP_FILES_PER_PROFILE;
    this.maxTotalBytes = options.limits?.maxTotalBytes ?? MAX_MAP_TOTAL_BYTES;
    this.cacheEntries = options.cacheEntries ?? DEFAULT_CACHE_ENTRIES;
  }

  /** The file-size bound commits evict to (R-18). */
  get fileByteLimit(): number {
    return this.maxFileBytes;
  }

  async getMap(profile: string, origin: string, options: { afterWrites?: boolean } = {}): Promise<MapRecord | null> {
    requireProfile(profile);
    requireOrigin(origin);
    await this.ready();
    if (options.afterWrites) await this.writeTail;
    const key = mapFileName(profile, origin);
    const cached = this.cache.get(key);
    if (cached) {
      this.remember(key, cached);
      return structuredClone(cached);
    }
    const epoch = this.epoch;
    const record = await this.readMapFile(key);
    if (!record) return null;
    if (epoch === this.epoch) this.remember(key, record);
    return structuredClone(record);
  }

  /** True when a new file for this pair would be refused at the profile or total limit (status reports MEMORY_FULL). */
  async wouldRefuseNew(profile: string, origin: string): Promise<boolean> {
    await this.ready();
    const usage = await this.loadUsage();
    const [dir, file] = mapFileName(profile, origin).split('/');
    const files = usage.profiles.get(dir);
    if (files?.has(file)) return false;
    return (files?.size ?? 0) >= this.maxFilesPerProfile || usage.bytes >= this.maxTotalBytes;
  }

  async warm(): Promise<void> {
    try {
      await this.ready();
      await this.loadUsage();
    } catch {
      // The first real read or write reports the failure.
    }
  }

  putMap(record: MapRecord, options: { signal?: AbortSignal } = {}): Promise<void> {
    return this.serialize(async () => {
      const valid = validateMapRecord(record, 'write');
      await this.ready();
      if (options.signal?.aborted) throw new MemoryStoreError(ERROR_CODES.MEMORY_UNAVAILABLE, 'write abandoned before it started');
      const data = `${JSON.stringify(valid)}\n`;
      const bytes = Buffer.byteLength(data);
      if (bytes > this.maxFileBytes) throw new MemoryStoreError(ERROR_CODES.MEMORY_FULL, `a map file is limited to ${this.maxFileBytes} bytes`);
      const key = mapFileName(valid.profile, valid.origin);
      const [dir, file] = key.split('/');
      const usage = await this.loadUsage();
      const files = usage.profiles.get(dir) ?? new Map<string, number>();
      const previous = files.get(file);
      if (previous === undefined && files.size >= this.maxFilesPerProfile) throw new MemoryStoreError(ERROR_CODES.MEMORY_FULL, `at most ${this.maxFilesPerProfile} site maps can be stored per profile`);
      if (usage.bytes - (previous ?? 0) + bytes > this.maxTotalBytes) throw new MemoryStoreError(ERROR_CODES.MEMORY_FULL, 'the total size limit for site maps was reached');
      try {
        await atomicWriteFile(path.join(this.mapsDir, dir), file, data, {
          platform: this.options.platform,
          rename: this.options.rename,
          sleep: this.options.sleep,
          afterTempWrite: this.options.afterTempWrite,
          signal: options.signal,
        });
      } catch (error) {
        if (error instanceof AtomicWriteAborted) throw new MemoryStoreError(ERROR_CODES.MEMORY_UNAVAILABLE, 'write abandoned before the rename');
        const code = errorCode(error);
        if (code === 'ENOSPC' || code === 'EDQUOT') throw new MemoryStoreError(ERROR_CODES.MEMORY_FULL, 'no space left for site maps');
        throw new MemoryStoreError(ERROR_CODES.MEMORY_UNAVAILABLE, 'map file could not be written');
      }
      this.epoch += 1;
      usage.bytes += bytes - (previous ?? 0);
      files.set(file, bytes);
      usage.profiles.set(dir, files);
      this.remember(key, structuredClone(valid));
    });
  }

  deleteMap(profile: string, origin: string): Promise<boolean> {
    return this.serialize(async () => {
      requireProfile(profile);
      requireOrigin(origin);
      await this.ready();
      return this.unlinkMap(mapFileName(profile, origin));
    });
  }

  /** Every map of one profile. Returns the number of map files removed. */
  deleteProfile(profile: string): Promise<number> {
    return this.serialize(async () => {
      requireProfile(profile);
      await this.ready();
      return this.removeProfileDir(mapProfileDir(profile));
    });
  }

  /** One origin's maps in each listed profile (003 site delete, map path exclusion uses deleteMap per profile). */
  deleteOrigin(origin: string, profiles: readonly string[]): Promise<number> {
    return this.serialize(async () => {
      requireOrigin(origin);
      await this.ready();
      let removed = 0;
      for (const profile of profiles) if (await this.unlinkMap(mapFileName(profile, origin))) removed += 1;
      return removed;
    });
  }

  /** Every map and the counters (003 `delete --all`, map `delete --all`). */
  deleteAll(): Promise<number> {
    return this.serialize(async () => {
      await this.ready();
      let removed = 0;
      for (const dir of await this.listDir(this.mapsDir)) {
        if (PROFILE_DIR.test(dir)) removed += await this.removeProfileDir(dir);
      }
      await this.removeCountersFiles();
      this.epoch += 1;
      this.cache.clear();
      this.usage = { profiles: new Map(), bytes: 0 };
      return removed;
    });
  }

  /** Maps of one profile, or of every profile. Corrupt files are quarantined and skipped. */
  async listMaps(profile?: string): Promise<MapRecord[]> {
    await this.ready();
    const dirs = profile === undefined ? (await this.listDir(this.mapsDir)).filter((dir) => PROFILE_DIR.test(dir)).sort() : [mapProfileDir(profile)];
    const maps: MapRecord[] = [];
    for (const dir of dirs) {
      for (const file of (await this.listDir(path.join(this.mapsDir, dir))).filter((name) => MAP_FILE.test(name)).sort()) {
        try {
          const record = await this.readMapFile(`${dir}/${file}`);
          if (record) maps.push(structuredClone(record));
        } catch (error) {
          if (error instanceof MemoryStoreError && error.code === ERROR_CODES.MEMORY_CORRUPT) continue;
          throw error;
        }
      }
    }
    return maps;
  }

  async getCounters(): Promise<MapCountersFile> {
    await this.ready();
    const file = path.join(this.memoryDir, COUNTERS_FILE);
    let st;
    try {
      st = await fsp.lstat(file);
    } catch (error) {
      if (isVanished(error, this.platform)) return emptyCounters();
      throw new MemoryStoreError(ERROR_CODES.MEMORY_UNAVAILABLE, 'map counters could not be read');
    }
    assertPrivate(st, 'file', this.platform);
    if (st.size > MAX_COUNTERS_BYTES) return this.quarantineCounters();
    let text: string;
    try {
      text = await fsp.readFile(file, 'utf8');
    } catch (error) {
      if (isVanished(error, this.platform)) return emptyCounters();
      // A read error is not corruption: the file stays where it is (as for map files).
      throw new MemoryStoreError(ERROR_CODES.MEMORY_UNAVAILABLE, 'map counters could not be read');
    }
    try {
      return validateCounters(JSON.parse(text), 'read');
    } catch {
      return this.quarantineCounters();
    }
  }

  putCounters(counters: MapCountersFile): Promise<void> {
    return this.serialize(async () => {
      const data = `${JSON.stringify(validateCounters(counters, 'write'))}\n`;
      await this.ready();
      try {
        await atomicWriteFile(this.memoryDir, COUNTERS_FILE, data, { platform: this.options.platform, rename: this.options.rename, sleep: this.options.sleep });
      } catch {
        throw new MemoryStoreError(ERROR_CODES.MEMORY_UNAVAILABLE, 'map counters could not be written');
      }
    });
  }

  async status(): Promise<MapStoreStatus> {
    await this.ready();
    const usage = await this.loadUsage();
    let corrupt = 0;
    for (const dir of (await this.listDir(this.mapsDir)).filter((name) => PROFILE_DIR.test(name))) {
      corrupt += (await this.listDir(path.join(this.mapsDir, dir))).filter((name) => QUARANTINED.test(name)).length;
    }
    corrupt += (await this.listDir(this.memoryDir)).filter((name) => name.startsWith(`${COUNTERS_FILE}.corrupt-`)).length;
    let files = 0;
    let profiles = 0;
    for (const entry of usage.profiles.values()) {
      files += entry.size;
      if (entry.size) profiles += 1;
    }
    return { profiles, files, totalBytes: usage.bytes, corrupt };
  }

  /** One profile's share of the store, for `map status`. Counts only. */
  async profileUsage(profile: string): Promise<{ files: number; bytes: number; quarantined: number }> {
    requireProfile(profile);
    await this.ready();
    const dir = mapProfileDir(profile);
    const files = (await this.loadUsage()).profiles.get(dir) ?? new Map<string, number>();
    let bytes = 0;
    for (const size of files.values()) bytes += size;
    const quarantined = (await this.listDir(path.join(this.mapsDir, dir))).filter((name) => QUARANTINED.test(name)).length;
    return { files: files.size, bytes, quarantined };
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const result = this.writeTail.then(task);
    this.writeTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private remember(key: string, record: MapRecord): void {
    this.cache.delete(key);
    this.cache.set(key, record);
    while (this.cache.size > this.cacheEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private async unlinkMap(key: string): Promise<boolean> {
    const [dir, file] = key.split('/');
    const dirPath = path.join(this.mapsDir, dir);
    let removed = false;
    try {
      await fsp.unlink(path.join(dirPath, file));
      removed = true;
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw new MemoryStoreError(ERROR_CODES.MEMORY_UNAVAILABLE, 'map file could not be deleted');
    }
    for (const name of await this.listDir(dirPath)) {
      if (name.startsWith(`${file}.corrupt-`)) await fsp.rm(path.join(dirPath, name), { force: true });
    }
    this.epoch += 1;
    this.cache.delete(key);
    const files = this.usage?.profiles.get(dir);
    if (this.usage && files) {
      this.usage.bytes -= files.get(file) ?? 0;
      files.delete(file);
    }
    return removed;
  }

  private async removeProfileDir(dir: string): Promise<number> {
    const dirPath = path.join(this.mapsDir, dir);
    const removed = (await this.listDir(dirPath)).filter((name) => MAP_FILE.test(name)).length;
    try {
      await fsp.rm(dirPath, { recursive: true, force: true });
    } catch {
      throw new MemoryStoreError(ERROR_CODES.MEMORY_UNAVAILABLE, 'map directory could not be deleted');
    }
    this.epoch += 1;
    for (const key of [...this.cache.keys()]) if (key.startsWith(`${dir}/`)) this.cache.delete(key);
    if (this.usage) {
      for (const size of this.usage.profiles.get(dir)?.values() ?? []) this.usage.bytes -= size;
      this.usage.profiles.delete(dir);
    }
    return removed;
  }

  private async removeCountersFiles(): Promise<void> {
    for (const name of await this.listDir(this.memoryDir)) {
      if (name === COUNTERS_FILE || name.startsWith(`${COUNTERS_FILE}.corrupt-`)) {
        try {
          await fsp.unlink(path.join(this.memoryDir, name));
        } catch (error) {
          if (errorCode(error) !== 'ENOENT') throw new MemoryStoreError(ERROR_CODES.MEMORY_UNAVAILABLE, 'map counters could not be deleted');
        }
      }
    }
  }

  private ready(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = this.prepare().catch((error: unknown) => {
        this.readyPromise = null;
        throw error;
      });
    }
    return this.readyPromise;
  }

  /** Once per store: check the directories are private and remove temp files a crash left behind. */
  private async prepare(): Promise<void> {
    await removeTemps(this.memoryDir, /^map-policy\.json\..+\.tmp$/u, STALE_POLICY_TEMP_MS);
    await removeTemps(this.memoryDir, /^map-counters\.json\..+\.tmp$/u);
    let st;
    try {
      st = await fsp.lstat(this.mapsDir);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return;
      throw new MemoryStoreError(ERROR_CODES.MEMORY_UNAVAILABLE, 'map directory could not be read');
    }
    assertPrivate(st, 'directory', this.platform);
    for (const dir of (await this.listDir(this.mapsDir)).filter((name) => PROFILE_DIR.test(name))) {
      assertPrivate(await fsp.lstat(path.join(this.mapsDir, dir)), 'directory', this.platform);
      await removeTemps(path.join(this.mapsDir, dir), /\.tmp$/u);
    }
  }

  private async listDir(dir: string): Promise<string[]> {
    try {
      return await fsp.readdir(dir);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return [];
      throw new MemoryStoreError(ERROR_CODES.MEMORY_UNAVAILABLE, 'map directory could not be read');
    }
  }

  private loadUsage(): Promise<Usage> {
    if (this.usage) return Promise.resolve(this.usage);
    this.usageLoading ??= this.scanUsage().finally(() => {
      this.usageLoading = null;
    });
    return this.usageLoading;
  }

  private async scanUsage(): Promise<Usage> {
    for (;;) {
      const epoch = this.epoch;
      const profiles = new Map<string, Map<string, number>>();
      let bytes = 0;
      for (const dir of (await this.listDir(this.mapsDir)).filter((name) => PROFILE_DIR.test(name))) {
        const files = new Map<string, number>();
        for (const name of (await this.listDir(path.join(this.mapsDir, dir))).filter((entry) => MAP_FILE.test(entry))) {
          try {
            const size = (await fsp.stat(path.join(this.mapsDir, dir, name))).size;
            files.set(name, size);
            bytes += size;
          } catch (error) {
            if (errorCode(error) !== 'ENOENT') throw new MemoryStoreError(ERROR_CODES.MEMORY_UNAVAILABLE, 'map directory could not be read');
          }
        }
        profiles.set(dir, files);
      }
      if (epoch !== this.epoch) continue;
      this.usage = { profiles, bytes };
      return this.usage;
    }
  }

  /** Read one map file. Unreadable content is quarantined and reported as MEMORY_CORRUPT; the map then starts empty. */
  private async readMapFile(key: string): Promise<MapRecord | null> {
    const file = path.join(this.mapsDir, key);
    let st;
    try {
      st = await fsp.lstat(file);
    } catch (error) {
      if (isVanished(error, this.platform)) return null;
      throw new MemoryStoreError(ERROR_CODES.MEMORY_UNAVAILABLE, 'map file could not be read');
    }
    assertPrivate(st, 'file', this.platform);
    if (st.size > this.maxFileBytes) return this.quarantine(key, 'map file is too large');
    let text: string;
    try {
      text = await fsp.readFile(file, 'utf8');
    } catch (error) {
      if (isVanished(error, this.platform)) return null;
      throw new MemoryStoreError(ERROR_CODES.MEMORY_UNAVAILABLE, 'map file could not be read');
    }
    let record: MapRecord;
    try {
      record = validateMapRecord(JSON.parse(text), 'read');
    } catch (error) {
      return this.quarantine(key, error instanceof MemoryStoreError ? error.message : 'map file is not valid JSON');
    }
    if (mapFileName(record.profile, record.origin) !== key) return this.quarantine(key, 'map profile and origin do not match the file name');
    return record;
  }

  private async quarantine(key: string, reason: string): Promise<never> {
    const now = this.options.now ?? Date.now;
    const [dir, file] = key.split('/');
    try {
      await fsp.rename(path.join(this.mapsDir, dir, file), path.join(this.mapsDir, dir, quarantineName(file, now())));
    } catch {
      // The read still fails closed.
    }
    const files = this.usage?.profiles.get(dir);
    if (this.usage && files) {
      this.usage.bytes -= files.get(file) ?? 0;
      files.delete(file);
    }
    this.cache.delete(key);
    throw new MemoryStoreError(ERROR_CODES.MEMORY_CORRUPT, reason);
  }

  private async quarantineCounters(): Promise<MapCountersFile> {
    const now = this.options.now ?? Date.now;
    try {
      await fsp.rename(path.join(this.memoryDir, COUNTERS_FILE), path.join(this.memoryDir, quarantineName(COUNTERS_FILE, now())));
    } catch {
      // Counters are estimates; a file that cannot be moved is read as empty again next time.
    }
    return emptyCounters();
  }
}
