import crypto from 'node:crypto';
import { z } from 'zod';
import { ERROR_CODES } from '../core/error-codes.js';
import { fileError, VaultStorageError } from './store-errors.js';
import {
  VaultAllowlistEntrySchema, VaultCredentialSchema, VAULT_MAX_ALLOWLIST, VAULT_MAX_ENTRIES, VAULT_VERSION,
  type VaultData,
} from './types.js';

export const PORTABLE_ARCHIVE_FORMAT = 'browser-controller-vault-portable' as const;
export const PORTABLE_ARCHIVE_VERSION = 1 as const;
export const MAX_PORTABLE_ARCHIVE_BYTES = 10 * 1024 * 1024;
export const MIN_PORTABLE_PASSPHRASE_CODE_POINTS = 12;
export const MAX_PORTABLE_PASSPHRASE_BYTES = 1_024;

const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM_BYTES = 64 * 1024 * 1024;
const SCRYPT_KEY_BYTES = 32;
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const AAD = Buffer.from(`${PORTABLE_ARCHIVE_FORMAT}:${PORTABLE_ARCHIVE_VERSION}`, 'utf8');

const PortableCredentialSchema = VaultCredentialSchema.omit({ id: true }).strict();
const PortableDataSchema = z.object({
  version: z.literal(VAULT_VERSION),
  entries: z.array(PortableCredentialSchema).max(VAULT_MAX_ENTRIES),
  allowlist: z.array(VaultAllowlistEntrySchema).max(VAULT_MAX_ALLOWLIST),
}).strict();

const PortableArchiveSchema = z.object({
  format: z.literal(PORTABLE_ARCHIVE_FORMAT),
  version: z.literal(PORTABLE_ARCHIVE_VERSION),
  kdf: z.object({
    name: z.literal('scrypt'),
    N: z.literal(SCRYPT_N),
    r: z.literal(SCRYPT_R),
    p: z.literal(SCRYPT_P),
    salt: z.string().min(1).max(32),
  }).strict(),
  cipher: z.object({
    name: z.literal('aes-256-gcm'),
    nonce: z.string().min(1).max(24),
    tag: z.string().min(1).max(32),
    ciphertext: z.string().min(1).max(MAX_PORTABLE_ARCHIVE_BYTES),
  }).strict(),
}).strict();

export type PortableVaultData = z.infer<typeof PortableDataSchema>;

function invalidArchive(message = 'portable vault archive is invalid'): Error {
  return fileError(ERROR_CODES.VAULT_STORAGE_INVALID, message);
}

function passphraseBytes(value: unknown): Buffer {
  if (typeof value !== 'string') {
    throw fileError(ERROR_CODES.INVALID_ARGUMENT, 'a portable vault passphrase is required');
  }
  const bytes = Buffer.from(value, 'utf8');
  if ([...value].length < MIN_PORTABLE_PASSPHRASE_CODE_POINTS || bytes.length > MAX_PORTABLE_PASSPHRASE_BYTES) {
    bytes.fill(0);
    throw fileError(ERROR_CODES.INVALID_ARGUMENT, 'portable vault passphrase length is invalid');
  }
  return bytes;
}

function canonicalBase64(value: string, expectedBytes?: number): Buffer {
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || (expectedBytes !== undefined && bytes.length !== expectedBytes)) {
    bytes.fill(0);
    throw invalidArchive('portable vault archive encoding is invalid');
  }
  return bytes;
}

export function validatePortableVaultData(value: unknown): PortableVaultData {
  const parsed = PortableDataSchema.safeParse(value);
  if (!parsed.success) throw invalidArchive('portable vault data is invalid');

  const entryKeys = new Set<string>();
  for (const entry of parsed.data.entries) {
    const key = JSON.stringify([entry.origin, entry.identifier]);
    if (entryKeys.has(key)) throw invalidArchive('portable vault contains duplicate accounts');
    entryKeys.add(key);
  }
  const origins = new Set<string>();
  for (const entry of parsed.data.allowlist) {
    if (origins.has(entry.origin)) throw invalidArchive('portable vault contains duplicate allowed sites');
    origins.add(entry.origin);
  }
  return parsed.data;
}

/** Project only the records that may cross profiles; device-local IDs and audit are omitted. */
export function portableDataFromVault(data: Pick<VaultData, 'entries' | 'allowlist'>): PortableVaultData {
  const value = {
    version: VAULT_VERSION,
    entries: data.entries.map(({ id: _id, ...entry }) => entry),
    allowlist: data.allowlist?.map((entry) => ({ ...entry })) ?? [],
  };
  return validatePortableVaultData(value);
}

function deriveKey(passphrase: Buffer, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(passphrase, salt, SCRYPT_KEY_BYTES, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: SCRYPT_MAXMEM_BYTES,
    }, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

/** Creates a portable encrypted archive using fixed, locally selected cryptographic parameters. */
export async function encryptPortableArchive(data: Pick<VaultData, 'entries' | 'allowlist'>, passphrase: unknown): Promise<Buffer> {
  const portableData = portableDataFromVault(data);
  const password = passphraseBytes(passphrase);
  const salt = crypto.randomBytes(SALT_BYTES);
  const nonce = crypto.randomBytes(NONCE_BYTES);
  let key: Buffer | undefined;
  let plaintext: Buffer | undefined;
  try {
    key = await deriveKey(password, salt);
    plaintext = Buffer.from(JSON.stringify(portableData), 'utf8');
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const archive = Buffer.from(JSON.stringify({
      format: PORTABLE_ARCHIVE_FORMAT,
      version: PORTABLE_ARCHIVE_VERSION,
      kdf: { name: 'scrypt', N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, salt: salt.toString('base64') },
      cipher: {
        name: 'aes-256-gcm',
        nonce: nonce.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64'),
      },
    }), 'utf8');
    ciphertext.fill(0);
    if (archive.length > MAX_PORTABLE_ARCHIVE_BYTES) {
      archive.fill(0);
      throw fileError(ERROR_CODES.RESPONSE_TOO_LARGE, 'portable vault archive exceeds the supported size limit');
    }
    return archive;
  } finally {
    password.fill(0);
    salt.fill(0);
    nonce.fill(0);
    key?.fill(0);
    plaintext?.fill(0);
  }
}

/** Parses, authenticates, and validates a portable archive without accepting archive-chosen work factors. */
export async function decryptPortableArchive(archiveBytes: Buffer, passphrase: unknown): Promise<PortableVaultData> {
  if (!Buffer.isBuffer(archiveBytes) || archiveBytes.length === 0 || archiveBytes.length > MAX_PORTABLE_ARCHIVE_BYTES) {
    throw invalidArchive('portable vault archive size is invalid');
  }
  const password = passphraseBytes(passphrase);
  let salt: Buffer | undefined;
  let nonce: Buffer | undefined;
  let tag: Buffer | undefined;
  let ciphertext: Buffer | undefined;
  let key: Buffer | undefined;
  let plaintext: Buffer | undefined;
  try {
    const text = archiveBytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(archiveBytes)) throw invalidArchive();
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw invalidArchive(); }
    const parsed = PortableArchiveSchema.safeParse(value);
    if (!parsed.success) throw invalidArchive();
    const envelope = parsed.data;
    salt = canonicalBase64(envelope.kdf.salt, SALT_BYTES);
    nonce = canonicalBase64(envelope.cipher.nonce, NONCE_BYTES);
    tag = canonicalBase64(envelope.cipher.tag, TAG_BYTES);
    ciphertext = canonicalBase64(envelope.cipher.ciphertext);
    key = await deriveKey(password, salt);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const plaintextText = plaintext.toString('utf8');
    if (!Buffer.from(plaintextText, 'utf8').equals(plaintext)) throw invalidArchive('portable vault data encoding is invalid');
    let data: unknown;
    try { data = JSON.parse(plaintextText); } catch { throw invalidArchive('portable vault data is invalid'); }
    return validatePortableVaultData(data);
  } catch (error) {
    if (error instanceof VaultStorageError && error.code === ERROR_CODES.INVALID_ARGUMENT) throw error;
    throw invalidArchive('portable vault archive authentication or validation failed');
  } finally {
    password.fill(0);
    salt?.fill(0);
    nonce?.fill(0);
    tag?.fill(0);
    ciphertext?.fill(0);
    key?.fill(0);
    plaintext?.fill(0);
  }
}
