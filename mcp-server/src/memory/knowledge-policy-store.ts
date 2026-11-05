import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { AtomicWriteUnconfirmed, atomicReplace, errorCode, readSafeFile, type AtomicReplaceOptions, type FileStat } from '../core/json-store.js';
import { ERROR_CODES } from '../core/error-codes.js';
import { assertPrivate } from './record-files.js';
import { canonicalOrigin, MAX_EXCLUDED_ORIGINS } from './policy.js';
import { defaultKnowledgePolicy, type KnowledgePolicy } from './knowledge-policy.js';
import { invalidateKnowledgeEpoch, serializeKnowledge } from './knowledge-coordinator.js';

const MAX_BYTES = 4 * 1024 * 1024;
const policySchema = z.object({
  enabled: z.boolean(),
  excluded: z.array(z.string().max(2048).refine((value) => canonicalOrigin(value) === value)).max(MAX_EXCLUDED_ORIGINS),
  generation: z.number().int().nonnegative().safe(),
}).strict().refine((value) => new Set(value.excluded).size === value.excluded.length);
const fileSchema = z.object({ schemaVersion: z.literal(1), browserId: z.string(), policy: policySchema }).strict();

function requireBrowser(browserId: string): void {
  if (typeof browserId !== 'string' || browserId.length === 0 || browserId.length > 64
      || browserId === 'default' || /[\p{Cc}\p{Cf}]/u.test(browserId)) {
    throw new Error('Invalid site knowledge profile');
  }
}

/** Persistence only. A caller must enforce owner approval before changing policy. */
export class JsonKnowledgePolicyStore {
  private readonly root: string;
  private readonly directory: string;

  constructor(memoryDir: string, private readonly options: Pick<AtomicReplaceOptions, 'afterTempWrite'> = {}) {
    this.root = path.resolve(memoryDir);
    this.directory = path.join(this.root, 'knowledge-policy');
  }

  private async prepare(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    assertPrivate(await fs.lstat(this.root), 'directory', process.platform);
    await fs.mkdir(this.directory, { mode: 0o700 }).catch((error: unknown) => {
      if (errorCode(error) !== 'EEXIST') throw error;
    });
    assertPrivate(await fs.lstat(this.directory), 'directory', process.platform);
  }

  private filename(browserId: string): string {
    return path.join(this.directory, `${crypto.createHash('sha256').update(browserId).digest('hex')}.json`);
  }

  private async read(browserId: string): Promise<KnowledgePolicy> {
    const file = this.filename(browserId);
    try { await fs.lstat(file); } catch (error) {
      if (errorCode(error) === 'ENOENT') return defaultKnowledgePolicy();
      throw new Error('Site knowledge policy unavailable', { cause: error });
    }
    const bytes = await readSafeFile(file, MAX_BYTES, {
      fail: (message) => new Error(message), isOwnError: () => false,
      check: (stat: FileStat, kind) => assertPrivate(stat as import('node:fs').Stats, kind, process.platform),
      unavailable: 'Site knowledge policy unavailable', tooLarge: 'Site knowledge policy too large',
      unreadable: 'Site knowledge policy unreadable',
    });
    let value: z.infer<typeof fileSchema>;
    try { value = fileSchema.parse(JSON.parse(bytes.toString('utf8'))); } catch {
      throw new Error('Invalid site knowledge policy');
    }
    if (value.browserId !== browserId) throw new Error('Site knowledge policy scope mismatch');
    return value.policy;
  }

  get(browserId: string): Promise<KnowledgePolicy> {
    return serializeKnowledge(this.root, () => this.readForCommit(browserId));
  }

  /** For a commit guard already executing inside serializeKnowledge; not an authorization boundary. */
  async readForCommit(browserId: string): Promise<KnowledgePolicy> {
    requireBrowser(browserId);
    await this.prepare();
    return structuredClone(await this.read(browserId));
  }

  async put(browserId: string, policy: KnowledgePolicy, expectedGeneration: number, options: { validateApproval: () => boolean }): Promise<void> {
    if (typeof options?.validateApproval !== 'function' || options.validateApproval() !== true) {
      throw new Error('Site knowledge policy change not authorized');
    }
    // Invalidate pending writes immediately, before waiting for the shared queue.
    invalidateKnowledgeEpoch(this.root);
    return serializeKnowledge(this.root, async () => {
      if (typeof options?.validateApproval !== 'function' || options.validateApproval() !== true) {
        throw new Error('Site knowledge policy change not authorized');
      }
      requireBrowser(browserId);
      const valid = policySchema.safeParse(policy);
      if (!valid.success || !Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0
          || valid.data.generation !== expectedGeneration + 1) throw new Error('Invalid site knowledge policy');
      await this.prepare();
      const current = await this.read(browserId);
      if (current.generation !== expectedGeneration) throw new Error('Stale site knowledge policy');
      const data = `${JSON.stringify({ schemaVersion: 1, browserId, policy: valid.data })}\n`;
      if (Buffer.byteLength(data, 'utf8') > MAX_BYTES) throw new Error('Site knowledge policy too large');
      try {
        await atomicReplace(this.filename(browserId), data, {
          afterTempWrite: this.options.afterTempWrite,
          beforeWrite: () => this.prepare(),
          beforeCommit: async () => {
            await this.prepare();
            if (options.validateApproval() !== true) throw new Error('Site knowledge policy change not authorized');
          },
        });
      } catch (error) {
        if (error instanceof AtomicWriteUnconfirmed) {
          throw Object.assign(new Error('Site knowledge policy outcome is unknown', { cause: error }), {
            code: ERROR_CODES.OUTCOME_UNKNOWN,
          });
        }
        throw error;
      }
    });
  }
}
