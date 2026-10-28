/**
 * File helpers shared by the website-memory store (003) and the site-map store (004): the private
 * file and directory check, the quarantine name and the cleanup of temp files a crash left behind.
 */
import type fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { MemoryStoreError } from './site-record.js';

export function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** The POSIX owner and mode-bit check; win32 has no comparable mode bits, so it is skipped there. */
export function assertPrivate(st: fs.Stats, kind: 'directory' | 'file', platform: NodeJS.Platform): void {
  if (st.isSymbolicLink() || (kind === 'directory' ? !st.isDirectory() : !st.isFile())) {
    throw new MemoryStoreError('MEMORY_UNAVAILABLE', `memory ${kind} is not a regular ${kind}`);
  }
  if (platform === 'win32') return;
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (uid !== undefined && st.uid !== uid) throw new MemoryStoreError('MEMORY_UNAVAILABLE', `memory ${kind} is owned by another user`);
  if ((Number(st.mode) & 0o077) !== 0) throw new MemoryStoreError('MEMORY_UNAVAILABLE', `memory ${kind} permissions allow other users`);
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
