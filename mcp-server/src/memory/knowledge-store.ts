import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AtomicWriteUnconfirmed, atomicReplace, errorCode, fsyncDirectory, readSafeFile, type AtomicReplaceOptions, type FileStat } from '../core/json-store.js';
import { ERROR_CODES } from '../core/error-codes.js';
import { canonicalOrigin } from './policy.js';
import { assertPrivate } from './record-files.js';
import { validateKnowledgeRecord, type KnowledgeFile } from './knowledge-record.js';
import { currentKnowledgeEpoch, invalidateKnowledgeEpoch, serializeKnowledge } from './knowledge-coordinator.js';
import { KnowledgeDeletionJournal } from './knowledge-deletion-journal.js';

const MAX_FILE_BYTES = 128 * 1024;
const FILE_NAME = /^[a-f0-9]{64}\.json$/u;
const TEMP_FILE_NAME = /^([a-f0-9]{64}\.json)\.[0-9]+\.[a-f0-9]+\.tmp$/u;
const DEFAULT_MAX_FILES_PER_PROFILE = 500;
const DEFAULT_MAX_TOTAL_BYTES = 32 * 1024 * 1024;

export interface KnowledgeStoreOptions extends Pick<AtomicReplaceOptions, 'afterTempWrite' | 'syncDirectory' | 'rename'> {
  maxFilesPerProfile?: number;
  maxTotalBytes?: number;
  unlink?: (file: string) => Promise<void>;
}

export interface KnowledgeWriteOptions {
  signal?: AbortSignal;
  /** Trusted caller's check of the current approval, scope and policy generation. */
  validateCommit: (commitEpoch: number) => boolean | Promise<boolean>;
  /** Consume the already validated one-shot approval immediately before rename. */
  finalizeCommit: () => void;
  /** Invalidate reads and drafts when a committed change removes or replaces information. */
  invalidateReaders?: boolean;
}

function validScope(browserId: string, origin: string): boolean {
  return typeof browserId === 'string' && browserId.length > 0 && browserId.length <= 64
    && browserId !== 'default' && !/[\p{Cc}\p{Cf}]/u.test(browserId)
    && typeof origin === 'string' && canonicalOrigin(origin) === origin;
}

function fileName(browserId: string, origin: string): string {
  return `${crypto.createHash('sha256').update(JSON.stringify([browserId, origin])).digest('hex')}.json`;
}

/** Single-daemon store. This module is not an authorization or approval boundary. */
export class JsonKnowledgeStore {
  private readonly root: string;
  private readonly directory: string;
  private readonly deletions: KnowledgeDeletionJournal;

  constructor(memoryDir: string, private readonly options: KnowledgeStoreOptions = {}) {
    this.root = path.resolve(memoryDir);
    this.directory = path.join(this.root, 'knowledge');
    this.deletions = new KnowledgeDeletionJournal(this.root);
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    return serializeKnowledge(this.root, operation);
  }

  private async prepare(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    assertPrivate(await fs.lstat(this.root), 'directory', process.platform);
    await fs.mkdir(this.directory, { mode: 0o700 }).catch((error: unknown) => {
      if (errorCode(error) !== 'EEXIST') throw error;
    });
    assertPrivate(await fs.lstat(this.directory), 'directory', process.platform);
  }

  private async readFile(name: string, identityName = name): Promise<{ record: KnowledgeFile; size: number } | null> {
    const file = path.join(this.directory, name);
    try { await fs.lstat(file); } catch (error) {
      if (errorCode(error) === 'ENOENT') return null;
      throw new Error('Site knowledge record unavailable', { cause: error });
    }
    const bytes = await readSafeFile(file, MAX_FILE_BYTES, {
      fail: (message) => new Error(message),
      isOwnError: () => false,
      check: (stat: FileStat, kind) => assertPrivate(stat as import('node:fs').Stats, kind, process.platform),
      unavailable: 'Site knowledge record unavailable',
      tooLarge: 'Site knowledge record exceeds size limit',
      unreadable: 'Site knowledge record unreadable',
    });
    let record: KnowledgeFile;
    try { record = validateKnowledgeRecord(JSON.parse(bytes.toString('utf8'))); } catch {
      throw Object.assign(new Error('Invalid site knowledge record'), { code: ERROR_CODES.MEMORY_CORRUPT });
    }
    if (fileName(record.browserId, record.origin) !== identityName) {
      throw Object.assign(new Error('Site knowledge scope mismatch'), { code: ERROR_CODES.MEMORY_CORRUPT });
    }
    return { record, size: bytes.length };
  }

  get(browserId: string, origin: string): Promise<KnowledgeFile | null> {
    return this.serialize(async () => {
      if (!validScope(browserId, origin)) throw new Error('Invalid site knowledge scope');
      await this.prepare();
      if (await this.deletions.isBlockedForCommit(origin)) throw new Error('Site knowledge unavailable');
      const found = await this.readFile(fileName(browserId, origin));
      return found ? structuredClone(found.record) : null;
    });
  }

  put(raw: KnowledgeFile, expectedRevision: number, options: KnowledgeWriteOptions): Promise<void> {
    let epoch = currentKnowledgeEpoch(this.root);
    return this.serialize(async () => {
      if (epoch !== currentKnowledgeEpoch(this.root) || typeof options?.validateCommit !== 'function' || typeof options.finalizeCommit !== 'function'
          || await options.validateCommit(epoch) !== true || epoch !== currentKnowledgeEpoch(this.root)) {
        throw new Error('Site knowledge commit not authorized');
      }
      if (options.signal?.aborted) throw new Error('Site knowledge write cancelled');
      const record = validateKnowledgeRecord(raw);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || record.revision !== expectedRevision + 1) {
        throw new Error('Invalid site knowledge revision');
      }
      await this.prepare();
      if (await this.deletions.isBlockedForCommit(record.origin)) throw new Error('Site knowledge unavailable');
      const name = fileName(record.browserId, record.origin);
      const names = (await fs.readdir(this.directory)).filter((entry) => FILE_NAME.test(entry));
      let existing: KnowledgeFile | null = null;
      let count = 0;
      let totalBytes = 0;
      let previousBytes = 0;
      for (const candidate of names) {
        const found = await this.readFile(candidate);
        if (!found) throw new Error('Site knowledge changed during scan');
        totalBytes += found.size;
        if (found.record.browserId === record.browserId) count += 1;
        if (candidate === name) { existing = found.record; previousBytes = found.size; }
      }
      if ((existing?.revision ?? 0) !== expectedRevision) {
        throw Object.assign(new Error('Stale site knowledge revision'), { code: ERROR_CODES.STALE_REVISION });
      }
      const data = `${JSON.stringify(record)}\n`;
      const bytes = Buffer.byteLength(data, 'utf8');
      if (bytes > MAX_FILE_BYTES) throw new Error('Site knowledge file exceeds size limit');
      if (!existing && count >= (this.options.maxFilesPerProfile ?? DEFAULT_MAX_FILES_PER_PROFILE)) {
        throw new Error('Site knowledge profile limit reached');
      }
      if (totalBytes - previousBytes + bytes > (this.options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES)) {
        throw new Error('Site knowledge total size limit reached');
      }
      if (options.invalidateReaders) {
        invalidateKnowledgeEpoch(this.root);
        epoch = currentKnowledgeEpoch(this.root);
      }
      try {
        await atomicReplace(path.join(this.directory, name), data, {
          afterTempWrite: this.options.afterTempWrite,
          syncDirectory: this.options.syncDirectory,
          rename: this.options.rename,
          signal: options.signal,
          beforeWrite: () => this.prepare(),
          beforeCommit: async () => {
            await this.prepare();
            if (await this.deletions.isBlockedForCommit(record.origin)) throw new Error('Site knowledge unavailable');
            if (options.signal?.aborted) throw new Error('Site knowledge write cancelled');
            if (epoch !== currentKnowledgeEpoch(this.root) || await options.validateCommit(epoch) !== true
                || epoch !== currentKnowledgeEpoch(this.root) || options.signal?.aborted) {
              throw new Error('Site knowledge commit not authorized');
            }
            options.finalizeCommit();
            if (epoch !== currentKnowledgeEpoch(this.root) || options.signal?.aborted) {
              throw new Error('Site knowledge commit not authorized');
            }
          },
        });
      } catch (error) {
        if (error instanceof AtomicWriteUnconfirmed) {
          throw Object.assign(new Error('Site knowledge write outcome is unknown', { cause: error }), {
            code: ERROR_CODES.OUTCOME_UNKNOWN,
          });
        }
        throw error;
      }
    });
  }

  private async removeFiles(names: string[]): Promise<number> {
    let count = 0;
    let failure: unknown;
    try {
      for (const name of names) {
        const file = path.join(this.directory, name);
        assertPrivate(await fs.lstat(file), 'file', process.platform);
        await (this.options.unlink ?? fs.unlink)(file);
        count += 1;
      }
    } catch (error) {
      failure = error;
    }
    if (count > 0) {
      try { await (this.options.syncDirectory ?? fsyncDirectory)(this.directory, process.platform); } catch (error) {
        throw Object.assign(new Error('Site knowledge deletion outcome is unknown', { cause: error }), { code: ERROR_CODES.OUTCOME_UNKNOWN });
      }
    }
    if (failure) throw new Error('Site knowledge cleanup incomplete', { cause: failure });
    return count;
  }

  private async cleanupCandidates(): Promise<Array<{ name: string; identityName: string }>> {
    const result: Array<{ name: string; identityName: string }> = [];
    for (const name of await fs.readdir(this.directory)) {
      if (FILE_NAME.test(name)) result.push({ name, identityName: name });
      else {
        const temp = TEMP_FILE_NAME.exec(name);
        if (!temp) throw new Error('Unexpected site knowledge file requires review');
        result.push({ name, identityName: temp[1]! });
      }
    }
    return result;
  }

  /** Verification for deletion recovery while the shared coordinator lock is held. */
  async isCleanForCommit(origin: string): Promise<boolean> {
    if (origin !== '*' && canonicalOrigin(origin) !== origin) throw new Error('Invalid site knowledge scope');
    await this.prepare();
    const files = await this.cleanupCandidates();
    if (origin === '*') return files.length === 0;
    for (const file of files) {
      const found = await this.readFile(file.name, file.identityName);
      if (!found) throw new Error('Site knowledge changed during scan');
      if (found.record.origin === origin) return false;
    }
    return true;
  }

  /** Deletes only knowledge files for one origin after a durable deletion block exists. */
  deleteOrigin(origin: string): Promise<number> {
    if (canonicalOrigin(origin) !== origin) return Promise.reject(new Error('Invalid site knowledge scope'));
    invalidateKnowledgeEpoch(this.root);
    return this.serialize(async () => {
      await this.prepare();
      if (!await this.deletions.isBlockedForCommit(origin)) throw new Error('Site knowledge deletion is not blocked');
      const matches: string[] = [];
      for (const file of await this.cleanupCandidates()) {
        const found = await this.readFile(file.name, file.identityName);
        if (!found) throw new Error('Site knowledge changed during scan');
        if (found.record.origin === origin) matches.push(file.name);
      }
      return this.removeFiles(matches);
    });
  }

  /** Deletes all knowledge files only under a durable delete-all block. */
  deleteAll(): Promise<number> {
    invalidateKnowledgeEpoch(this.root);
    return this.serialize(async () => {
      await this.prepare();
      if (!await this.deletions.blocksAllForCommit()) throw new Error('Site knowledge delete-all is not blocked');
      const files = await this.cleanupCandidates();
      return this.removeFiles(files.map((file) => file.name));
    });
  }
}
