import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { fileError, VaultStorageError } from './store-errors.js';

/**
 * Owner-only file access for the vault store: a path must be a plain file or directory of this
 * user, with no access for others, and is opened without following a symbolic link.
 */

function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

export function assertOwnerMode(stat: Awaited<ReturnType<typeof fs.lstat>>, kind: 'directory' | 'file', label: string): void {
  if (stat.isSymbolicLink() || (kind === 'directory' ? !stat.isDirectory() : !stat.isFile())) {
    throw fileError('VAULT_STORAGE_INVALID', `${label} is not a safe ${kind}`);
  }
  const uid = currentUid();
  if (uid !== undefined && stat.uid !== uid) throw fileError('VAULT_STORAGE_INVALID', `${label} is owned by another user`);
  if ((Number(stat.mode) & 0o077) !== 0) throw fileError('VAULT_STORAGE_INVALID', `${label} permissions allow other users`);
}

export async function readSafeFile(file: string, maxBytes: number): Promise<Buffer> {
  let before;
  try { before = await fs.lstat(file); }
  catch { throw fileError('VAULT_STORAGE_INVALID', 'vault file is unavailable'); }
  assertOwnerMode(before, 'file', 'vault file');
  if (before.size > maxBytes) throw new VaultStorageError('VAULT_STORAGE_INVALID', 'vault file exceeds the supported size limit');
  let handle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const after = await handle.stat();
    assertOwnerMode(after, 'file', 'vault file');
    if (after.size > maxBytes) throw new VaultStorageError('VAULT_STORAGE_INVALID', 'vault file exceeds the supported size limit');
    return await handle.readFile();
  } catch (error) {
    if (error instanceof VaultStorageError) throw error;
    throw fileError('VAULT_STORAGE_INVALID', 'vault file could not be read safely');
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function writeExclusive(file: string, data: Buffer): Promise<void> {
  let handle;
  try {
    handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    await handle.writeFile(data);
    await handle.sync();
  } catch (error) {
    throw fileError('VAULT_STORAGE_INVALID', 'vault file could not be created safely');
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await fs.open(directory, constants.O_RDONLY);
    try { await handle.sync(); } finally { await handle.close(); }
  } catch (error) {
    if (process.platform === 'win32') return;
    throw fileError('VAULT_STORAGE_INVALID', 'vault directory could not be synchronized');
  }
}
