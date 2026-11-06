import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ERROR_CODES } from '../core/error-codes.js';
import { AtomicWriteUnconfirmed, atomicReplace, errorCode, readSafeFile, type AtomicReplaceOptions, type FileStat } from '../core/json-store.js';
import { invalidateKnowledgeEpoch, serializeKnowledge } from './knowledge-coordinator.js';
import { canonicalOrigin } from './policy.js';
import { assertPrivate } from './record-files.js';

const MAX_JOURNAL_BYTES = 512 * 1024;
const MAX_ORIGINS = 5000;
const journalSchema = z.object({
  schemaVersion: z.literal(1), all: z.boolean(), origins: z.array(z.string().regex(/^[a-f0-9]{64}$/u)).max(MAX_ORIGINS),
}).strict().refine((value) => new Set(value.origins).size === value.origins.length);
type Journal = z.infer<typeof journalSchema>;

function keyFor(origin: string): string {
  if (origin === '*') return origin;
  if (canonicalOrigin(origin) !== origin) throw new Error('Invalid site knowledge deletion scope');
  return createHash('sha256').update(origin).digest('hex');
}

/** Internal durable block. It does not perform deletion or authenticate a caller. */
export class KnowledgeDeletionJournal {
  private readonly root: string;
  private readonly file: string;

  constructor(memoryDir: string, private readonly options: Pick<AtomicReplaceOptions, 'syncDirectory' | 'afterTempWrite'> = {}) {
    this.root = path.resolve(memoryDir);
    this.file = path.join(this.root, 'knowledge-delete-journal.json');
  }

  private async prepare(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    assertPrivate(await fs.lstat(this.root), 'directory', process.platform);
  }

  private async read(): Promise<Journal> {
    try { await fs.lstat(this.file); } catch (error) {
      if (errorCode(error) === 'ENOENT') return { schemaVersion: 1, all: false, origins: [] };
      throw new Error('Site knowledge deletion state unavailable', { cause: error });
    }
    const bytes = await readSafeFile(this.file, MAX_JOURNAL_BYTES, {
      fail: (message) => new Error(message), isOwnError: () => false,
      check: (stat: FileStat, kind) => assertPrivate(stat as import('node:fs').Stats, kind, process.platform),
      unavailable: 'Site knowledge deletion state unavailable', tooLarge: 'Site knowledge deletion state too large',
      unreadable: 'Site knowledge deletion state unreadable',
    });
    try { return journalSchema.parse(JSON.parse(bytes.toString('utf8'))); } catch {
      throw Object.assign(new Error('Invalid site knowledge deletion state'), { code: ERROR_CODES.MEMORY_CORRUPT });
    }
  }

  private async write(journal: Journal, beforeCommit: () => void | Promise<void>): Promise<void> {
    const data = `${JSON.stringify(journal)}\n`;
    if (Buffer.byteLength(data, 'utf8') > MAX_JOURNAL_BYTES) throw new Error('Site knowledge deletion state too large');
    try {
      await atomicReplace(this.file, data, {
        ...this.options, beforeWrite: () => this.prepare(),
        beforeCommit: async () => { await this.prepare(); await beforeCommit(); },
      });
    } catch (error) {
      if (error instanceof AtomicWriteUnconfirmed) {
        throw Object.assign(new Error('Site knowledge deletion state outcome is unknown', { cause: error }), { code: ERROR_CODES.OUTCOME_UNKNOWN });
      }
      throw error;
    }
  }

  async begin(origin: string, validateAuthorization: () => boolean): Promise<void> {
    const key = keyFor(origin);
    if (typeof validateAuthorization !== 'function' || validateAuthorization() !== true) throw new Error('Site knowledge deletion not authorized');
    invalidateKnowledgeEpoch(this.root);
    return serializeKnowledge(this.root, async () => {
      await this.prepare();
      const journal = await this.read();
      if (key === '*') journal.all = true;
      else if (!journal.origins.includes(key)) {
        if (journal.origins.length >= MAX_ORIGINS) throw new Error('Site knowledge deletion state limit reached');
        journal.origins.push(key);
      }
      await this.write(journal, () => {
        if (validateAuthorization() !== true) throw new Error('Site knowledge deletion not authorized');
      });
    });
  }

  /** The verifier executes under the shared lock and must not reacquire it. */
  async complete(origin: string, verifyCleanup: () => Promise<boolean>): Promise<void> {
    const key = keyFor(origin);
    invalidateKnowledgeEpoch(this.root);
    return serializeKnowledge(this.root, async () => {
      await this.prepare();
      const journal = await this.read();
      if (journal.all && key !== '*') throw new Error('Site knowledge deletion remains blocked');
      if (typeof verifyCleanup !== 'function' || await verifyCleanup() !== true) throw new Error('Site knowledge deletion cleanup incomplete');
      if (key === '*') { journal.all = false; journal.origins = []; }
      else journal.origins = journal.origins.filter((entry) => entry !== key);
      await this.write(journal, async () => {
        if (await verifyCleanup() !== true) throw new Error('Site knowledge deletion cleanup incomplete');
      });
    });
  }

  isBlocked(origin: string): Promise<boolean> {
    return serializeKnowledge(this.root, () => this.isBlockedForCommit(origin));
  }

  /** Read-only check for a caller already holding the shared coordinator lock. */
  async isBlockedForCommit(origin: string): Promise<boolean> {
    const key = keyFor(origin);
    if (key === '*') throw new Error('Invalid site knowledge read scope');
    await this.prepare();
    const journal = await this.read();
    return journal.all || journal.origins.includes(key);
  }

  /** True only for a durable delete-all block; call while holding the coordinator lock. */
  async blocksAllForCommit(): Promise<boolean> {
    await this.prepare();
    return (await this.read()).all;
  }
}
