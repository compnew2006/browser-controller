import { ERROR_CODES, formatError } from '../core/error-codes.js';
import { invalidateKnowledgeEpoch, KnowledgeDeletionBusy, serializeKnowledgeDeletion } from './knowledge-coordinator.js';
import { KnowledgeDeletionJournal } from './knowledge-deletion-journal.js';
import { JsonKnowledgeStore } from './knowledge-store.js';

interface DeletionDependencies {
  /** Existing stores' deletion; must be idempotent and report failures. */
  deleteLegacy: (origin: string) => Promise<void>;
  /** Verify existing stores without acquiring the knowledge coordinator lock. */
  verifyLegacy: (origin: string) => Promise<boolean>;
  store?: JsonKnowledgeStore;
}

export type CoordinatedDeletionResult = { success: true } | { success: false; recoveryRequired: boolean; error: string };

/** Internal recovery workflow. Call only from an already-authorized owner action. */
export class KnowledgeDeletionCoordinator {
  private readonly journal: KnowledgeDeletionJournal;
  private readonly store: JsonKnowledgeStore;

  constructor(private readonly memoryDir: string, private readonly deps: DeletionDependencies) {
    this.journal = new KnowledgeDeletionJournal(memoryDir);
    this.store = deps.store ?? new JsonKnowledgeStore(memoryDir);
  }

  async run(origin: string, validateAuthorization: () => boolean): Promise<CoordinatedDeletionResult> {
    try {
      if (typeof validateAuthorization !== 'function' || validateAuthorization() !== true) {
        return { success: false, recoveryRequired: false, error: formatError(ERROR_CODES.ACTION_NOT_CONFIRMED, 'Deletion was not authorized.') };
      }
      return await serializeKnowledgeDeletion(this.memoryDir, async () => {
        try {
          invalidateKnowledgeEpoch(this.memoryDir);
          await this.journal.begin(origin, validateAuthorization);
          if (validateAuthorization() !== true) throw new Error('Deletion authorization expired');
          await this.deps.deleteLegacy(origin);
          if (validateAuthorization() !== true) throw new Error('Deletion authorization expired');
          if (origin === '*') await this.store.deleteAll();
          else await this.store.deleteOrigin(origin);
          if (validateAuthorization() !== true) throw new Error('Deletion authorization expired');
          await this.journal.complete(origin, async () =>
            await this.deps.verifyLegacy(origin) && await this.store.isCleanForCommit(origin));
          return { success: true };
        } catch (error) {
          const code = error && typeof error === 'object' && 'code' in error && error.code === ERROR_CODES.OUTCOME_UNKNOWN
            ? ERROR_CODES.OUTCOME_UNKNOWN : ERROR_CODES.MEMORY_UNAVAILABLE;
          return { success: false, recoveryRequired: true, error: formatError(code, 'Deletion is incomplete; recovery remains required.') };
        }
      });
    } catch (error) {
      if (error instanceof KnowledgeDeletionBusy) {
        return { success: false, recoveryRequired: false, error: formatError(ERROR_CODES.BROWSER_BUSY, 'A deletion is already in progress; retry after it finishes.') };
      }
      return { success: false, recoveryRequired: true, error: formatError(ERROR_CODES.MEMORY_UNAVAILABLE, 'Deletion is incomplete; recovery remains required.') };
    }
  }
}
