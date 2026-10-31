import crypto from 'node:crypto';
import { VaultDataSchema, VaultEnvelopeSchema, VAULT_VERSION, type VaultData, type VaultEnvelope } from './types.js';
import { VaultStorageError, fileError } from './store-errors.js';
import { ERROR_CODES, type ErrorCode } from '../core/error-codes.js';

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface BackupPackage {
  version: typeof VAULT_VERSION;
  namespace: string;
  createdAt: number;
  key: string;
  envelope: VaultEnvelope;
}

export interface RestoreJournal {
  version: typeof VAULT_VERSION;
  backupId: string;
  hadKey: boolean;
  hadStore: boolean;
  stagedKey: string;
  stagedStore: string;
  previousKey: string;
  previousStore: string;
}

export function envelopeFor(data: VaultData, namespace: string, key: Buffer): VaultEnvelope {
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(`browser-controller-vault:${VAULT_VERSION}:${namespace}`, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    version: VAULT_VERSION,
    namespace,
    nonce: nonce.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: tag.toString('base64'),
  };
}

export function dataFromEnvelope(value: unknown, namespace: string, key: Buffer): VaultData {
  const envelopeParsed = VaultEnvelopeSchema.safeParse(value);
  if (!envelopeParsed.success) throw fileError(ERROR_CODES.VAULT_STORAGE_INVALID, 'encrypted store envelope is invalid');
  const envelope = envelopeParsed.data;
  if (envelope.namespace !== namespace) throw fileError(ERROR_CODES.VAULT_STORAGE_INVALID, 'encrypted store belongs to another browser namespace');
  try {
    const nonce = Buffer.from(envelope.nonce, 'base64');
    const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
    const tag = Buffer.from(envelope.tag, 'base64');
    if (nonce.length !== NONCE_BYTES || nonce.toString('base64') !== envelope.nonce
      || tag.length !== TAG_BYTES || tag.toString('base64') !== envelope.tag
      || ciphertext.toString('base64') !== envelope.ciphertext) {
      throw fileError(ERROR_CODES.VAULT_STORAGE_INVALID, 'encrypted store envelope encoding is invalid');
    }
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(`browser-controller-vault:${VAULT_VERSION}:${namespace}`, 'utf8'));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    const parsed = VaultDataSchema.safeParse(JSON.parse(plaintext));
    if (!parsed.success) throw fileError(ERROR_CODES.VAULT_STORAGE_INVALID, 'decrypted store data is invalid');
    return parsed.data;
  } catch (error) {
    if (error instanceof VaultStorageError) throw error;
    throw fileError(ERROR_CODES.VAULT_STORAGE_INVALID, 'encrypted store authentication failed');
  }
}

export function parseJson(bytes: Buffer, code: ErrorCode, message: string): unknown {
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw fileError(code, message); }
}

export function parseBackup(value: unknown, namespace: string): BackupPackage | null {
  if (!value || typeof value !== 'object') return null;
  const backup = value as Partial<BackupPackage>;
  if (backup.version !== VAULT_VERSION || backup.namespace !== namespace || typeof backup.createdAt !== 'number'
    || typeof backup.key !== 'string' || !backup.envelope) return null;
  const parsedEnvelope = VaultEnvelopeSchema.safeParse(backup.envelope);
  if (!parsedEnvelope.success) return null;
  return { version: VAULT_VERSION, namespace, createdAt: backup.createdAt, key: backup.key, envelope: parsedEnvelope.data };
}

/**
 * Newest backups kept. A backup embeds the key and every credential it held,
 * so older ones are removed after each new backup instead of piling up.
 */
export const VAULT_BACKUP_RETENTION = 3;

/** Ids to delete: everything past the newest VAULT_BACKUP_RETENTION, never `keepId`. `backups` is newest first. */
export function backupsToPrune(backups: Array<{ id: string }>, keepId: string): string[] {
  return backups.filter((item) => item.id !== keepId).slice(VAULT_BACKUP_RETENTION - 1).map((item) => item.id);
}
