/**
 * The vault's file policy: owner-only files, an exclusive create for the key,
 * the errors the vault reports, and the rules a vault file is replaced under.
 * The mechanics live in the shared JSON-store engine (`core/json-store.ts`);
 * this module only says what the vault requires and how it says it.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { fileError, VaultStorageError } from './store-errors.js';
import { ERROR_CODES } from '../core/error-codes.js';
import {
  assertOwnerOnly,
  atomicReplace,
  AtomicWriteUnconfirmed,
  readSafeFile as readBoundedFile,
  syncDirectory as syncDirectoryStrict,
  writeExclusiveFile,
  type OwnerModePolicy,
} from '../core/json-store.js';

/** The vault's rule: a plain file or directory of this user, with no access for others. */
function ownerRule(label: string): OwnerModePolicy {
  return {
    fail: (message) => fileError(ERROR_CODES.VAULT_STORAGE_INVALID, message),
    notRegular: (kind) => `${label} is not a safe ${kind}`,
    foreignOwner: () => `${label} is owned by another user`,
    openPermissions: () => `${label} permissions allow other users`,
    checkOwner: true,
  };
}

/**
 * Owner-only file access for the vault store: a path must be a plain file or directory of this
 * user, with no access for others, and is opened without following a symbolic link.
 */
export function assertOwnerMode(stat: Awaited<ReturnType<typeof fs.lstat>>, kind: 'directory' | 'file', label: string): void {
  assertOwnerOnly(stat, kind, ownerRule(label));
}

export async function readSafeFile(file: string, maxBytes: number): Promise<Buffer> {
  return readBoundedFile(file, maxBytes, {
    fail: (message) => fileError(ERROR_CODES.VAULT_STORAGE_INVALID, message),
    isOwnError: (error) => error instanceof VaultStorageError,
    check: (stat, kind) => assertOwnerMode(stat, kind, 'vault file'),
    unavailable: 'vault file is unavailable',
    tooLarge: 'vault file exceeds the supported size limit',
    unreadable: 'vault file could not be read safely',
  });
}

export async function writeExclusive(file: string, data: Buffer): Promise<void> {
  await writeExclusiveFile(file, data, {
    fail: (message) => fileError(ERROR_CODES.VAULT_STORAGE_INVALID, message),
    message: 'vault file could not be created safely',
  });
}

export async function syncDirectory(directory: string): Promise<void> {
  await syncDirectoryStrict(directory, { fail: () => fileError(ERROR_CODES.VAULT_STORAGE_INVALID, 'vault directory could not be synchronized') });
}

/** What the vault needs from its store to replace a file safely. */
export interface VaultWriteContext {
  /** Creates and checks the vault's directories before the write. */
  prepare: () => Promise<void>;
  /** True when the file is there; a symbolic link is refused instead of reported. */
  exists: (file: string) => Promise<boolean>;
  /** Runs after the temp file is durable and before the rename. */
  beforeCommit?: (file: string) => void | Promise<void>;
}

/**
 * Replaces a vault file through the shared atomic write, under the vault's own
 * rules: an exclusive write never replaces a file that is already there, a
 * replaced file must belong to this user, and a write that committed but could
 * not be confirmed durable is reported as a recovery condition.
 */
export async function writeVaultFile(file: string, data: Buffer, maxBytes: number, context: VaultWriteContext, exclusive = false): Promise<void> {
  if (data.length > maxBytes) throw new VaultStorageError(ERROR_CODES.VAULT_STORAGE_INVALID, 'vault file exceeds the supported size limit');
  try {
    await atomicReplace(file, data, {
      tempName: () => `.vault-${crypto.randomBytes(12).toString('hex')}.tmp`,
      syncDirectory: (directory) => syncDirectory(directory),
      beforeWrite: async () => {
        await context.prepare();
        if (!await context.exists(file)) return;
        if (exclusive) throw new VaultStorageError(ERROR_CODES.VAULT_STORAGE_INVALID, 'backup already exists');
        assertOwnerMode(await fs.lstat(file), 'file', 'vault file');
      },
      beforeCommit: async () => {
        if (exclusive && await context.exists(file)) throw new VaultStorageError(ERROR_CODES.VAULT_STORAGE_INVALID, 'backup already exists');
        await context.beforeCommit?.(file);
      },
    });
  } catch (error) {
    if (error instanceof AtomicWriteUnconfirmed) throw new VaultStorageError(ERROR_CODES.VAULT_RECOVERY_REQUIRED, 'vault replacement completed but durability could not be confirmed');
    if (error instanceof VaultStorageError) throw error;
    throw fileError(ERROR_CODES.VAULT_STORAGE_INVALID, 'atomic vault write failed before replacement');
  }
}
