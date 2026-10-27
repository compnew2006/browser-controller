import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Daemon lock takeover (audit F1-1): two starters that both judge a lock
 * stale must not both remove and recreate it. State dir is a temp dir; the
 * module is re-imported per test because STATE_DIR is read at import time.
 */
const DEAD_PID = 2_147_483_646;
let stateDir: string;
let mod: typeof import('../mcp-server/src/daemon-config.js');
let lockFile: string;

function writeLock(content: string, ageMs = 60_000): void {
  fs.writeFileSync(lockFile, content, { mode: 0o600 });
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(lockFile, when, when);
}

beforeEach(async () => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-daemon-lock-'));
  process.env.BC_STATE_DIR = stateDir;
  vi.resetModules();
  mod = await import('../mcp-server/src/daemon-config.js');
  lockFile = mod.DAEMON_LOCK_FILE;
});

afterEach(() => {
  delete process.env.BC_STATE_DIR;
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe('daemon lock', () => {
  it('reclaims a lock whose pid is dead', () => {
    writeLock(JSON.stringify({ pid: DEAD_PID, startedAt: 1 }));
    mod.acquireDaemonLock();
    expect(JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid).toBe(process.pid);
  });

  it('does not reclaim a lock held by a live pid', () => {
    writeLock(JSON.stringify({ pid: process.ppid, startedAt: 1 }));
    expect(() => mod.acquireDaemonLock()).toThrow(mod.DaemonLockHeldError);
    expect(JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid).toBe(process.ppid);
  });

  it('keeps an empty lock inside the write grace period', () => {
    writeLock('', 0);
    expect(() => mod.acquireDaemonLock()).toThrow(mod.DaemonLockHeldError);
    expect(mod.daemonLockHolder()).toBe(0);
  });

  it('reclaims an empty lock after the grace period', () => {
    writeLock('', 60_000);
    mod.acquireDaemonLock();
    expect(JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid).toBe(process.pid);
  });

  it('two acquirers on one stale lock: the loser must not remove the winner lock', () => {
    writeLock(JSON.stringify({ pid: DEAD_PID, startedAt: 1 }));
    // Starter B finishes its takeover between A's staleness judgement and A's removal.
    // The new file is built beside the old one first so the inode cannot be reused.
    mod.daemonLockReclaimHooks.beforeRename = () => {
      mod.daemonLockReclaimHooks.beforeRename = undefined;
      const winner = `${lockFile}.winner`;
      fs.writeFileSync(winner, JSON.stringify({ pid: process.ppid, startedAt: 2 }), { mode: 0o600 });
      fs.renameSync(winner, lockFile);
    };
    expect(() => mod.acquireDaemonLock()).toThrow(mod.DaemonLockHeldError);
    expect(JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid).toBe(process.ppid);
    expect(fs.readdirSync(stateDir).filter((f) => f.includes('.stale.'))).toEqual([]);
  });
});

describe('reclaimLock', () => {
  // A freed inode can be reused at once, so a racer's fresh lock may carry the
  // stale lock's dev and inode; its newer mtime still tells them apart.
  it('keeps a lock that reuses the judged inode but was written after the judgement', async () => {
    const { reclaimLock } = await import('../mcp-server/src/lock-file.js');
    writeLock(JSON.stringify({ pid: DEAD_PID }));
    const stale = fs.lstatSync(lockFile);
    const fresh = new Date();
    fs.utimesSync(lockFile, fresh, fresh);

    expect(reclaimLock(lockFile, { dev: stale.dev, ino: stale.ino, mtimeMs: stale.mtimeMs })).toBe(false);
    expect(fs.existsSync(lockFile)).toBe(true);
    expect(fs.readdirSync(path.dirname(lockFile)).filter((name) => name.includes('.stale.'))).toEqual([]);
  });
});
