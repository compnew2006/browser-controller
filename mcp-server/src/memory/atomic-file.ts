import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

const RENAME_RETRIES = 3;
const RENAME_BACKOFF_MS = 50;
const RETRYABLE_RENAME_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES']);

export class AtomicWriteAborted extends Error {
  constructor() {
    super('atomic write aborted before rename');
    this.name = 'AtomicWriteAborted';
  }
}

export interface AtomicWriteOptions {
  platform?: NodeJS.Platform;
  rename?: (from: string, to: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  /** Checked after the temp file is durable and before the rename; an aborted write removes its temp file. */
  signal?: AbortSignal;
  /** Test seam: runs after the temp file is fsynced and before the abort check. */
  afterTempWrite?: (tempPath: string) => Promise<void>;
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

/** Best-effort durability for the rename itself; skipped on win32, where a directory cannot be opened. */
export async function fsyncDirectory(dir: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform === 'win32') return;
  const handle = await fsp.open(dir, 'r').catch(() => null);
  if (handle) {
    await handle.sync().catch(() => undefined);
    await handle.close().catch(() => undefined);
  }
}

/**
 * Replace `<dir>/<fileName>` atomically: temp (0o600) → fsync → rename →
 * directory fsync. The directory is created 0o700. Any failure before the
 * rename leaves the previous file untouched and removes the temp file. A
 * directory fsync failure after the rename is ignored: the file is already
 * committed.
 */
export async function atomicWriteFile(dir: string, fileName: string, data: string, options: AtomicWriteOptions = {}): Promise<void> {
  const target = path.join(dir, fileName);
  const temp = path.join(dir, `${fileName}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    const handle = await fsp.open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(data, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (options.afterTempWrite) await options.afterTempWrite(temp);
    if (options.signal?.aborted) throw new AtomicWriteAborted();
    await renameWithRetry(temp, target, options);
  } catch (error) {
    await fsp.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  await fsyncDirectory(dir, options.platform);
}
