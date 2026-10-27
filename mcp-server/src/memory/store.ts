import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { AtomicWriteAborted, atomicWriteFile, type AtomicWriteOptions } from './atomic-file.js';
import { canonicalOrigin } from './policy.js';
import {
  MAX_ORIGINS,
  MAX_SITE_BYTES,
  MAX_TOTAL_BYTES,
  MemoryStoreError,
  validateSiteRecord,
  type SiteRecord,
} from './site-record.js';

export * from './site-record.js';

const DEFAULT_CACHE_ENTRIES = 512;
const SITE_FILE = /^[0-9a-f]{64}\.json$/u;
const QUARANTINED_FILE = /^([0-9a-f]{64}\.json)\.corrupt-\d+$/u;
/** The policy is written by the service, not this store, so its temp file may belong to a write in flight. */
const STALE_POLICY_TEMP_MS = 60_000;

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
  /** `afterWrites` waits for writes already in flight, so a read-modify-write never starts from a stale record. Reminder reads leave it off and never wait for a commit. */
  getSite(origin: string, options?: { afterWrites?: boolean }): Promise<SiteRecord | null>;
  /** Optional: do the first-use work ahead of time. */
  warm?(): Promise<void>;
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
  /** Bumped by every write and delete; a read that started under an older epoch is not cached. */
  private epoch = 0;
  private readyPromise: Promise<void> | null = null;
  private usage: Usage | null = null;
  private usageLoading: Promise<Usage> | null = null;

  constructor(memoryDir: string, options: JsonMemoryStoreOptions = {}) {
    this.memoryDir = path.resolve(memoryDir);
    this.sitesDir = path.join(this.memoryDir, 'sites');
    this.options = options;
    this.platform = options.platform ?? process.platform;
    this.maxOrigins = options.limits?.maxOrigins ?? MAX_ORIGINS;
    this.maxTotalBytes = options.limits?.maxTotalBytes ?? MAX_TOTAL_BYTES;
    this.cacheEntries = options.cacheEntries ?? DEFAULT_CACHE_ENTRIES;
  }

  async getSite(origin: string, options: { afterWrites?: boolean } = {}): Promise<SiteRecord | null> {
    requireOrigin(origin);
    await this.ready();
    // A commit must see a write that is still in flight (for example one the queue abandoned) before it builds on the record.
    if (options.afterWrites) await this.writeTail;
    const cached = this.cache.get(origin);
    if (cached) {
      this.remember(origin, cached);
      return structuredClone(cached);
    }
    const epoch = this.epoch;
    const record = await this.readSiteFile(siteFileName(origin));
    if (!record) return null;
    if (epoch === this.epoch) this.remember(origin, record);
    return structuredClone(record);
  }

  /** Prepare the directory and total the stored sizes ahead of the first write, so that the first commit does not wait for the scan. Never rejects. */
  async warm(): Promise<void> {
    try {
      await this.ready();
      await this.loadUsage();
    } catch {
      // The first real read or write reports the failure.
    }
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
      this.epoch += 1;
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
      this.epoch += 1;
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
      this.epoch += 1;
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
        await this.removeTemps(this.memoryDir, /^policy\.json\..+\.tmp$/u, STALE_POLICY_TEMP_MS);
        return;
      }
      throw new MemoryStoreError('MEMORY_UNAVAILABLE', 'memory directory could not be read');
    }
    this.assertPrivate(st, 'directory');
    await this.removeTemps(this.sitesDir, /\.tmp$/u);
    await this.removeTemps(this.memoryDir, /^policy\.json\..+\.tmp$/u, STALE_POLICY_TEMP_MS);
  }

  /** Removes matching temp files; with `minAgeMs`, only those not modified for that long (a write may be in flight). */
  private async removeTemps(dir: string, pattern: RegExp, minAgeMs = 0): Promise<void> {
    let names: string[];
    try {
      names = await fsp.readdir(dir);
    } catch {
      return;
    }
    // File times come from the wall clock, not the injectable one.
    const cutoff = Date.now() - minAgeMs;
    await Promise.all(
      names
        .filter((name) => pattern.test(name))
        .map(async (name) => {
          const file = path.join(dir, name);
          if (minAgeMs > 0 && (await fsp.lstat(file)).mtimeMs > cutoff) return;
          await fsp.rm(file, { force: true });
        })
        .map((removal) => removal.catch(() => undefined)),
    );
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
      const names = (await this.listDir()).filter((name) => SITE_FILE.test(name));
      const stats = await Promise.all(
        names.map(async (name) => {
          try {
            return { name, size: (await fsp.stat(path.join(this.sitesDir, name))).size };
          } catch (error) {
            if (errorCode(error) !== 'ENOENT') throw new MemoryStoreError('MEMORY_UNAVAILABLE', 'memory directory could not be read');
            return null;
          }
        }),
      );
      // A write or delete that landed during the scan makes the totals stale: scan again.
      if (epoch !== this.epoch) continue;
      const sizes = new Map<string, number>();
      let bytes = 0;
      for (const entry of stats) {
        if (!entry) continue;
        sizes.set(entry.name, entry.size);
        bytes += entry.size;
      }
      this.usage = { sizes, bytes };
      return this.usage;
    }
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
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null;
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
