/**
 * The shared mechanics of every JSON file store in this product.
 *
 * The website-memory store, the site-map store and the credential vault keep
 * their data in JSON files that are replaced atomically, checked for
 * owner-only permissions, read under a size bound and swept of the temp files
 * a crash left behind. Those mechanics used to be written three times, once
 * per store, and the copies drifted apart. They live here now.
 *
 * This module owns the mechanics only. Every store passes in its own policy:
 * which error it raises, how strict its permission rule is, where its files
 * live and how large they may be. It depends on nothing but the node builtins,
 * so it may not know what a memory store or a vault store is.
 */
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import { constants } from 'node:fs';
import type { BigIntStats, Stats } from 'node:fs';
import path from 'node:path';

/** The stat of a path, with or without bigint fields. */
export type FileStat = Stats | BigIntStats;

const RENAME_RETRIES = 3;
const RENAME_BACKOFF_MS = 50;
const RETRYABLE_RENAME_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES']);

/** The errno code of a failure, when it has one. */
export function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * Is the file simply gone, rather than unreadable?
 *
 * A permission problem is an error on every platform: EACCES means the file
 * is there and this process may not read it, which must fail closed. The
 * ambiguous Windows sharing errors are not decided here, because the error
 * code alone cannot tell a delete racing a read from a locked file. Use
 * `isGoneAfterError` where the file's own path is known.
 */
export function isVanished(error: unknown): boolean {
  return errorCode(error) === 'ENOENT';
}

/**
 * Did the file go away, or is it still there and merely unreadable?
 *
 * A delete that races a read removes the file under the reader's feet. On
 * POSIX the read then fails with ENOENT, but on Windows a file that is being
 * deleted cannot be opened at all: the open fails with EPERM (or EACCES, or
 * EBUSY) even though the file is on its way out. A permission problem looks
 * the same from the error code alone, so this asks the filesystem instead of
 * guessing: if the file is gone now, the record is gone and the read answers
 * "no record"; if it is still there, it exists and this process may not read
 * it, which must fail closed.
 */
export async function isGoneAfterError(error: unknown, file: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  if (isVanished(error)) return true;
  if (platform !== 'win32') return false;
  const code = errorCode(error);
  if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') return false;
  try {
    await fsp.lstat(file);
    return false;
  } catch (statError) {
    return isVanished(statError);
  }
}

/** A write that was abandoned after its temp file was durable but before the rename. */
export class AtomicWriteAborted extends Error {
  constructor() {
    super('atomic write aborted before rename');
    this.name = 'AtomicWriteAborted';
  }
}

/**
 * The file was replaced, but the directory could not be made durable, so the
 * write cannot be confirmed. A store that must know whether its data survived
 * a crash reports this as a recovery condition.
 */
export class AtomicWriteUnconfirmed extends Error {
  constructor(cause?: unknown) {
    super('the file was replaced but its durability could not be confirmed', cause === undefined ? undefined : { cause });
    this.name = 'AtomicWriteUnconfirmed';
  }
}

/** The seams a store passes to the shared atomic write. */
export interface AtomicWriteOptions {
  platform?: NodeJS.Platform;
  rename?: (from: string, to: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  /** Checked after the temp file is durable and before the rename; an aborted write removes its temp file. */
  signal?: AbortSignal;
  /** Test seam: runs after the temp file is fsynced and before the abort check. */
  afterTempWrite?: (tempPath: string) => Promise<void>;
}

/** What the shared atomic write needs from the store that owns the file. */
export interface AtomicReplaceOptions extends AtomicWriteOptions {
  /** Creates the target's directory when it is missing. */
  createDirectory?: boolean;
  /** The name of the temp file; it must live in the target's directory. */
  tempName?: (target: string) => string;
  /** Runs before the temp file is written: the store checks the target it is about to replace. */
  beforeWrite?: (target: string) => Promise<void>;
  /** Runs after the temp file is durable and before the rename. */
  beforeCommit?: (target: string) => void | Promise<void>;
  /** Makes the target's directory durable after the rename. */
  syncDirectory?: (dir: string, platform?: NodeJS.Platform) => Promise<void>;
}

/**
 * The temp file name a store gets for free: the target's name with the
 * process id and a random token, so two writers never share one temp file.
 */
function defaultTempName(target: string): string {
  return `${path.basename(target)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
}

async function renameWithRetry(from: string, to: string, options: AtomicWriteOptions): Promise<void> {
  const rename = options.rename ?? fsp.rename;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const retries = (options.platform ?? process.platform) === 'win32' ? RENAME_RETRIES : 0;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= retries || !code || !RETRYABLE_RENAME_CODES.has(code)) throw error;
      await sleep(RENAME_BACKOFF_MS);
    }
  }
}

/**
 * Replace `target` with `data` atomically: a temp file in the same directory
 * (0o600) → fsync → close → rename over the target → directory fsync.
 *
 * Any failure before the rename leaves the previous file untouched and removes
 * the temp file. A failure after the rename means the data is committed but
 * not confirmed, which is reported as `AtomicWriteUnconfirmed`. The rename is
 * retried on Windows, where an indexer or a virus scanner can hold the target
 * open for a moment.
 */
export async function atomicReplace(target: string, data: string | Buffer, options: AtomicReplaceOptions = {}): Promise<void> {
  const parent = path.dirname(target);
  const temp = path.join(parent, options.tempName ? options.tempName(target) : defaultTempName(target));
  let committed = false;
  try {
    if (options.createDirectory) await fsp.mkdir(parent, { recursive: true, mode: 0o700 });
    await options.beforeWrite?.(target);
    const handle = await fsp.open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await options.afterTempWrite?.(temp);
    if (options.signal?.aborted) throw new AtomicWriteAborted();
    await options.beforeCommit?.(target);
    await renameWithRetry(temp, target, options);
    committed = true;
    await (options.syncDirectory ?? fsyncDirectory)(parent, options.platform);
  } catch (error) {
    await fsp.rm(temp, { force: true }).catch(() => undefined);
    if (committed) throw new AtomicWriteUnconfirmed(error);
    throw error;
  }
}

/**
 * Replace `<dir>/<fileName>` atomically: temp (0o600) → fsync → rename →
 * directory fsync. The directory is created 0o700. Any failure before the
 * rename leaves the previous file untouched and removes the temp file.
 */
export async function atomicWriteFile(dir: string, fileName: string, data: string, options: AtomicWriteOptions = {}): Promise<void> {
  await atomicReplace(path.join(dir, fileName), data, { ...options, createDirectory: true });
}

async function syncDirectoryInternal(dir: string, platform: NodeJS.Platform, onError: (() => Error) | null): Promise<void> {
  // A directory cannot be opened for fsync on win32, so there is nothing to confirm there.
  if (platform === 'win32') return;
  let handle: fsp.FileHandle | null = null;
  try {
    handle = await fsp.open(dir, constants.O_RDONLY);
    await handle.sync();
  } catch {
    if (onError) throw onError();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Best-effort durability for a directory; skipped on win32, where a directory cannot be opened for fsync. */
export function fsyncDirectory(dir: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  return syncDirectoryInternal(dir, platform, null);
}

/** The directory sync a store must be able to confirm: a failure fails the write. */
export function syncDirectory(dir: string, policy: { fail: () => Error }, platform: NodeJS.Platform = process.platform): Promise<void> {
  return syncDirectoryInternal(dir, platform, policy.fail);
}

/** How a store names and reports a broken permission rule. */
export interface OwnerModePolicy {
  /** The store's own error for a broken rule. */
  fail: (message: string) => Error;
  /** The message for a path that is not the kind it must be. */
  notRegular: (kind: 'directory' | 'file') => string;
  /** The message for a path owned by another user. */
  foreignOwner: (kind: 'directory' | 'file') => string;
  /** The message for a path others may reach. */
  openPermissions: (kind: 'directory' | 'file') => string;
  /** False where the platform has no owner or mode bits to compare (win32). */
  checkOwner: boolean;
}

/**
 * The owner-only rule every store shares: the path must be a plain file or
 * directory of this user, with no access for others. What the store calls a
 * broken rule, and how strictly it applies, is the store's policy.
 */
export function assertOwnerOnly(stat: FileStat, kind: 'directory' | 'file', policy: OwnerModePolicy): void {
  if (stat.isSymbolicLink() || (kind === 'directory' ? !stat.isDirectory() : !stat.isFile())) {
    throw policy.fail(policy.notRegular(kind));
  }
  if (!policy.checkOwner) return;
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (uid !== undefined && stat.uid !== uid) throw policy.fail(policy.foreignOwner(kind));
  if ((Number(stat.mode) & 0o077) !== 0) throw policy.fail(policy.openPermissions(kind));
}

/** How a store reads a file it must not be led out of by a symbolic link. */
export interface SafeReadPolicy {
  /** The store's own error for a file that cannot be read safely. */
  fail: (message: string) => Error;
  /** True for the errors the store raised itself; they are passed through unchanged. */
  isOwnError: (error: unknown) => boolean;
  /** The rule the file must satisfy before and after it is opened. */
  check: (stat: FileStat, kind: 'directory' | 'file') => void;
  /** The message for a file that is not there. */
  unavailable: string;
  /** The message for a file that is larger than the store allows. */
  tooLarge: string;
  /** The message for a file that could not be read. */
  unreadable: string;
}

/**
 * Read a file under a size bound, without following a symbolic link: the file
 * is checked before it is opened and again once it is open, so a link that
 * appears in between cannot hand out a file the rule would have refused.
 */
export async function readSafeFile(file: string, maxBytes: number, policy: SafeReadPolicy): Promise<Buffer> {
  let before: FileStat;
  try {
    before = await fsp.lstat(file);
  } catch {
    throw policy.fail(policy.unavailable);
  }
  policy.check(before, 'file');
  if (before.size > maxBytes) throw policy.fail(policy.tooLarge);
  let handle: fsp.FileHandle | undefined;
  try {
    handle = await fsp.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const after = await handle.stat();
    policy.check(after, 'file');
    if (after.size > maxBytes) throw policy.fail(policy.tooLarge);
    return await handle.readFile();
  } catch (error) {
    if (policy.isOwnError(error)) throw error;
    throw policy.fail(policy.unreadable);
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** How a store creates a file that must not exist yet. */
export interface ExclusiveWritePolicy {
  /** The store's own error for a file that could not be created safely. */
  fail: (message: string) => Error;
  /** The message that failure carries. */
  message: string;
}

/**
 * Create a file that must not exist yet: the create is exclusive and never
 * follows a symbolic link, so it cannot overwrite or reach another file.
 */
export async function writeExclusiveFile(file: string, data: Buffer, policy: ExclusiveWritePolicy): Promise<void> {
  let handle: fsp.FileHandle | undefined;
  try {
    handle = await fsp.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    await handle.writeFile(data);
    await handle.sync();
  } catch {
    throw policy.fail(policy.message);
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Removes matching temp files; with `minAgeMs`, only those not modified for that long (a write may be in flight). */
export async function removeTemps(dir: string, pattern: RegExp, minAgeMs = 0): Promise<void> {
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return;
  }
  // File times come from the wall clock, not the injectable one.
  const cutoff = Date.now() - minAgeMs;
  await Promise.all(
    names
      .filter((name) => pattern.test(name))
      .map(async (name) => {
        const file = path.join(dir, name);
        if (minAgeMs > 0 && (await fsp.lstat(file)).mtimeMs > cutoff) return;
        await fsp.rm(file, { force: true });
      })
      .map((removal) => removal.catch(() => undefined)),
  );
}

/** The name a corrupt file is moved to. */
export function quarantineName(fileName: string, now: number): string {
  return `${fileName}.corrupt-${now}`;
}
