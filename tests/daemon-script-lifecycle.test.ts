import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dirs: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-daemon-script-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

let distEmit: string;
beforeAll(() => {
  distEmit = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-daemon-dist-'));
  const res = spawnSync('npx', ['tsc', '-p', path.join(ROOT, 'mcp-server'), '--outDir', distEmit], { cwd: ROOT, encoding: 'utf8', timeout: 110_000 });
  if (res.status !== 0) throw new Error(`tsc emit failed: ${res.stdout}${res.stderr}`);
}, 120_000);
afterAll(() => { fs.rmSync(distEmit, { recursive: true, force: true }); });

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
  // A repo root with a real tsc emit of mcp-server, so stop uses the same lock helper as the daemon.
  function builtRoot() {
    const { repo, stateDir } = buildlessRoot();
    fs.writeFileSync(path.join(repo, 'package.json'), '{"type":"module"}');
    fs.cpSync(distEmit, path.join(repo, 'mcp-server', 'dist'), { recursive: true });
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
    const { repo, stateDir } = builtRoot();
    fs.writeFileSync(path.join(stateDir, 'daemon.json'), JSON.stringify({ pid: 2147483646 }));
    fs.writeFileSync(path.join(stateDir, 'daemon.lock'), JSON.stringify({ pid: process.pid }));
    const res = run(repo, stateDir, 'stop');
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('lock held by a live or starting daemon');
    expect(fs.existsSync(path.join(stateDir, 'daemon.lock'))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'daemon.json'))).toBe(false);
  });

  const lockCase = (content: string, ageMs: number) => {
    const { repo, stateDir } = builtRoot();
    fs.writeFileSync(path.join(stateDir, 'daemon.json'), JSON.stringify({ pid: 2147483646 }));
    const lock = path.join(stateDir, 'daemon.lock');
    fs.writeFileSync(lock, content);
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(lock, t, t);
    const res = run(repo, stateDir, 'stop');
    return { res, lock };
  };

  it('stop removes a stale lock (dead pid)', () => {
    const { res, lock } = lockCase(JSON.stringify({ pid: 2147483646 }), 0);
    expect(res.status).toBe(0);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('stop keeps an empty lock that was just created', () => {
    const { res, lock } = lockCase('', 0);
    expect(res.status).toBe(0);
    expect(fs.existsSync(lock)).toBe(true);
  });

  it('stop removes a lock naming a live pid past the startup grace when no daemon answers the socket (drift fixed)', () => {
    const { res, lock } = lockCase(JSON.stringify({ pid: process.pid }), 60_000);
    expect(res.status).toBe(0);
    expect(fs.existsSync(lock)).toBe(false);
  });
});
