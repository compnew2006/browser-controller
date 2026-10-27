import fs from 'node:fs';
import crypto from 'node:crypto';

/**
 * Shared stale-lock takeover for the daemon lock and the vault lock.
 *
 * A plain check-then-unlink lets two starters that both judge a lock stale
 * each unlink and recreate it, so the second unlink deletes the first one's
 * fresh lock. Takeover here renames the lock to a unique tombstone (atomic:
 * only one racer gets the file), then checks the tombstone is still the file
 * that was judged stale (same device, inode and mtime: a freed inode can be
 * reused at once, but a lock created after the judgement is newer). If a new
 * lock slipped in meanwhile, it is put back and nothing is reclaimed.
 */
export interface LockIdentity {
  dev: number;
  ino: number;
  mtimeMs: number;
}

/** Test seam: runs between the staleness judgement and the takeover. */
export interface ReclaimHooks {
  beforeRename?: () => void;
}

/** EPERM means the process exists under another user, so only ESRCH is dead. */
export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

/**
 * Remove the lock at `lockPath` only if it is still the file judged stale.
 * Returns true when this caller removed it.
 */
export function reclaimLock(lockPath: string, judged: LockIdentity, hooks: ReclaimHooks = {}): boolean {
  hooks.beforeRename?.();
  const tombstone = `${lockPath}.stale.${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
  try { fs.renameSync(lockPath, tombstone); } catch { return false; }
  let same = false;
  try {
    const moved = fs.lstatSync(tombstone);
    same = moved.dev === judged.dev && moved.ino === judged.ino && moved.mtimeMs === judged.mtimeMs;
  } catch { /* tombstone vanished: nothing to restore */ }
  if (!same) {
    // We displaced a lock that was not the stale one: give it back. link()
    // fails if a newer lock already exists, which is the lesser harm.
    try { fs.linkSync(tombstone, lockPath); } catch { /* lock already recreated */ }
  }
  try { fs.unlinkSync(tombstone); } catch { /* already gone */ }
  return same;
}
