import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'daemon.mjs');
const helpers: ChildProcess[] = [];

afterEach(() => {
  for (const h of helpers) { try { h.kill(); } catch { /* gone */ } }
  helpers.length = 0;
});

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** A state dir whose daemon.json names a live process that is NOT a daemon. */
function impostorState() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-lifecycle-'));
  const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' });
  helpers.push(helper);
  const socket = process.platform === 'win32' ? `\\\\.\\pipe\\bc-test-none-${process.pid}-${Date.now()}` : path.join(stateDir, 'none.sock');
  fs.writeFileSync(path.join(stateDir, 'daemon.json'), JSON.stringify({ pid: helper.pid, socket, port: 1, host: '127.0.0.1', startedAt: Date.now() }));
  return { stateDir, helper };
}

const run = (cmd: string, stateDir: string) => spawnSync(process.execPath, [SCRIPT, cmd], {
  env: { ...process.env, BC_STATE_DIR: stateDir }, encoding: 'utf8', timeout: 20_000,
});

describe('scripts/daemon.mjs verifies daemon identity before trusting a pid', () => {
  it('status does not report an unrelated live pid as a running daemon', () => {
    const { stateDir, helper } = impostorState();
    const res = run('status', stateDir);
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/not running/);
    expect(res.stdout).toContain(`pid ${helper.pid}`);
  });

  it('stop never signals a process that is not the daemon', () => {
    const { stateDir, helper } = impostorState();
    const res = run('stop', stateDir);
    expect(res.stdout).toMatch(/not running/);
    expect(alive(helper.pid!)).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'daemon.json'))).toBe(false); // stale metadata cleaned
  });
});
