import crypto from 'node:crypto';
import { VaultDataSchema, VaultEnvelopeSchema, VAULT_VERSION, type VaultCredential, type VaultData, type VaultEnvelope } from './types.js';
import { VaultStorageError } from './store-errors.js';

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

function fileError(code: string, message: string): VaultStorageError {
  return new VaultStorageError(code, message);
}

export function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(16).toString('hex')}`;
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
  if (!envelopeParsed.success) throw fileError('VAULT_STORAGE_INVALID', 'encrypted store envelope is invalid');
  const envelope = envelopeParsed.data;
  if (envelope.namespace !== namespace) throw fileError('VAULT_STORAGE_INVALID', 'encrypted store belongs to another browser namespace');
  try {
    const nonce = Buffer.from(envelope.nonce, 'base64');
    const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
    const tag = Buffer.from(envelope.tag, 'base64');
    if (nonce.length !== NONCE_BYTES || nonce.toString('base64') !== envelope.nonce
      || tag.length !== TAG_BYTES || tag.toString('base64') !== envelope.tag
      || ciphertext.toString('base64') !== envelope.ciphertext) {
      throw fileError('VAULT_STORAGE_INVALID', 'encrypted store envelope encoding is invalid');
    }
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(`browser-controller-vault:${VAULT_VERSION}:${namespace}`, 'utf8'));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    const parsed = VaultDataSchema.safeParse(JSON.parse(plaintext));
    if (!parsed.success) throw fileError('VAULT_STORAGE_INVALID', 'decrypted store data is invalid');
    return parsed.data;
  } catch (error) {
    if (error instanceof VaultStorageError) throw error;
    throw fileError('VAULT_STORAGE_INVALID', 'encrypted store authentication failed');
  }
}

export function parseJson(bytes: Buffer, code: string, message: string): unknown {
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
