import fs from 'node:fs';
import net from 'node:net';
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
  it('reclaims a lock whose pid is dead', async () => {
    writeLock(JSON.stringify({ pid: DEAD_PID, startedAt: 1 }));
    await mod.acquireDaemonLock();
    expect(JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid).toBe(process.pid);
  });

  // Fresh lock (inside the startup grace): a live pid is trusted without a probe.
  // Was aged 60s; with F1-5 an aged lock needs an answering socket (tests below).
  it('does not reclaim a lock held by a live pid', async () => {
    writeLock(JSON.stringify({ pid: process.ppid, startedAt: 1 }), 0);
    await expect(mod.acquireDaemonLock()).rejects.toThrow(mod.DaemonLockHeldError);
    expect(JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid).toBe(process.ppid);
  });

  it('keeps an empty lock inside the write grace period', async () => {
    writeLock('', 0);
    await expect(mod.acquireDaemonLock()).rejects.toThrow(mod.DaemonLockHeldError);
    expect(await mod.daemonLockHolder()).toBe(0);
  });

  it('reclaims an empty lock after the grace period', async () => {
    writeLock('', 60_000);
    await mod.acquireDaemonLock();
    expect(JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid).toBe(process.pid);
  });

  it('two acquirers on one stale lock: the loser must not remove the winner lock', async () => {
    writeLock(JSON.stringify({ pid: DEAD_PID, startedAt: 1 }));
    // Starter B finishes its takeover between A's staleness judgement and A's removal.
    // The new file is built beside the old one first so the inode cannot be reused.
    mod.daemonLockReclaimHooks.beforeRename = () => {
      mod.daemonLockReclaimHooks.beforeRename = undefined;
      const winner = `${lockFile}.winner`;
      fs.writeFileSync(winner, JSON.stringify({ pid: process.ppid, startedAt: 2 }), { mode: 0o600 });
      fs.renameSync(winner, lockFile);
    };
    await expect(mod.acquireDaemonLock()).rejects.toThrow(mod.DaemonLockHeldError);
    expect(JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid).toBe(process.ppid);
    expect(fs.readdirSync(stateDir).filter((f) => f.includes('.stale.'))).toEqual([]);
  });

  // F1-5: a recycled pid is alive but is not a daemon.
  it('reclaims a live pid past the startup grace when no daemon answers the IPC socket', async () => {
    writeLock(JSON.stringify({ pid: process.ppid, startedAt: 1 }), 60_000);
    expect(await mod.daemonLockHolder()).toBeNull();
    await mod.acquireDaemonLock();
    expect(JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid).toBe(process.pid);
  });

  it('holds a live pid inside the startup grace even with no socket', async () => {
    writeLock(JSON.stringify({ pid: process.ppid, startedAt: 1 }), 2_000);
    expect(await mod.daemonLockHolder()).toBe(process.ppid);
  });

  it('holds a live pid past the grace when a daemon answers the IPC socket', async () => {
    writeLock(JSON.stringify({ pid: process.ppid, startedAt: 1 }), 60_000);
    const server = net.createServer((sock) => {
      sock.on('data', () => sock.write(JSON.stringify({ kind: 'denied', reason: 'first frame must be hello', ok: false }) + '\n'));
    });
    await new Promise<void>((resolve) => server.listen(mod.IPC_SOCKET_PATH, resolve));
    try {
      expect(await mod.daemonLockHolder()).toBe(process.ppid);
      await expect(mod.acquireDaemonLock()).rejects.toThrow(mod.DaemonLockHeldError);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
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
