import { scopeForBrowser, type CredentialVaultStore } from './store.js';
import { decryptPortableArchive, encryptPortableArchive } from './portable-format.js';
import { publicError } from './service-common.js';
import { ERROR_CODES } from '../core/error-codes.js';

export async function exportPortableVault(store: CredentialVaultStore, passphrase: unknown): Promise<Record<string, unknown>> {
  const state = await store.status();
  if (state === 'incomplete') return publicError(ERROR_CODES.VAULT_RECOVERY_REQUIRED);
  if (state !== 'ready' || !store.isUnlocked) return publicError(ERROR_CODES.VAULT_LOCKED);
  const archive = await encryptPortableArchive(await store.snapshotPortableData(), passphrase);
  return { success: true, status: 'portable_export_ready', archive };
}

export async function previewPortableVault(
  store: CredentialVaultStore,
  archive: unknown,
  passphrase: unknown,
): Promise<Record<string, unknown>> {
  const state = await store.status();
  if (state === 'incomplete') return publicError(ERROR_CODES.VAULT_RECOVERY_REQUIRED);
  if (state === 'ready' && !store.isUnlocked) return publicError(ERROR_CODES.VAULT_LOCKED);
  if (!Buffer.isBuffer(archive)) return publicError(ERROR_CODES.INVALID_ARGUMENT);
  const portable = await decryptPortableArchive(archive, passphrase);
  return { success: true, entryCount: portable.entries.length, allowlistCount: portable.allowlist.length };
}

interface PortableImportDependencies {
  store: CredentialVaultStore;
  browserId: string;
  revokeGrants(scope: string): void;
  cancelOperations(scope: string): Promise<void>;
  now(): number;
}

export async function commitPortableVault(
  dependencies: PortableImportDependencies,
  archive: unknown,
  passphrase: unknown,
  confirmReplace: unknown,
): Promise<Record<string, unknown>> {
  if (confirmReplace !== true || !Buffer.isBuffer(archive)) return publicError(ERROR_CODES.INVALID_ARGUMENT);
  const { store } = dependencies;
  const state = await store.status();
  if (state === 'incomplete') return publicError(ERROR_CODES.VAULT_RECOVERY_REQUIRED);
  if (state === 'ready' && !store.isUnlocked) return publicError(ERROR_CODES.VAULT_LOCKED);

  const portable = await decryptPortableArchive(archive, passphrase);
  const scope = scopeForBrowser(dependencies.browserId);
  // Clear approvals before waiting for active fills so no new fill can start during replacement.
  dependencies.revokeGrants(scope);
  await dependencies.cancelOperations(scope);
  const result = await store.replacePortableData(portable, dependencies.now());
  return {
    success: true,
    status: 'imported',
    entryCount: result.entryCount,
    allowlistCount: result.allowlistCount,
  };
}
