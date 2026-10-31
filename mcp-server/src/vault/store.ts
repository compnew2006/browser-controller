import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import {
  VaultAllowlistEntrySchema, VaultDataSchema, VaultEnvelopeSchema, VAULT_MAX_ALLOWLIST, VAULT_MAX_AUDIT_EVENTS, VAULT_VERSION, randomId,
  type VaultAllowlistEntry, type VaultCredential, type VaultData, type VaultEnvelope,
} from './types.js';
import { pidAlive, reclaimLock, type ReclaimHooks } from '../lock-file.js';
import { VaultStorageError, fileError } from './store-errors.js';
import { assertOwnerMode, readSafeFile, syncDirectory, writeExclusive, writeVaultFile, type VaultWriteContext } from './store-files.js';
import { backupsToPrune, dataFromEnvelope, envelopeFor, parseBackup, parseJson, type BackupPackage, type RestoreJournal } from './store-format.js';
import { ERROR_CODES } from '../core/error-codes.js';

export { VaultStorageError } from './store-errors.js';
export { VAULT_BACKUP_RETENTION } from './store-format.js';

const KEY_BYTES = 32;
const MAX_STORE_BYTES = 8 * 1024 * 1024;
const MAX_BACKUP_BYTES = 10 * 1024 * 1024;
const LOCK_WAIT_MS = 5_000;
const STALE_LOCK_GRACE_MS = 5_000;

export type VaultStoreStatus = 'empty' | 'ready' | 'incomplete';

export function scopeForBrowser(browserId: string): string {
  const id = typeof browserId === 'string' ? browserId.trim() : '';
  if (!id || id.length > 128) throw new VaultStorageError(ERROR_CODES.VAULT_STORAGE_INVALID, 'browser identity is not verified');
  return crypto.createHash('sha256').update(`browser-controller-vault:${id}`, 'utf8').digest('hex');
}

interface StoreOptions {
  stateDir: string;
  browserId: string;
  lockTimeoutMs?: number;
  /** Narrow fault-injection seam for proving pre-commit failures retain the old envelope. */
  beforeCommit?: (file: string) => void | Promise<void>;
  /** Narrow lock-initialization fault seam for verifying failed acquisitions release their file. */
  beforeLockSync?: () => void | Promise<void>;
  /** Test seam for the stale-lock takeover race. */
  lockReclaimHooks?: ReclaimHooks;
  /**
   * The platform whose owner and mode bits are compared. win32 has no comparable mode bits,
   * so the vault's owner rule is applied without them there; the default is the running platform.
   */
  platform?: NodeJS.Platform;
}

/**
 * One browser-scoped AES-GCM store. User data stays encrypted in one atomically
 * replaced envelope; the local key is a separate owner-only file. The service
 * must explicitly call unlock() after construction. No missing/corrupt state is
 * repaired by creating a replacement key.
 */
export class CredentialVaultStore {
  readonly namespace: string;
  readonly directory: string;
  private readonly backups: string;
  private readonly keyPath: string;
  private readonly storePath: string;
  private readonly lockPath: string;
  private readonly restoreJournalPath: string;
  private readonly lockTimeoutMs: number;
  private readonly beforeCommit?: StoreOptions['beforeCommit'];
  private readonly beforeLockSync?: StoreOptions['beforeLockSync'];
  private readonly lockReclaimHooks: ReclaimHooks;
  /** The platform whose owner and mode bits are comparable; win32 has none. */
  private readonly platform: NodeJS.Platform;
  private key: Buffer | null = null;
  private mutationTail: Promise<void> = Promise.resolve();
  /** The vault's own checks and seams, handed to the shared file policy. */
  private readonly writeContext: VaultWriteContext;

  constructor(options: StoreOptions) {
    this.namespace = scopeForBrowser(options.browserId);
    this.directory = path.join(path.resolve(options.stateDir), 'vault', this.namespace);
    this.backups = path.join(this.directory, 'backups');
    this.keyPath = path.join(this.directory, 'key');
    this.storePath = path.join(this.directory, 'store.enc');
    this.lockPath = path.join(this.directory, '.lock');
    this.restoreJournalPath = path.join(this.directory, 'restore.pending');
    this.lockTimeoutMs = options.lockTimeoutMs ?? LOCK_WAIT_MS;
    this.beforeCommit = options.beforeCommit;
    this.beforeLockSync = options.beforeLockSync;
    this.lockReclaimHooks = options.lockReclaimHooks ?? {};
    this.platform = options.platform ?? process.platform;
    this.writeContext = {
      prepare: () => this.ensureDirectories(true),
      exists: (file: string) => this.exists(file),
      beforeCommit: (file: string) => this.beforeCommit?.(file),
      platform: this.platform,
    };
  }

  get isUnlocked(): boolean { return this.key !== null; }

  lock(): void {
    this.key?.fill(0);
    this.key = null;
  }

  async status(): Promise<VaultStoreStatus> {
    await this.ensureDirectories(false);
    if (await this.exists(this.restoreJournalPath)) return 'incomplete';
    const [key, store] = await Promise.all([this.exists(this.keyPath), this.exists(this.storePath)]);
    if (!key && !store) return 'empty';
    if (key && store) return 'ready';
    return 'incomplete';
  }

  async initialize(): Promise<void> {
    await this.withMutationLock(async () => {
      await this.ensureDirectories(true);
      if (await this.exists(this.restoreJournalPath)) throw new VaultStorageError(ERROR_CODES.VAULT_RECOVERY_REQUIRED, 'a private vault restore must be resumed or rolled back');
      const [keyExists, storeExists] = await Promise.all([this.exists(this.keyPath), this.exists(this.storePath)]);
      if (keyExists || storeExists) {
        if (storeExists && !keyExists) throw new VaultStorageError(ERROR_CODES.VAULT_KEY_MISSING, 'the vault key is missing; existing data was preserved');
        throw new VaultStorageError(ERROR_CODES.VAULT_STORAGE_INVALID, 'vault state already exists or is incomplete');
      }
      const key = crypto.randomBytes(KEY_BYTES);
      try {
        await writeExclusive(this.keyPath, key);
        await writeVaultFile(this.storePath, Buffer.from(JSON.stringify(envelopeFor({ version: VAULT_VERSION, entries: [], audit: [] }, this.namespace, key)), 'utf8'), MAX_STORE_BYTES, this.writeContext);
        this.key = Buffer.from(key);
      } catch (error) {
        key.fill(0);
        throw error;
      }
      key.fill(0);
    });
  }

  async unlock(): Promise<void> {
    await this.ensureDirectories(false);
    if (!await this.exists(this.directory)) throw new VaultStorageError(ERROR_CODES.VAULT_LOCKED, 'the vault has not been initialized');
    await this.withFileLock(async () => {
      if (await this.exists(this.restoreJournalPath)) throw new VaultStorageError(ERROR_CODES.VAULT_RECOVERY_REQUIRED, 'a private vault restore must be resumed or rolled back');
      const [keyExists, storeExists] = await Promise.all([this.exists(this.keyPath), this.exists(this.storePath)]);
      if (!keyExists && !storeExists) throw new VaultStorageError(ERROR_CODES.VAULT_LOCKED, 'the vault has not been initialized');
      if (!keyExists) throw new VaultStorageError(ERROR_CODES.VAULT_KEY_MISSING, 'the vault key is missing; existing data was preserved');
      if (!storeExists) throw new VaultStorageError(ERROR_CODES.VAULT_STORAGE_INVALID, 'the encrypted vault file is missing; existing key was preserved');
      const key = await this.readKey();
      try {
        await this.readEnvelope(key);
        this.lock();
        this.key = key;
      } catch (error) {
        key.fill(0);
        throw error;
      }
    });
  }

  async list(): Promise<VaultCredential[]> {
    return (await this.readData()).entries.map((entry) => ({ ...entry }));
  }

  async get(id: string): Promise<VaultCredential | null> {
    const entry = (await this.readData()).entries.find((item) => item.id === id);
    return entry ? { ...entry } : null;
  }

  async upsert(entry: VaultCredential): Promise<void> {
    const parsed = VaultDataSchema.shape.entries.element.safeParse(entry);
    if (!parsed.success) throw new VaultStorageError(ERROR_CODES.INVALID_ARGUMENT, 'credential fields are invalid');
    await this.mutate((data) => {
      const existing = data.entries.findIndex((item) => item.id === parsed.data.id);
      if (existing >= 0) {
        data.entries[existing] = { ...parsed.data, createdAt: data.entries[existing]!.createdAt };
      } else {
        if (data.entries.length >= 1_000) throw new VaultStorageError(ERROR_CODES.VAULT_STORAGE_INVALID, 'vault entry limit reached');
        data.entries.push(parsed.data);
      }
    });
  }

  async remove(id: string): Promise<boolean> {
    let removed = false;
    await this.mutate((data) => {
      const next = data.entries.filter((entry) => entry.id !== id);
      removed = next.length !== data.entries.length;
      data.entries = next;
    });
    return removed;
  }

  /** The owner's allowlisted origins, oldest first. */
  async allowlist(): Promise<VaultAllowlistEntry[]> {
    return ((await this.readData()).allowlist ?? []).map((entry) => ({ ...entry }));
  }

  /** Adds an origin to the allowlist; false when it was already there. */
  async allowlistAdd(origin: string, at: number): Promise<boolean> {
    const parsed = VaultAllowlistEntrySchema.safeParse({ origin, addedAt: at });
    if (!parsed.success) throw new VaultStorageError(ERROR_CODES.INVALID_ARGUMENT, 'the site origin is invalid');
    let added = false;
    await this.mutate((data) => {
      const list = data.allowlist ?? [];
      if (list.some((entry) => entry.origin === parsed.data.origin)) return;
      if (list.length >= VAULT_MAX_ALLOWLIST) throw new VaultStorageError(ERROR_CODES.VAULT_STORAGE_INVALID, 'allowlist limit reached');
      data.allowlist = [...list, parsed.data];
      added = true;
    });
    return added;
  }

  /** Removes an origin; an emptied list leaves the data file in its earlier shape. */
  async allowlistRemove(origin: string): Promise<boolean> {
    let removed = false;
    await this.mutate((data) => {
      const list = data.allowlist ?? [];
      const next = list.filter((entry) => entry.origin !== origin);
      removed = next.length !== list.length;
      if (next.length) data.allowlist = next;
      else delete data.allowlist;
    });
    return removed;
  }

  async audit(event: VaultData['audit'][number]): Promise<void> {
    await this.mutate((data) => {
      data.audit.push(event);
      if (data.audit.length > VAULT_MAX_AUDIT_EVENTS) data.audit.splice(0, data.audit.length - VAULT_MAX_AUDIT_EVENTS);
    });
  }

  async createBackup(now = Date.now()): Promise<{ id: string; createdAt: number }> {
    this.requireKey();
    return this.withMutationLock(async () => {
      await this.ensureDirectories(true);
      const key = await this.readKey();
      try {
        const envelope = await this.readRawEnvelope();
        dataFromEnvelope(envelope, this.namespace, key);
        const id = randomId('bkp');
        const backup: BackupPackage = { version: VAULT_VERSION, namespace: this.namespace, createdAt: now, key: key.toString('base64'), envelope };
        const file = path.join(this.backups, `${id}.json`);
        await writeVaultFile(file, Buffer.from(JSON.stringify(backup), 'utf8'), MAX_BACKUP_BYTES, this.writeContext, true);
        await this.pruneBackups(id);
        return { id, createdAt: now };
      } finally {
        key.fill(0);
      }
    });
  }

  /** Best effort: a prune failure never fails the backup. Only backup files are touched, never the live store or key. */
  private async pruneBackups(keepId: string): Promise<void> {
    try {
      for (const id of backupsToPrune(await this.listBackups(), keepId)) await fs.unlink(path.join(this.backups, `${id}.json`)).catch(() => undefined);
    } catch { /* extra copies only; the next backup retries */ }
  }

  async listBackups(): Promise<Array<{ id: string; createdAt: number }>> {
    await this.ensureDirectories(false);
    try {
      const names = await fs.readdir(this.backups);
      const result: Array<{ id: string; createdAt: number }> = [];
      for (const name of names) {
        if (!/^bkp_[a-f0-9]{32}\.json$/.test(name)) continue;
        const file = path.join(this.backups, name);
        const bytes = await readSafeFile(file, MAX_BACKUP_BYTES, this.platform).catch(() => null);
        if (!bytes) continue;
        const backup = parseBackup(parseJson(bytes, ERROR_CODES.VAULT_STORAGE_INVALID, 'backup metadata is invalid'), this.namespace);
        if (backup) result.push({ id: name.slice(0, -5), createdAt: backup.createdAt });
      }
      return result.sort((a, b) => b.createdAt - a.createdAt);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async restoreBackup(id: string, now = Date.now()): Promise<void> {
    if (!/^bkp_[a-f0-9]{32}$/.test(id)) throw new VaultStorageError(ERROR_CODES.INVALID_ARGUMENT, 'backup id is invalid');
    await this.withMutationLock(async () => {
      await this.ensureDirectories(true);
      if (await this.exists(this.restoreJournalPath)) {
        const pending = await this.readRestoreJournal();
        if (!pending || pending.backupId !== id) throw new VaultStorageError(ERROR_CODES.VAULT_RECOVERY_REQUIRED, 'a different private restore is pending');
        await this.rollbackRestore(pending);
      }
      const backupPath = path.join(this.backups, `${id}.json`);
      const backupBytes = await readSafeFile(backupPath, MAX_BACKUP_BYTES, this.platform);
      const backup = parseBackup(parseJson(backupBytes, ERROR_CODES.VAULT_STORAGE_INVALID, 'backup file is invalid'), this.namespace);
      if (!backup || backup.namespace !== this.namespace) throw new VaultStorageError(ERROR_CODES.VAULT_STORAGE_INVALID, 'backup belongs to another browser namespace');
      const backupKey = Buffer.from(backup.key, 'base64');
      if (backupKey.length !== KEY_BYTES || backupKey.toString('base64') !== backup.key) {
        backupKey.fill(0);
        throw new VaultStorageError(ERROR_CODES.VAULT_STORAGE_INVALID, 'backup key is invalid');
      }
      let restored: VaultData;
      try { restored = dataFromEnvelope(backup.envelope, this.namespace, backupKey); }
      catch (error) { backupKey.fill(0); throw error; }

      let currentKey: Buffer | null = null;
      let previousEnvelope: VaultEnvelope | null = null;
      try {
        const [keyExists, storeExists] = await Promise.all([this.exists(this.keyPath), this.exists(this.storePath)]);
        if (keyExists && storeExists) {
          currentKey = await this.readKey();
          previousEnvelope = await this.readRawEnvelope();
          dataFromEnvelope(previousEnvelope, this.namespace, currentKey);
        }
      } catch {
        // A corrupt or keyless live store can still be recovered from this
        // separately validated explicit backup. Its original files are kept
        // as rollback material until the pair has been replaced successfully.
        currentKey?.fill(0);
        currentKey = null;
        previousEnvelope = null;
      }
      if (currentKey && previousEnvelope) {
        const previousId = randomId('bkp');
        const previousBackup: BackupPackage = { version: VAULT_VERSION, namespace: this.namespace, createdAt: now, key: currentKey.toString('base64'), envelope: previousEnvelope };
        await writeVaultFile(path.join(this.backups, `${previousId}.json`), Buffer.from(JSON.stringify(previousBackup), 'utf8'), MAX_BACKUP_BYTES, this.writeContext, true);
      }

      restored.audit.push({
        id: randomId('audit'), action: 'restore', browserScope: this.namespace, at: now, result: 'success',
      });
      if (restored.audit.length > VAULT_MAX_AUDIT_EVENTS) restored.audit.splice(0, restored.audit.length - VAULT_MAX_AUDIT_EVENTS);
      const nextEnvelope = envelopeFor(VaultDataSchema.parse(restored), this.namespace, backupKey);
      const suffix = crypto.randomBytes(12).toString('hex');
      const journal: RestoreJournal = {
        version: VAULT_VERSION,
        backupId: id,
        hadKey: await this.exists(this.keyPath),
        hadStore: await this.exists(this.storePath),
        stagedKey: `.restore-${suffix}.key.tmp`,
        stagedStore: `.restore-${suffix}.store.tmp`,
        previousKey: `.restore-${suffix}.key.old`,
        previousStore: `.restore-${suffix}.store.old`,
      };
      const stagedKeyPath = path.join(this.directory, journal.stagedKey);
      const stagedStorePath = path.join(this.directory, journal.stagedStore);
      let journalWritten = false;
      try {
        await writeExclusive(stagedKeyPath, backupKey);
        await writeExclusive(stagedStorePath, Buffer.from(JSON.stringify(nextEnvelope), 'utf8'));
        await writeVaultFile(this.restoreJournalPath, Buffer.from(JSON.stringify(journal), 'utf8'), 4_096, this.writeContext, true);
        journalWritten = true;
        await this.commitRestore(journal);
        this.lock();
        this.key = Buffer.from(backupKey);
      } finally {
        currentKey?.fill(0);
        backupKey.fill(0);
        if (!journalWritten) {
          await fs.unlink(stagedKeyPath).catch(() => {});
          await fs.unlink(stagedStorePath).catch(() => {});
        }
      }
    });
  }

  private async readData(): Promise<VaultData> {
    const key = this.requireKey();
    await this.ensureDirectories(false);
    return this.withFileLock(async () => {
      if (await this.exists(this.restoreJournalPath)) throw new VaultStorageError(ERROR_CODES.VAULT_RECOVERY_REQUIRED, 'a private vault restore must be resumed or rolled back');
      return this.readEnvelope(key);
    });
  }

  private async mutate(change: (data: VaultData) => void): Promise<void> {
    this.requireKey();
    await this.withMutationLock(async () => {
      const key = this.requireKey();
      const data = await this.readEnvelope(key);
      change(data);
      const parsed = VaultDataSchema.safeParse(data);
      if (!parsed.success) throw new VaultStorageError(ERROR_CODES.VAULT_STORAGE_INVALID, 'updated vault data is invalid');
      await writeVaultFile(this.storePath, Buffer.from(JSON.stringify(envelopeFor(parsed.data, this.namespace, key)), 'utf8'), MAX_STORE_BYTES, this.writeContext);
    });
  }

  private async readEnvelope(key: Buffer): Promise<VaultData> {
    return dataFromEnvelope(await this.readRawEnvelope(), this.namespace, key);
  }

  private async readRawEnvelope(): Promise<VaultEnvelope> {
    const bytes = await readSafeFile(this.storePath, MAX_STORE_BYTES, this.platform);
    const envelope = parseJson(bytes, ERROR_CODES.VAULT_STORAGE_INVALID, 'encrypted vault file is invalid');
    const parsed = VaultEnvelopeSchema.safeParse(envelope);
    if (!parsed.success || parsed.data.namespace !== this.namespace) {
      throw new VaultStorageError(ERROR_CODES.VAULT_STORAGE_INVALID, 'encrypted vault file is invalid for this browser namespace');
    }
    return parsed.data;
  }

  private async readKey(): Promise<Buffer> {
    const bytes = await readSafeFile(this.keyPath, KEY_BYTES, this.platform);
    if (bytes.length !== KEY_BYTES) throw new VaultStorageError(ERROR_CODES.VAULT_KEY_MISSING, 'the vault key is invalid; existing data was preserved');
    return Buffer.from(bytes);
  }

  private requireKey(): Buffer {
    if (!this.key) throw new VaultStorageError(ERROR_CODES.VAULT_LOCKED, 'unlock the vault in its private extension page');
    return this.key;
  }

  private async readRestoreJournal(): Promise<RestoreJournal | null> {
    let value: unknown;
    try { value = parseJson(await readSafeFile(this.restoreJournalPath, 4_096, this.platform), ERROR_CODES.VAULT_STORAGE_INVALID, 'restore journal is invalid'); }
    catch { return null; }
    if (!value || typeof value !== 'object') return null;
    const journal = value as Partial<RestoreJournal>;
    const safeName = (name: unknown, part: 'key' | 'store', suffix: 'tmp' | 'old') =>
      typeof name === 'string' && new RegExp(`^\\.restore-[a-f0-9]{24}\\.${part}\\.${suffix}$`).test(name);
    if (journal.version !== VAULT_VERSION || typeof journal.backupId !== 'string'
      || !/^bkp_[a-f0-9]{32}$/.test(journal.backupId)
      || typeof journal.hadKey !== 'boolean' || typeof journal.hadStore !== 'boolean'
      || !safeName(journal.stagedKey, 'key', 'tmp') || !safeName(journal.stagedStore, 'store', 'tmp')
      || !safeName(journal.previousKey, 'key', 'old') || !safeName(journal.previousStore, 'store', 'old')) return null;
    return journal as RestoreJournal;
  }

  private restorePaths(journal: RestoreJournal): { stagedKey: string; stagedStore: string; previousKey: string; previousStore: string } {
    return {
      stagedKey: path.join(this.directory, journal.stagedKey),
      stagedStore: path.join(this.directory, journal.stagedStore),
      previousKey: path.join(this.directory, journal.previousKey),
      previousStore: path.join(this.directory, journal.previousStore),
    };
  }

  private async commitRestore(journal: RestoreJournal): Promise<void> {
    const { stagedKey, stagedStore, previousKey, previousStore } = this.restorePaths(journal);
    try {
      if (journal.hadKey && await this.exists(this.keyPath) && !await this.exists(previousKey)) await fs.rename(this.keyPath, previousKey);
      if (journal.hadStore && await this.exists(this.storePath) && !await this.exists(previousStore)) await fs.rename(this.storePath, previousStore);
      if (!await this.exists(this.keyPath)) await fs.rename(stagedKey, this.keyPath);
      if (!await this.exists(this.storePath)) await fs.rename(stagedStore, this.storePath);
      await syncDirectory(this.directory);
      const key = await this.readKey();
      try { await this.readEnvelope(key); } finally { key.fill(0); }
      await fs.unlink(this.restoreJournalPath);
      await syncDirectory(this.directory);
      await Promise.all([fs.unlink(previousKey).catch(() => {}), fs.unlink(previousStore).catch(() => {})]);
      await Promise.all([fs.unlink(stagedKey).catch(() => {}), fs.unlink(stagedStore).catch(() => {})]);
    } catch {
      throw new VaultStorageError(ERROR_CODES.VAULT_RECOVERY_REQUIRED, 'the explicit restore is staged; repeat it in the private vault page to recover safely');
    }
  }

  private async rollbackRestore(journal: RestoreJournal): Promise<void> {
    const { stagedKey, stagedStore, previousKey, previousStore } = this.restorePaths(journal);
    if (journal.hadKey && await this.exists(previousKey)) {
      if (await this.exists(this.keyPath)) await fs.unlink(this.keyPath);
      await fs.rename(previousKey, this.keyPath);
    } else if (!journal.hadKey && await this.exists(this.keyPath)) {
      await fs.unlink(this.keyPath);
    }
    if (journal.hadStore && await this.exists(previousStore)) {
      if (await this.exists(this.storePath)) await fs.unlink(this.storePath);
      await fs.rename(previousStore, this.storePath);
    } else if (!journal.hadStore && await this.exists(this.storePath)) {
      await fs.unlink(this.storePath);
    }
    await Promise.all([fs.unlink(stagedKey).catch(() => {}), fs.unlink(stagedStore).catch(() => {})]);
    await fs.unlink(this.restoreJournalPath).catch(() => {});
    await syncDirectory(this.directory);
  }

  private async exists(file: string): Promise<boolean> {
    try {
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink()) throw new VaultStorageError(ERROR_CODES.VAULT_STORAGE_INVALID, 'vault path cannot be a symbolic link');
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  private async ensureDirectories(create: boolean): Promise<void> {
    const root = path.dirname(path.dirname(this.directory));
    const dirs = [
      { path: root, label: 'state directory', recursive: true },
      { path: path.dirname(this.directory), label: 'vault root', recursive: false },
      { path: this.directory, label: 'vault namespace directory', recursive: false },
      { path: this.backups, label: 'vault backup directory', recursive: false },
    ];
    for (const dir of dirs) {
      if (create) {
        try { await fs.mkdir(dir.path, { recursive: dir.recursive, mode: 0o700 }); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw fileError(ERROR_CODES.VAULT_STORAGE_INVALID, `${dir.label} could not be created safely`);
        }
      }
      try { assertOwnerMode(await fs.lstat(dir.path), 'directory', dir.label, this.platform); }
      catch (error) {
        if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
    }
  }

  private async withMutationLock<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      await this.ensureDirectories(true);
      return await this.withFileLock(work);
    } finally {
      release();
    }
  }

  private async withFileLock<T>(work: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + this.lockTimeoutMs;
    let handle;
    while (!handle) {
      let candidate;
      try {
        candidate = await fs.open(this.lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw fileError(ERROR_CODES.VAULT_STORAGE_INVALID, 'vault lock could not be acquired safely');
        await this.removeStaleLock().catch(() => {});
        if (Date.now() >= deadline) throw new VaultStorageError(ERROR_CODES.VAULT_BUSY, 'another vault operation is still active');
        await new Promise((resolve) => setTimeout(resolve, 10));
        continue;
      }
      try {
        await candidate.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
        await this.beforeLockSync?.();
        await candidate.sync();
        handle = candidate;
      } catch {
        await candidate.close().catch(() => {});
        await fs.unlink(this.lockPath).catch(() => {});
        throw new VaultStorageError(ERROR_CODES.VAULT_STORAGE_INVALID, 'vault lock could not be initialized safely');
      }
    }
    try { return await work(); }
    finally {
      await handle.close().catch(() => {});
      await fs.unlink(this.lockPath).catch(() => {});
    }
  }

  private async removeStaleLock(): Promise<void> {
    const stat = await fs.lstat(this.lockPath);
    assertOwnerMode(stat, 'file', 'vault lock', this.platform);
    if (Date.now() - stat.mtimeMs < STALE_LOCK_GRACE_MS) return;
    const judged = { dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs };
    // A crash between the O_EXCL create and the pid write leaves an empty or
    // torn lock; past the grace period it has no live owner, so it is stale.
    let pid: unknown;
    try { pid = (parseJson(await readSafeFile(this.lockPath, 1024, this.platform), ERROR_CODES.VAULT_STORAGE_INVALID, 'vault lock is invalid') as { pid?: unknown } | null)?.pid; }
    catch { pid = undefined; }
    if (Number.isInteger(pid) && (pid as number) >= 1 && pidAlive(pid as number)) return;
    reclaimLock(this.lockPath, judged, this.lockReclaimHooks);
  }
}
