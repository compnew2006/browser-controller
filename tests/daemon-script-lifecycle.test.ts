import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error -- plain ESM script without type declarations
import { judgeStaleLock, reclaimStaleLock } from '../scripts/daemon.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dirs: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-daemon-script-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe('daemon.mjs stale lock removal (F1-4)', () => {
  it('removes the lock when it is still the one judged stale', () => {
    const lock = path.join(tmp(), 'daemon.lock');
    fs.writeFileSync(lock, '{"pid":1}');
    const judged = fs.lstatSync(lock);
    expect(reclaimStaleLock(lock, judged)).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('keeps a fresh lock that replaced the stale one during the check', () => {
    const dir = tmp();
    const lock = path.join(dir, 'daemon.lock');
    fs.writeFileSync(lock, '{"pid":1}');
    const judged = fs.lstatSync(lock);
    const removed = reclaimStaleLock(lock, judged, {
      beforeRename: () => { fs.unlinkSync(lock); fs.writeFileSync(lock, '{"pid":2}'); fs.utimesSync(lock, new Date(), new Date(Date.now() + 5000)); },
    });
    expect(removed).toBe(false);
    expect(fs.readFileSync(lock, 'utf8')).toBe('{"pid":2}');
    expect(fs.readdirSync(dir)).toEqual(['daemon.lock']);
  });
});

describe('daemon.mjs judges whether a lock is stale (F1-4)', () => {
  const lockWith = (content: string, ageMs = 0) => {
    const lock = path.join(tmp(), 'daemon.lock');
    fs.writeFileSync(lock, content);
    if (ageMs) { const t = new Date(Date.now() - ageMs); fs.utimesSync(lock, t, t); }
    return lock;
  };

  it('keeps a lock held by a live pid', () => {
    expect(judgeStaleLock(lockWith(JSON.stringify({ pid: process.pid })))).toBeNull();
  });

  it('keeps an empty lock that was just created (owner still writing it)', () => {
    expect(judgeStaleLock(lockWith(''))).toBeNull();
  });

  it('judges an empty lock with an old mtime stale and returns its identity', () => {
    const lock = lockWith('', 60_000);
    const st = fs.lstatSync(lock);
    expect(judgeStaleLock(lock)).toEqual({ dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs });
  });

  it('judges a lock with a dead pid stale', () => {
    expect(judgeStaleLock(lockWith(JSON.stringify({ pid: 2147483646 })))).not.toBeNull();
  });

  it('keeps a lock whose pid exists under another user (EPERM is alive, as in lock-file.ts)', () => {
    // pid 1 is init/launchd: signal 0 gives EPERM for a normal user and succeeds for root. Alive either way.
    expect(judgeStaleLock(lockWith(JSON.stringify({ pid: 1 })))).toBeNull();
  });

  it('returns null when there is no lock', () => {
    expect(judgeStaleLock(path.join(tmp(), 'daemon.lock'))).toBeNull();
  });
});

describe('daemon.mjs without a build (F1-6)', () => {
  // A copy of the script in a repo root that has no mcp-server/dist.
  function buildlessRoot() {
    const repo = tmp();
    fs.mkdirSync(path.join(repo, 'scripts'));
    fs.copyFileSync(path.join(ROOT, 'scripts', 'daemon.mjs'), path.join(repo, 'scripts', 'daemon.mjs'));
    const stateDir = path.join(repo, 'state');
    fs.mkdirSync(stateDir);
    return { repo, stateDir };
  }
  const run = (repo: string, stateDir: string, cmd: string) => spawnSync(process.execPath, [path.join(repo, 'scripts', 'daemon.mjs'), cmd], {
    env: { ...process.env, BC_STATE_DIR: stateDir }, encoding: 'utf8', timeout: 20_000,
  });

  it('status reports the missing build with the build hint, not "not running"', () => {
    const { repo, stateDir } = buildlessRoot();
    fs.writeFileSync(path.join(stateDir, 'enrollment.json'), JSON.stringify({ secret: 'synthetic' }));
    fs.writeFileSync(path.join(stateDir, 'daemon.json'), JSON.stringify({ pid: process.pid, port: 1, host: '127.0.0.1', socket: path.join(stateDir, 'x.sock') }));
    const res = run(repo, stateDir, 'status');
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/build missing/);
    expect(res.stdout).toContain('npm run build');
    expect(res.stdout).not.toMatch(/not running/);
  });

  it('stop leaves daemon.json and the lock alone when identity cannot be checked', () => {
    const { repo, stateDir } = buildlessRoot();
    fs.writeFileSync(path.join(stateDir, 'daemon.json'), '{"pid":999999}');
    fs.writeFileSync(path.join(stateDir, 'daemon.lock'), '{"pid":999999}');
    const res = run(repo, stateDir, 'stop');
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/build missing/);
    expect(fs.existsSync(path.join(stateDir, 'daemon.json'))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'daemon.lock'))).toBe(true);
  });

  it('stop removes daemon.json but keeps a live starter lock', () => {
    const { repo, stateDir } = buildlessRoot();
    fs.mkdirSync(path.join(repo, 'mcp-server', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'mcp-server', 'dist', 'bridge-auth.js'), '// stub');
    fs.writeFileSync(path.join(stateDir, 'daemon.json'), JSON.stringify({ pid: 2147483646 }));
    fs.writeFileSync(path.join(stateDir, 'daemon.lock'), JSON.stringify({ pid: process.pid }));
    const res = run(repo, stateDir, 'stop');
    expect(res.status).toBe(0);
    expect(res.stdout).toContain(`lock held by live pid ${process.pid}`);
    expect(fs.existsSync(path.join(stateDir, 'daemon.lock'))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'daemon.json'))).toBe(false);
  });
});
