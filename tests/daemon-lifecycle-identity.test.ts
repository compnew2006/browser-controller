import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { BridgeHttpAuthenticator } from '../mcp-server/src/bridge-auth.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'daemon.mjs');
const helpers: ChildProcess[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  for (const h of helpers) { try { h.kill(); } catch { /* gone */ } }
  helpers.length = 0;
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  servers.length = 0;
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

async function authenticatedProbeFixture(secret: string, signedSecret = secret, reportedPid?: number) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-lifecycle-auth-'));
  const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' });
  helpers.push(helper);
  const statusPid = reportedPid ?? helper.pid!;
  const auth = new BridgeHttpAuthenticator(signedSecret, 'lifecycle-test-daemon');
  const seen: Array<{ url: string; hasEnrollmentHeader: boolean; hasProofHeader: boolean }> = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    seen.push({
      url: req.url || '/',
      hasEnrollmentHeader: Boolean(req.headers['x-bc-enrollment']),
      hasProofHeader: Boolean(req.headers['x-bc-client-proof']),
    });
    if (url.pathname === '/auth/challenge') {
      const challenge = auth.issueChallenge(url.searchParams.get('clientNonce') || '');
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(challenge));
      return;
    }
    const clientNonce = String(req.headers['x-bc-client-nonce'] || '');
    const serverNonce = String(req.headers['x-bc-server-nonce'] || '');
    const accepted = auth.verifyAndConsume({
      clientNonce,
      serverNonce,
      method: req.method || '',
      target: req.url || '/',
      clientProof: req.headers['x-bc-client-proof'],
    });
    if (!accepted) { res.writeHead(403).end('Forbidden'); return; }
    const body = JSON.stringify({ pid: statusPid, agents: [] });
    const proof = auth.createResponseProof({ clientNonce, serverNonce, status: 200, body });
    res.writeHead(200, { 'Content-Type': 'application/json', 'X-BC-Response-Proof': proof }).end(body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  servers.push(server);
  const port = (server.address() as import('node:net').AddressInfo).port;
  fs.writeFileSync(path.join(stateDir, 'enrollment.json'), JSON.stringify({ secret }), { mode: 0o600 });
  fs.writeFileSync(path.join(stateDir, 'daemon.json'), JSON.stringify({
    pid: helper.pid,
    socket: path.join(stateDir, 'none.sock'),
    port,
    host: '127.0.0.1',
    startedAt: Date.now(),
  }));
  return { stateDir, helper, port, seen };
}

const run = (cmd: string, stateDir: string) => spawnSync(process.execPath, [SCRIPT, cmd], {
  env: { ...process.env, BC_STATE_DIR: stateDir }, encoding: 'utf8', timeout: 20_000,
});

function runAsync(cmd: string, stateDir: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, cmd], { env: { ...process.env, BC_STATE_DIR: stateDir } });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('daemon lifecycle command timed out')); }, 20_000);
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

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

  it('rejects an impostor HTTP challenge without sending the enrollment secret', async () => {
    const { stateDir, seen } = await authenticatedProbeFixture('synthetic-lifecycle-secret', 'attacker-secret');
    const res = await runAsync('status', stateDir);
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/not running/);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toMatch(/^\/auth\/challenge\?clientNonce=/);
    expect(seen[0].hasEnrollmentHeader).toBe(false);
    expect(seen[0].hasProofHeader).toBe(false);
  });

  it('accepts lifecycle status only after a matching daemon proof', async () => {
    const { stateDir, helper, seen } = await authenticatedProbeFixture('synthetic-lifecycle-secret');
    const res = await runAsync('status', stateDir);
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout)).toMatchObject({ pid: helper.pid, running: true });
    expect(seen.map((entry) => entry.url.replace(/clientNonce=.*/, 'clientNonce=<nonce>'))).toEqual([
      '/auth/challenge?clientNonce=<nonce>',
      '/status',
    ]);
    expect(seen.every((entry) => !entry.hasEnrollmentHeader)).toBe(true);
    expect(seen[1].hasProofHeader).toBe(true);
  });
});
