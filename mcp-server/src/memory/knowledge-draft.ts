import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { knowledgeEntrySchema, type KnowledgeEntry } from './knowledge-entry.js';
import { canonicalOrigin } from './policy.js';

const TTL_MS = 5 * 60 * 1000;
const MAX_DRAFTS = 128;
const MAX_PREVIEW_BYTES = 4 * 1024;
const safeId = (value: string) => !/[\p{Cc}\p{Cf}]/u.test(value);
export const draftBindingSchema = z.object({
  sessionId: z.string().min(1).max(128).refine(safeId),
  connectionId: z.string().min(1).max(128).refine(safeId),
  browserId: z.string().min(1).max(64).refine((value) => value !== 'default' && safeId(value)),
  origin: z.string().max(2048).refine((value) => canonicalOrigin(value) === value),
  operation: z.enum(['add', 'edit', 'delete', 'export']),
  revision: z.number().int().nonnegative().safe(),
  policyGeneration: z.number().int().nonnegative().safe(),
  deletionGeneration: z.number().int().nonnegative().safe(),
}).strict();

export type DraftBinding = z.infer<typeof draftBindingSchema>;
export interface KnowledgeDraft {
  id: string;
  createdAt: string;
  expiresAt: string;
  binding: DraftBinding;
  entries: KnowledgeEntry[];
  digest: string;
}

export type CommitLease = object;

/** In-memory lifecycle only. The caller obtains owner approval and re-derives the trusted binding. */
export class KnowledgeDrafts {
  private readonly drafts = new Map<string, KnowledgeDraft>();
  private readonly deadlines = new Map<string, number>();
  private readonly reserved = new Map<string, CommitLease>();
  private readonly leases = new WeakMap<CommitLease, { id: string; validateApproval: () => boolean }>();

  constructor(private readonly now: () => number = Date.now, private readonly monotonic: () => number = () => performance.now()) {}

  private discard(id: string): void {
    const lease = this.reserved.get(id);
    if (lease) this.leases.delete(lease);
    this.reserved.delete(id);
    this.drafts.delete(id);
    this.deadlines.delete(id);
  }

  prepare(binding: DraftBinding, entries: KnowledgeEntry[]): KnowledgeDraft {
    const validatedBinding = draftBindingSchema.safeParse(binding);
    const validatedEntries = z.array(knowledgeEntrySchema).min(1).max(8).safeParse(entries);
    if (!validatedBinding.success || !validatedEntries.success) throw new Error('Invalid site knowledge draft');
    const ids = new Set(validatedEntries.data.map((entry) => entry.id));
    if (ids.size !== validatedEntries.data.length) throw new Error('Invalid site knowledge draft');
    const canonical = JSON.stringify({ binding: validatedBinding.data, entries: validatedEntries.data });
    if (Buffer.byteLength(canonical, 'utf8') > MAX_PREVIEW_BYTES) throw new Error('Site knowledge preview exceeds limit');
    const timestamp = this.now();
    const elapsed = this.monotonic();
    if (!Number.isFinite(timestamp) || !Number.isFinite(elapsed)) throw new Error('Invalid site knowledge clock');
    for (const [id, draft] of this.drafts) {
      const deadline = this.deadlines.get(id);
      if (deadline === undefined || deadline <= elapsed || Date.parse(draft.expiresAt) <= timestamp) this.discard(id);
    }
    if (this.drafts.size >= MAX_DRAFTS) throw new Error('Site knowledge draft limit reached');
    const draft: KnowledgeDraft = {
      id: randomUUID(), createdAt: new Date(timestamp).toISOString(), expiresAt: new Date(timestamp + TTL_MS).toISOString(),
      binding: validatedBinding.data, entries: validatedEntries.data,
      digest: createHash('sha256').update(canonical).digest('hex'),
    };
    this.drafts.set(draft.id, structuredClone(draft));
    this.deadlines.set(draft.id, elapsed + TTL_MS);
    return structuredClone(draft);
  }

  private require(id: string, current: DraftBinding): KnowledgeDraft {
    const draft = this.drafts.get(id);
    if (!draft) throw new Error('Site knowledge draft unavailable');
    const validated = draftBindingSchema.safeParse(current);
    const timestamp = this.now();
    const elapsed = this.monotonic();
    const deadline = this.deadlines.get(id);
    if (!validated.success || !Number.isFinite(timestamp) || !Number.isFinite(elapsed) || deadline === undefined
        || elapsed < deadline - TTL_MS || elapsed >= deadline || timestamp >= Date.parse(draft.expiresAt)
        || JSON.stringify(validated.data) !== JSON.stringify(draft.binding)) {
      this.discard(id);
      throw new Error('Site knowledge draft expired or changed');
    }
    return draft;
  }

  preview(id: string, current: DraftBinding): KnowledgeDraft {
    return structuredClone(this.require(id, current));
  }

  /** The callback is internal; a request parameter or agent statement is never owner approval. */
  consume(id: string, current: DraftBinding, validateApproval: () => boolean): KnowledgeDraft {
    const lease = this.beginCommit(id, current, validateApproval);
    return this.finishCommit(lease, current);
  }

  beginCommit(id: string, current: DraftBinding, validateApproval: () => boolean): CommitLease {
    this.require(id, current);
    if (this.reserved.has(id)) throw new Error('Site knowledge draft already in use');
    const lease = Object.freeze({});
    this.reserved.set(id, lease);
    this.leases.set(lease, { id, validateApproval });
    this.validateCommit(lease, current);
    return lease;
  }

  validateCommit(lease: CommitLease, current: DraftBinding): boolean {
    const state = this.leases.get(lease);
    if (!state || this.reserved.get(state.id) !== lease) throw new Error('Site knowledge approval unavailable');
    this.require(state.id, current);
    let approved = false;
    try { approved = typeof state.validateApproval === 'function' && state.validateApproval() === true; } catch { /* fail closed */ }
    if (!approved) {
      this.discard(state.id);
      throw new Error('Site knowledge approval unavailable');
    }
    return true;
  }

  finishCommit(lease: CommitLease, current: DraftBinding): KnowledgeDraft {
    this.validateCommit(lease, current);
    const state = this.leases.get(lease)!;
    const draft = this.require(state.id, current);
    this.discard(state.id);
    return structuredClone(draft);
  }

  cancel(id: string): void { this.discard(id); }
  cancelSession(sessionId: string): void {
    for (const [id, draft] of this.drafts) {
      if (draft.binding.sessionId === sessionId) this.discard(id);
    }
  }
  clear(): void { for (const id of this.drafts.keys()) this.discard(id); }
}
