import crypto from 'node:crypto';
import { VaultDataSchema, VAULT_MAX_AUDIT_EVENTS, VAULT_VERSION, randomId, type VaultData, type VaultEnvelope } from './types.js';
import { VaultStorageError } from './store-errors.js';
import { dataFromEnvelope, envelopeFor } from './store-format.js';
import { validatePortableVaultData, type PortableVaultData } from './portable-format.js';
import { ERROR_CODES } from '../core/error-codes.js';

export interface PortableStoreAccess {
  namespace: string;
  keyPath: string;
  storePath: string;
  restoreJournalPath: string;
  hasRuntimeKey(): boolean;
  withMutationLock<T>(work: () => Promise<T>): Promise<T>;
  exists(file: string): Promise<boolean>;
  requireKey(): Buffer;
  readKey(): Promise<Buffer>;
  readRawEnvelope(): Promise<VaultEnvelope>;
  writeBackupSnapshot(now: number, key: Buffer, envelope: VaultEnvelope): Promise<string>;
  stageRestore(backupId: string, key: Buffer, envelope: VaultEnvelope, hadKey: boolean, hadStore: boolean): Promise<void>;
}

export async function replacePortableData(
  access: PortableStoreAccess,
  value: PortableVaultData,
  now: number,
  keyBytes: number,
  maxStoreBytes: number,
): Promise<{ backupId: string; entryCount: number; allowlistCount: number }> {
  const portable = validatePortableVaultData(value);
  return access.withMutationLock(async () => {
    if (await access.exists(access.restoreJournalPath)) {
      throw new VaultStorageError(ERROR_CODES.VAULT_RECOVERY_REQUIRED, 'a private vault restore must be resumed or rolled back');
    }
    const [hadKey, hadStore] = await Promise.all([access.exists(access.keyPath), access.exists(access.storePath)]);
    if (hadKey !== hadStore) throw new VaultStorageError(ERROR_CODES.VAULT_RECOVERY_REQUIRED, 'the destination vault files are incomplete');

    let localKey: Buffer | null = null;
    try {
      let previousData: VaultData;
      let previousEnvelope: VaultEnvelope;
      if (hadKey && hadStore) {
        access.requireKey();
        localKey = await access.readKey();
        previousEnvelope = await access.readRawEnvelope();
        previousData = dataFromEnvelope(previousEnvelope, access.namespace, localKey);
      } else {
        if (access.hasRuntimeKey()) throw new VaultStorageError(ERROR_CODES.VAULT_STORAGE_INVALID, 'the destination vault files changed while unlocked');
        localKey = crypto.randomBytes(keyBytes);
        previousData = { version: VAULT_VERSION, entries: [], audit: [] };
        previousEnvelope = envelopeFor(previousData, access.namespace, localKey);
      }

      const nextData: VaultData = {
        version: VAULT_VERSION,
        entries: portable.entries.map((entry) => ({ ...entry, id: randomId('cred') })),
        audit: [...previousData.audit.slice(-VAULT_MAX_AUDIT_EVENTS), {
          id: randomId('audit'), action: 'restore', browserScope: access.namespace, at: now, result: 'success',
        }],
      };
      if (portable.allowlist.length) nextData.allowlist = portable.allowlist.map((entry) => ({ ...entry }));
      if (nextData.audit.length > VAULT_MAX_AUDIT_EVENTS) nextData.audit.splice(0, nextData.audit.length - VAULT_MAX_AUDIT_EVENTS);
      const validated = VaultDataSchema.safeParse(nextData);
      if (!validated.success) throw new VaultStorageError(ERROR_CODES.VAULT_STORAGE_INVALID, 'portable vault data is invalid for this destination');

      const nextEnvelope = envelopeFor(validated.data, access.namespace, localKey);
      const nextBytes = Buffer.from(JSON.stringify(nextEnvelope), 'utf8');
      const exceedsStoreLimit = nextBytes.length > maxStoreBytes;
      nextBytes.fill(0);
      if (exceedsStoreLimit) {
        throw new VaultStorageError(ERROR_CODES.RESPONSE_TOO_LARGE, 'portable vault data exceeds the local encrypted store limit');
      }
      const backupId = await access.writeBackupSnapshot(now, localKey, previousEnvelope);
      await access.stageRestore(backupId, localKey, nextEnvelope, hadKey, hadStore);
      return { backupId, entryCount: validated.data.entries.length, allowlistCount: validated.data.allowlist?.length ?? 0 };
    } finally {
      localKey?.fill(0);
    }
  });
}
