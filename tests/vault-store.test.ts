import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CredentialVaultStore, VaultStorageError, VAULT_BACKUP_RETENTION } from '../mcp-server/src/vault/store.js';
import type { VaultCredential } from '../mcp-server/src/vault/types.js';

let stateDir: string;
const roots: string[] = [];
const browserId = `test-browser-${process.pid}`;
/** win32 has no comparable owner or mode bits, so the owner rule cannot be checked there. */
const posix = process.platform !== 'win32';

async function newStore(options: { beforeCommit?: (file: string) => void | Promise<void> } = {}) {
  const store = new CredentialVaultStore({ stateDir, browserId, ...options });
  return store;
}

function entry(id: string, password: string): VaultCredential {
  const now = Date.now();
  return {
    id,
    kind: 'login',
    label: 'Fixture account',
    identifier: 'synthetic-user',
    password,
    origin: 'http://127.0.0.1:43210',
    createdAt: now,
    updatedAt: now,
  };
}

async function readAllFiles(directory: string): Promise<Buffer[]> {
  const output: Buffer[] = [];
  for (const item of await fs.readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, item.name);
    if (item.isDirectory()) output.push(...await readAllFiles(full));
    else output.push(await fs.readFile(full));
  }
  return output;
}

beforeEach(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bc-vault-store-'));
  roots.push(stateDir);
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('CredentialVaultStore', () => {
  it('keeps the owner allowlist encrypted, once per origin, and drops the key when it empties (specs/006)', async () => {
    const store = await newStore();
    await store.initialize();
    await expect(store.allowlistAdd('https://example.test/path', 1)).rejects.toThrow(/origin is invalid/);
    expect(await store.allowlistAdd('https://example.test', 5)).toBe(true);
    expect(await store.allowlistAdd('https://example.test', 6)).toBe(false);
    expect(await store.allowlistAdd('http://127.0.0.1:43210', 7)).toBe(true);
    const files = await readAllFiles(path.join(stateDir, 'vault'));
    expect(files.some((bytes) => bytes.includes(Buffer.from('example.test')))).toBe(false);

    store.lock();
    await expect(store.allowlist()).rejects.toThrow(/VAULT_LOCKED/);
    const reopened = await newStore();
    await reopened.unlock();
    expect(await reopened.allowlist()).toEqual([
      { origin: 'https://example.test', addedAt: 5 },
      { origin: 'http://127.0.0.1:43210', addedAt: 7 },
    ]);
    expect(await reopened.allowlistRemove('https://missing.test')).toBe(false);
    expect(await reopened.allowlistRemove('https://example.test')).toBe(true);
    expect(await reopened.allowlistRemove('http://127.0.0.1:43210')).toBe(true);
    expect(await reopened.allowlist()).toEqual([]);
    // An emptied list leaves the data in the shape an earlier daemon can still read.
    const data = await (reopened as unknown as { readData(): Promise<Record<string, unknown>> }).readData();
    expect(data).not.toHaveProperty('allowlist');
  });

  it('encrypts synthetic data at rest and decrypts it only after explicit initialization/unlock', async () => {
    const store = await newStore();
    expect(await store.status()).toBe('empty');
    await expect(store.list()).rejects.toThrow(/VAULT_LOCKED/);
    await store.initialize();
    const password = `synthetic-${crypto.randomBytes(18).toString('hex')}`;
    await store.upsert(entry('cred_0123456789abcdef0123456789abcdef', password));

    const files = await readAllFiles(path.join(stateDir, 'vault'));
    expect(files.some((bytes) => bytes.includes(Buffer.from(password)))).toBe(false);
    expect((await store.list()).map((item) => item.id)).toEqual(['cred_0123456789abcdef0123456789abcdef']);

    store.lock();
    const reopened = await newStore();
    await reopened.unlock();
    expect((await reopened.get('cred_0123456789abcdef0123456789abcdef'))?.password === password).toBe(true);
  });

  it('preserves existing encrypted data when the key is missing or invalid', async () => {
    const store = await newStore();
    await store.initialize();
    await store.upsert(entry('cred_11111111111111111111111111111111', 'synthetic-secret'));
    store.lock();
    const encryptedPath = path.join(store.directory, 'store.enc');
    const before = await fs.readFile(encryptedPath);
    await fs.unlink(path.join(store.directory, 'key'));
    const reopened = await newStore();
    await expect(reopened.unlock()).rejects.toMatchObject({ code: 'VAULT_KEY_MISSING' });
    await expect(reopened.initialize()).rejects.toMatchObject({ code: 'VAULT_KEY_MISSING' });
    expect(await fs.readFile(encryptedPath)).toEqual(before);

    const invalid = await newStore();
    await fs.writeFile(path.join(invalid.directory, 'key'), crypto.randomBytes(3), { mode: 0o600 });
    await expect(invalid.unlock()).rejects.toMatchObject({ code: 'VAULT_KEY_MISSING' });
  });

  it('rejects corrupt envelopes and insecure file permissions without resetting the store', async () => {
    const store = await newStore();
    await store.initialize();
    const storePath = path.join(store.directory, 'store.enc');
    const keyPath = path.join(store.directory, 'key');
    const before = await fs.readFile(storePath);
    await fs.writeFile(storePath, '{bad json', { mode: 0o600 });
    await expect(newStore().then((s) => s.unlock())).rejects.toMatchObject({ code: 'VAULT_STORAGE_INVALID' });
    expect((await fs.readFile(storePath)).equals(Buffer.from('{bad json'))).toBe(true);
    await fs.writeFile(storePath, before, { mode: 0o600 });
    // The owner rule reads mode bits, and only a platform that has them can refuse on them.
    if (posix) {
      await fs.chmod(keyPath, 0o644);
      await expect(newStore().then((s) => s.unlock())).rejects.toMatchObject({ code: 'VAULT_STORAGE_INVALID' });
    }
  });

  it('skips the owner rule where the platform has no mode bits, and enforces it where it has them', async () => {
    const store = await newStore();
    await store.initialize();
    await fs.chmod(path.join(store.directory, 'key'), 0o644);

    // No comparable mode bits: the rule cannot be evaluated, and the vault still works.
    const withoutBits = new CredentialVaultStore({ stateDir, browserId, platform: 'win32' });
    await withoutBits.unlock();

    // Comparable mode bits, open to others: the vault refuses the file.
    const withBits = new CredentialVaultStore({ stateDir, browserId, platform: 'linux' });
    await expect(withBits.unlock()).rejects.toMatchObject({ code: 'VAULT_STORAGE_INVALID' });
  });

  it('refuses symlink store files', async () => {
    const store = await newStore();
    await store.initialize();
    const encryptedPath = path.join(store.directory, 'store.enc');
    const moved = path.join(stateDir, 'outside.enc');
    await fs.rename(encryptedPath, moved);
    await fs.symlink(moved, encryptedPath);
    await expect(newStore().then((s) => s.unlock())).rejects.toMatchObject({ code: 'VAULT_STORAGE_INVALID' });
  });

  it('validates each parent before creating namespace files beneath it', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'bc-vault-outside-'));
    roots.push(outside);
    await fs.symlink(outside, path.join(stateDir, 'vault'));
    const store = await newStore();
    await expect(store.initialize()).rejects.toMatchObject({ code: 'VAULT_STORAGE_INVALID' });
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it('serializes concurrent stores without losing completed entries', async () => {
    const first = await newStore();
    await first.initialize();
    const second = await newStore();
    await second.unlock();
    await Promise.all([
      first.upsert(entry('cred_22222222222222222222222222222222', 'synthetic-first')),
      second.upsert(entry('cred_33333333333333333333333333333333', 'synthetic-second')),
    ]);
    const result = await first.list();
    expect(result.map((item) => item.id).sort()).toEqual([
      'cred_22222222222222222222222222222222',
      'cred_33333333333333333333333333333333',
    ]);
  });

  it('keeps the previous committed envelope after a pre-rename write failure', async () => {
    let failCommit = false;
    const store = await newStore({ beforeCommit: (file) => {
      if (failCommit && file.endsWith('store.enc')) throw new Error('synthetic write interruption');
    } });
    await store.initialize();
    await store.upsert(entry('cred_44444444444444444444444444444444', 'synthetic-before'));
    const before = await fs.readFile(path.join(store.directory, 'store.enc'));
    failCommit = true;
    await expect(store.upsert(entry('cred_55555555555555555555555555555555', 'synthetic-after'))).rejects.toMatchObject({ code: 'VAULT_STORAGE_INVALID' });
    failCommit = false;
    expect((await fs.readFile(path.join(store.directory, 'store.enc'))).equals(before)).toBe(true);
    expect((await store.list()).map((item) => item.id)).toEqual(['cred_44444444444444444444444444444444']);
  });

  it('closes and removes the lock file when lock initialization fails', async () => {
    let failLock = false;
    const store = await newStore({ beforeLockSync: () => {
      if (failLock) throw new Error('synthetic lock interruption');
    } });
    await store.initialize();
    failLock = true;
    await expect(store.upsert(entry('cred_99999999999999999999999999999999', 'synthetic-lock'))).rejects.toMatchObject({ code: 'VAULT_STORAGE_INVALID' });
    await expect(fs.access(path.join(store.directory, '.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
    failLock = false;
    expect(await store.list()).toEqual([]);
  });

  it('creates protected explicit backups and restores by backup handle only', async () => {
    const store = await newStore();
    await store.initialize();
    const password = `synthetic-${crypto.randomBytes(18).toString('hex')}`;
    await store.upsert(entry('cred_66666666666666666666666666666666', password));
    const backup = await store.createBackup(10);
    await store.upsert(entry('cred_77777777777777777777777777777777', 'synthetic-later'));
    const backupNames = await fs.readdir(path.join(store.directory, 'backups'));
    expect(backupNames).toEqual([`${backup.id}.json`]);
    const backupData = JSON.parse((await fs.readFile(path.join(store.directory, 'backups', backupNames[0]!))).toString('utf8'));
    expect(backupData.namespace === store.namespace).toBe(true);
    expect(typeof backupData.envelope?.ciphertext === 'string').toBe(true);
    expect(await store.listBackups()).toEqual([backup]);

    const files = await readAllFiles(path.join(store.directory, 'backups'));
    expect(files.some((bytes) => bytes.includes(Buffer.from(password)))).toBe(false);
    await store.restoreBackup(backup.id, 20);
    expect((await store.list()).map((item) => item.id)).toEqual(['cred_66666666666666666666666666666666']);
    await expect(store.restoreBackup('../key')).rejects.toBeInstanceOf(VaultStorageError);
    expect((await store.listBackups()).length).toBe(2);
  });

  it('keeps only the newest backups after a new backup, and leaves the live vault and key alone', async () => {
    const store = await newStore();
    await store.initialize();
    await store.upsert(entry('cred_88888888888888888888888888888888', 'synthetic-retain'));
    const made: string[] = [];
    for (let i = 0; i < VAULT_BACKUP_RETENTION + 2; i++) made.push((await store.createBackup(100 + i)).id);
    const kept = (await store.listBackups()).map((item) => item.id);
    expect(kept).toEqual(made.slice(2).reverse());
    expect((await fs.readdir(path.join(store.directory, 'backups'))).sort()).toEqual(kept.map((id) => `${id}.json`).sort());
    expect((await store.list()).map((item) => item.id)).toEqual(['cred_88888888888888888888888888888888']);
    await fs.access(path.join(store.directory, 'key'));
    await store.restoreBackup(kept[0]!, 500);
    expect((await store.list()).length).toBe(1);
  });

  it('a backup prune failure does not fail the backup', async () => {
    const store = await newStore();
    await store.initialize();
    for (let i = 0; i < VAULT_BACKUP_RETENTION; i++) await store.createBackup(200 + i);
    const unlink = vi.spyOn(fs, 'unlink').mockRejectedValue(Object.assign(new Error('EPERM'), { code: 'EPERM' }));
    try {
      const latest = await store.createBackup(300);
      expect((await store.listBackups())[0]!.id).toBe(latest.id);
      expect(unlink).toHaveBeenCalled();
    } finally {
      unlink.mockRestore();
    }
    expect((await store.listBackups()).length).toBe(VAULT_BACKUP_RETENTION + 1);
  });

  it('restores explicitly from a valid backup when the local key is missing or the live envelope is corrupt', async () => {
    const store = await newStore();
    await store.initialize();
    await store.upsert(entry('cred_88888888888888888888888888888888', 'synthetic-recovery'));
    const backup = await store.createBackup(30);
    store.lock();
    await fs.unlink(path.join(store.directory, 'key'));

    const recovery = await newStore();
    await recovery.restoreBackup(backup.id, 31);
    expect((await recovery.get('cred_88888888888888888888888888888888'))?.password === 'synthetic-recovery').toBe(true);

    recovery.lock();
    await fs.writeFile(path.join(recovery.directory, 'store.enc'), '{corrupt', { mode: 0o600 });
    const secondRecovery = await newStore();
    await secondRecovery.restoreBackup(backup.id, 32);
    expect((await secondRecovery.get('cred_88888888888888888888888888888888'))?.password === 'synthetic-recovery').toBe(true);
  });
});

describe('vault lock reclaim (audit F5-1, F5-2, F5-7)', () => {
  const DEAD_PID = 2_147_483_646;

  async function lockedStore(options: Record<string, unknown> = {}) {
    const store = new CredentialVaultStore({ stateDir, browserId, lockTimeoutMs: 400, ...options });
    await store.initialize();
    return { store, lockPath: path.join(store.directory, '.lock') };
  }

  async function plantLock(lockPath: string, content: string, ageMs: number) {
    await fs.writeFile(lockPath, content, { mode: 0o600 });
    const when = new Date(Date.now() - ageMs);
    await fs.utimes(lockPath, when, when);
  }

  const fixture = () => entry('cred_11111111111111111111111111111111', 'synthetic-lock-pw');

  it('reclaims a stale lock of a dead pid', async () => {
    const { store, lockPath } = await lockedStore();
    await plantLock(lockPath, JSON.stringify({ pid: DEAD_PID, createdAt: 1 }), 60_000);
    await store.upsert(fixture());
    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not reclaim an old lock held by a live pid', async () => {
    const { store, lockPath } = await lockedStore();
    await plantLock(lockPath, JSON.stringify({ pid: process.pid, createdAt: 1 }), 60_000);
    await expect(store.upsert(fixture())).rejects.toMatchObject({ code: 'VAULT_BUSY' });
    expect(JSON.parse(await fs.readFile(lockPath, 'utf8')).pid).toBe(process.pid);
  });

  it('keeps an empty lock inside the grace period', async () => {
    const { store, lockPath } = await lockedStore();
    await plantLock(lockPath, '', 0);
    await expect(store.upsert(fixture())).rejects.toMatchObject({ code: 'VAULT_BUSY' });
    await expect(fs.access(lockPath)).resolves.toBeUndefined();
  });

  it('reclaims an empty lock after the grace period instead of staying busy forever', async () => {
    const { store, lockPath } = await lockedStore();
    await plantLock(lockPath, '', 60_000);
    await store.upsert(fixture());
    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reclaims an unparseable lock after the grace period', async () => {
    const { store, lockPath } = await lockedStore();
    await plantLock(lockPath, '{"pid":', 60_000);
    await store.upsert(fixture());
  });

  it('two reclaimers on one stale lock: the loser must not remove the winner lock', async () => {
    let fired = false;
    const { store, lockPath } = await lockedStore({
      lockReclaimHooks: {
        beforeRename: () => {
          if (fired) return;
          fired = true;
          // Winner takes over between our judgement and our removal; built
          // beside the old file so the inode cannot be reused.
          const winner = `${lockPath}.winner`;
          fsSync.writeFileSync(winner, JSON.stringify({ pid: process.pid, createdAt: Date.now() }), { mode: 0o600 });
          fsSync.renameSync(winner, lockPath);
        },
      },
    });
    await plantLock(lockPath, JSON.stringify({ pid: DEAD_PID, createdAt: 1 }), 60_000);
    // The winner's lock is alive (our pid) and recent enough that it is never reclaimed.
    await expect(store.upsert(fixture())).rejects.toMatchObject({ code: 'VAULT_BUSY' });
    expect(fired).toBe(true);
    expect(JSON.parse(await fs.readFile(lockPath, 'utf8')).pid).toBe(process.pid);
  });
});
