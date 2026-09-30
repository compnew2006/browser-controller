#!/usr/bin/env node
/**
 * Explicit lifecycle CLI for the single authoritative Browser Controller daemon.
 * MCP clients may still auto-start it, but deployment/restart should use these
 * commands so only this process manager is responsible for the runtime.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'mcp-server', 'dist', 'daemon.js');
const stateDir = process.env.BC_STATE_DIR || path.join(os.homedir(), '.browser-controller');
const infoFile = path.join(stateDir, 'daemon.json');
const lockFile = path.join(stateDir, 'daemon.lock');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function readInfo() {
  try { return JSON.parse(fs.readFileSync(infoFile, 'utf8')); } catch { return null; }
}
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function enrollmentSecret() {
  try { return JSON.parse(fs.readFileSync(path.join(stateDir, 'enrollment.json'), 'utf8')).secret || null; } catch { return null; }
}
/** GET /status from the daemon's HTTP port (enrollment-gated); null when nothing answers. */
function daemonStatus(info, timeoutMs = 1500) {
  const secret = enrollmentSecret();
  if (!info?.port || !secret) return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = http.get({ host: info.host || '127.0.0.1', port: info.port, path: '/status', headers: { 'X-BC-Enrollment': secret }, timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(res.statusCode === 200 ? JSON.parse(body) : null); } catch { resolve(null); } });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}
/** Does a Browser Controller daemon answer on the IPC socket? (Any protocol frame back proves it.) */
function ipcAnswers(socketPath, timeoutMs = 1500) {
  if (!socketPath) return Promise.resolve(false);
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(t); sock.destroy(); resolve(v); } };
    const sock = net.createConnection(socketPath);
    const t = setTimeout(() => finish(false), timeoutMs);
    let buf = '';
    sock.setEncoding('utf8');
    // Not a hello: the daemon answers {kind:"denied", reason:"first frame must be hello"}.
    sock.on('connect', () => sock.write(JSON.stringify({ kind: 'probe' }) + '\n'));
    sock.on('data', (c) => {
      buf += c;
      const line = buf.split('\n')[0];
      try { const msg = JSON.parse(line); finish(!!msg && typeof msg.kind === 'string'); } catch { /* wait for the rest */ }
    });
    sock.on('error', () => finish(false));
    sock.on('close', () => finish(false));
  });
}
/**
 * Is the pid in daemon.json really the daemon? A live pid alone is not proof
 * (pids are reused; the file can be stale): the daemon itself must answer —
 * its /status reports its pid; an older daemon without that field must at
 * least answer on the recorded IPC socket.
 */
async function live(info) {
  if (!pidAlive(info?.pid)) return false;
  const status = await daemonStatus(info);
  if (status && typeof status.pid === 'number') return status.pid === info.pid;
  return ipcAnswers(info.socket);
}
async function waitForStart(timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const info = readInfo();
    if (await live(info)) return info;
    await sleep(100);
  }
  throw new Error('daemon did not become ready; see daemon.log');
}
function staleNote(info) {
  return info?.pid && pidAlive(info.pid)
    ? ` (daemon.json names pid ${info.pid}, which is alive but is not a Browser Controller daemon — left untouched)`
    : '';
}
async function start() {
  if (!fs.existsSync(entry)) throw new Error('daemon build missing; run `npm run build` first');
  const existing = readInfo();
  if (await live(existing)) {
    console.log(`daemon already running (pid ${existing.pid}) on ${existing.host}:${existing.port}`);
    return;
  }
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const log = fs.openSync(path.join(stateDir, 'daemon.log'), 'a', 0o600);
  const child = spawn(process.execPath, [entry], { detached: true, stdio: ['ignore', log, log], env: process.env });
  child.unref();
  const info = await waitForStart();
  console.log(`daemon started (pid ${info.pid})`);
  console.log(`MCP stdio entry: ${path.join(root, 'mcp-server', 'dist', 'index.js')}`);
  console.log(`daemon endpoints: http/ws://${info.host}:${info.port} (WS + /pair /status /kill); IPC ${info.socket}`);
}
async function stop() {
  const info = readInfo();
  if (!(await live(info))) {
    for (const file of [infoFile, lockFile]) { try { fs.unlinkSync(file); } catch {} }
    console.log(`daemon is not running${staleNote(info)}`);
    return;
  }
  // Identity verified above: only now is it safe to signal this pid.
  process.kill(info.pid, 'SIGTERM');
  const end = Date.now() + 5000;
  while (Date.now() < end && pidAlive(info.pid)) await sleep(100);
  if (pidAlive(info.pid)) throw new Error(`daemon pid ${info.pid} did not stop`);
  console.log('daemon stopped');
}
const command = process.argv[2] || 'status';
if (command === 'start') await start();
else if (command === 'stop') await stop();
else if (command === 'restart') { await stop(); await start(); }
else if (command === 'status') {
  const info = readInfo();
  if (!(await live(info))) { console.log(`daemon is not running${staleNote(info)}`); process.exitCode = 1; }
  else console.log(JSON.stringify({ ...info, running: true }, null, 2));
} else throw new Error(`unknown command: ${command}`);
