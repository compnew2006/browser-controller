import { currentKnowledgeEpoch } from './knowledge-coordinator.js';
import { draftBindingSchema, KnowledgeDrafts, type DraftBinding, type KnowledgeDraft } from './knowledge-draft.js';
import { KnowledgeDeletionJournal } from './knowledge-deletion-journal.js';
import { createKnowledgeProposal } from './knowledge-entry.js';
import { JsonKnowledgePolicyStore } from './knowledge-policy-store.js';
import { permitsKnowledge, type KnowledgePolicy } from './knowledge-policy.js';
import { createRelatedSiteProposal, validateKnowledgeRecord, type KnowledgeFile } from './knowledge-record.js';
import { JsonKnowledgeStore } from './knowledge-store.js';
import type { MemoryPolicy } from './policy.js';

/** Supplied by trusted daemon integration, never constructed from tool arguments. */
export interface TrustedKnowledgeContext {
  sessionId: string;
  connectionId: string;
  browserId: string;
  origin: string;
}

interface KnowledgeServiceDependencies {
  /** During commit the resolver must read policy without re-entering the held coordinator lock. */
  currentContext: (phase: 'normal' | 'commit') => Promise<TrustedKnowledgeContext>;
  currentMemoryPolicy: () => MemoryPolicy;
}

interface Snapshot {
  context: TrustedKnowledgeContext;
  policy: KnowledgePolicy;
  record: KnowledgeFile | null;
  epoch: number;
}

function sameContext(a: TrustedKnowledgeContext, b: TrustedKnowledgeContext): boolean {
  return a.sessionId === b.sessionId && a.connectionId === b.connectionId
    && a.browserId === b.browserId && a.origin === b.origin;
}

/** Internal service only: registration, trusted context and owner approval are separate gates. */
export class KnowledgeService {
  private readonly policies: JsonKnowledgePolicyStore;
  private readonly store: JsonKnowledgeStore;
  private readonly deletions: KnowledgeDeletionJournal;
  private readonly drafts = new KnowledgeDrafts();

  constructor(private readonly memoryDir: string, private readonly deps: KnowledgeServiceDependencies) {
    this.policies = new JsonKnowledgePolicyStore(memoryDir);
    this.store = new JsonKnowledgeStore(memoryDir);
    this.deletions = new KnowledgeDeletionJournal(memoryDir);
  }

  private async snapshot(): Promise<Snapshot> {
    const epoch = currentKnowledgeEpoch(this.memoryDir);
    const context = await this.deps.currentContext('normal');
    if (!draftBindingSchema.safeParse({
      ...context, operation: 'add', revision: 0, policyGeneration: 0, deletionGeneration: 0,
    }).success) throw new Error('Site knowledge scope unavailable');
    const policy = await this.policies.get(context.browserId);
    if (!permitsKnowledge(policy, this.deps.currentMemoryPolicy(), context.origin)) {
      throw new Error('Site knowledge unavailable');
    }
    if (await this.deletions.isBlocked(context.origin)) throw new Error('Site knowledge unavailable');
    const record = await this.store.get(context.browserId, context.origin);
    const current = await this.deps.currentContext('normal');
    if (epoch !== currentKnowledgeEpoch(this.memoryDir) || !sameContext(context, current)
        || !permitsKnowledge(policy, this.deps.currentMemoryPolicy(), context.origin)) {
      throw new Error('Site knowledge scope changed');
    }
    return { context, policy, record, epoch };
  }

  private binding(snapshot: Snapshot, operation: 'add' | 'edit' | 'delete'): DraftBinding {
    return {
      ...snapshot.context, operation, revision: snapshot.record?.revision ?? 0,
      policyGeneration: snapshot.policy.generation, deletionGeneration: snapshot.epoch,
    };
  }

  async read(): Promise<KnowledgeFile | null> {
    const snapshot = await this.snapshot();
    if (snapshot.epoch !== currentKnowledgeEpoch(this.memoryDir)) throw new Error('Site knowledge scope changed');
    return snapshot.record;
  }

  async prepareAdd(inputs: unknown[], relatedInputs: unknown[] = []): Promise<KnowledgeDraft> {
    if (!Array.isArray(inputs) || !Array.isArray(relatedInputs) || inputs.length + relatedInputs.length === 0
        || inputs.length + relatedInputs.length > 8) throw new Error('Invalid site knowledge proposal');
    const entries = inputs.map(createKnowledgeProposal);
    const relatedSites = relatedInputs.map(createRelatedSiteProposal);
    const snapshot = await this.snapshot();
    const combinedSites = [...(snapshot.record?.relatedSites ?? []), ...relatedSites];
    validateKnowledgeRecord({
      schemaVersion: 1, browserId: snapshot.context.browserId, origin: snapshot.context.origin,
      revision: (snapshot.record?.revision ?? 0) + 1, updatedAt: new Date().toISOString(),
      entries: [...(snapshot.record?.entries ?? []), ...entries],
      ...(snapshot.record?.relatedSites === undefined && relatedSites.length === 0 ? {} : { relatedSites: combinedSites }),
    });
    return this.drafts.prepare(this.binding(snapshot, 'add'), entries, relatedSites.length ? relatedSites : undefined);
  }

  async prepareEdit(id: string, input: unknown): Promise<KnowledgeDraft> {
    const replacement = createKnowledgeProposal(input);
    const snapshot = await this.snapshot();
    const previous = snapshot.record?.entries.find((entry) => entry.id === id);
    if (!previous) throw new Error('Site knowledge entry unavailable');
    return this.drafts.prepare(this.binding(snapshot, 'edit'), [{
      ...replacement, id: previous.id, createdAt: previous.createdAt, relatedIds: previous.relatedIds,
    }]);
  }

  async prepareDelete(id: string): Promise<KnowledgeDraft> {
    const snapshot = await this.snapshot();
    const previous = snapshot.record?.entries.find((entry) => entry.id === id);
    if (!previous) throw new Error('Site knowledge entry unavailable');
    if (snapshot.record?.entries.some((entry) => entry.id !== id && entry.relatedIds.includes(id))) {
      throw new Error('Site knowledge entry is referenced');
    }
    return this.drafts.prepare(this.binding(snapshot, 'delete'), [previous]);
  }

  async preview(id: string, operation: 'add' | 'edit' | 'delete'): Promise<KnowledgeDraft> {
    try {
      const snapshot = await this.snapshot();
      return this.drafts.preview(id, this.binding(snapshot, operation));
    } catch (error) {
      this.drafts.cancel(id);
      throw error;
    }
  }

  cancel(id: string): void { this.drafts.cancel(id); }

  /** The owner approval callback must come from a qualified trusted channel, never from the agent. */
  private async commit(id: string, operation: 'add' | 'edit' | 'delete', validateOwnerApproval: () => boolean, signal?: AbortSignal): Promise<KnowledgeFile> {
    try {
      const snapshot = await this.snapshot();
      const binding = this.binding(snapshot, operation);
      const draft = this.drafts.preview(id, binding);
      const lease = this.drafts.beginCommit(id, binding, validateOwnerApproval);
      let entries = snapshot.record?.entries ?? [];
      if (operation === 'add') {
        entries = [...entries, ...draft.entries];
      } else {
        const selected = draft.entries[0];
        if (!selected || draft.entries.length !== 1 || !entries.some((entry) => entry.id === selected.id)) {
          throw new Error('Site knowledge entry unavailable');
        }
        if (operation === 'edit') entries = entries.map((entry) => entry.id === selected.id ? selected : entry);
        else {
          if (entries.some((entry) => entry.id !== selected.id && entry.relatedIds.includes(selected.id))) {
            throw new Error('Site knowledge entry is referenced');
          }
          entries = entries.filter((entry) => entry.id !== selected.id);
        }
      }
      const relatedSites = draft.relatedSites?.length
        ? [...(snapshot.record?.relatedSites ?? []), ...draft.relatedSites]
        : snapshot.record?.relatedSites;
      const record: KnowledgeFile = {
        schemaVersion: 1, browserId: binding.browserId, origin: binding.origin,
        revision: binding.revision + 1, updatedAt: new Date().toISOString(),
        entries,
        ...(relatedSites === undefined ? {} : { relatedSites }),
      };
      await this.store.put(record, binding.revision, {
        signal,
        invalidateReaders: operation !== 'add',
        validateCommit: async (commitEpoch) => {
          this.drafts.validateCommit(lease, binding);
          const policy = await this.policies.readForCommit(binding.browserId);
          if (await this.deletions.isBlockedForCommit(binding.origin)) return false;
          const context = await this.deps.currentContext('commit');
          return sameContext(binding, context) && policy.generation === binding.policyGeneration
            && (commitEpoch === binding.deletionGeneration
              || (operation !== 'add' && commitEpoch === binding.deletionGeneration + 1))
            && currentKnowledgeEpoch(this.memoryDir) === commitEpoch
            && permitsKnowledge(policy, this.deps.currentMemoryPolicy(), binding.origin);
        },
        finalizeCommit: () => {
          this.drafts.finishCommit(lease, binding);
          if (!permitsKnowledge(snapshot.policy, this.deps.currentMemoryPolicy(), binding.origin)) {
            throw new Error('Site knowledge unavailable');
          }
        },
      });
      return structuredClone(record);
    } finally {
      this.drafts.cancel(id);
    }
  }

  commitAdd(id: string, validateOwnerApproval: () => boolean, signal?: AbortSignal): Promise<KnowledgeFile> {
    return this.commit(id, 'add', validateOwnerApproval, signal);
  }

  commitEdit(id: string, validateOwnerApproval: () => boolean, signal?: AbortSignal): Promise<KnowledgeFile> {
    return this.commit(id, 'edit', validateOwnerApproval, signal);
  }

  commitDelete(id: string, validateOwnerApproval: () => boolean, signal?: AbortSignal): Promise<KnowledgeFile> {
    return this.commit(id, 'delete', validateOwnerApproval, signal);
  }

  cancelSession(sessionId: string): void { this.drafts.cancelSession(sessionId); }
}
