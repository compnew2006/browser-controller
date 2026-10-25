import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CredentialVaultStore, VaultStorageError } from '../mcp-server/src/vault/store.js';
import type { VaultCredential } from '../mcp-server/src/vault/types.js';

let stateDir: string;
const roots: string[] = [];
const browserId = `test-browser-${process.pid}`;

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
    await fs.chmod(keyPath, 0o644);
    await expect(newStore().then((s) => s.unlock())).rejects.toMatchObject({ code: 'VAULT_STORAGE_INVALID' });
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
