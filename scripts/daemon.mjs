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
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'mcp-server', 'dist', 'daemon.js');
const stateDir = process.env.BC_STATE_DIR || path.join(os.homedir(), '.browser-controller');
const infoFile = path.join(stateDir, 'daemon.json');
const lockFile = path.join(stateDir, 'daemon.lock');
const bridgeAuthModule = path.join(root, 'mcp-server', 'dist', 'bridge-auth.js');
const buildMissingMessage = 'daemon build missing; run `npm run build` first';
/** Window between openSync('wx') and the write that fills a new lock (daemon-config.ts LOCK_WRITE_GRACE_MS). */
const LOCK_WRITE_GRACE_MS = 5000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Who holds the lock, as inspectDaemonLock in daemon-config.ts judges it:
 * holder is a live pid, 0 for a lock still being written, or null when the
 * lock is stale. judged is the identity of the file read (null when absent).
 */
function inspectLock(lockPath) {
  let judged;
  let raw;
  try {
    const st = fs.lstatSync(lockPath);
    judged = { dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs };
    raw = fs.readFileSync(lockPath, 'utf8');
  } catch { return { holder: null, judged: null }; }
  let ownerPid = 0;
  try { ownerPid = JSON.parse(raw).pid ?? 0; } catch { /* empty or corrupt */ }
  if (ownerPid > 0) return { holder: pidAlive(ownerPid) ? ownerPid : null, judged };
  return { holder: Date.now() - judged.mtimeMs < LOCK_WRITE_GRACE_MS ? 0 : null, judged };
}
/** Identity of the lock when it is stale (dead owner, or unfilled past the grace window); null otherwise. */
export function judgeStaleLock(lockPath) {
  const { holder, judged } = inspectLock(lockPath);
  return holder === null ? judged : null;
}
/**
 * Remove the lock at `lockPath` only if it is still the file judged stale
 * (same device, inode and mtime). Mirrors reclaimLock in
 * mcp-server/src/lock-file.ts: rename to a unique tombstone (atomic, one
 * racer wins), compare, and put a different lock back. A plain unlink after a
 * liveness check could delete the fresh lock of a daemon starting meanwhile.
 */
export function reclaimStaleLock(lockPath, judged, hooks = {}) {
  hooks.beforeRename?.();
  const tombstone = `${lockPath}.stale.${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
  try { fs.renameSync(lockPath, tombstone); } catch { return false; }
  let same = false;
  try {
    const moved = fs.lstatSync(tombstone);
    same = moved.dev === judged.dev && moved.ino === judged.ino && moved.mtimeMs === judged.mtimeMs;
  } catch { /* tombstone vanished: nothing to restore */ }
  if (!same) { try { fs.linkSync(tombstone, lockPath); } catch { /* lock already recreated */ } }
  try { fs.unlinkSync(tombstone); } catch { /* already gone */ }
  return same;
}
function readInfo() {
  try { return JSON.parse(fs.readFileSync(infoFile, 'utf8')); } catch { return null; }
}
/** EPERM means the process exists under another user, so only ESRCH is dead (as lock-file.ts pidAlive). */
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
function enrollmentSecret() {
  try { return JSON.parse(fs.readFileSync(path.join(stateDir, 'enrollment.json'), 'utf8')).secret || null; } catch { return null; }
}
/** GET /status only after the recorded daemon proves its identity; null otherwise. */
async function daemonStatus(info, timeoutMs = 1500) {
  const secret = enrollmentSecret();
  if (!info?.port || !secret) return null;
  try {
    const { authenticatedHttpGet } = await import(pathToFileURL(bridgeAuthModule).href);
    const response = await authenticatedHttpGet(
      `http://${info.host || '127.0.0.1'}:${info.port}`,
      '/status',
      secret,
      { signal: AbortSignal.timeout(timeoutMs) },
    );
    return response.ok ? JSON.parse(response.body) : null;
  } catch {
    return null;
  }
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
  if (!fs.existsSync(entry)) throw new Error(buildMissingMessage);
  const existing = readInfo();
  if (await live(existing)) {
    console.log(`daemon already running (pid ${existing.pid}) on ${existing.host}:${existing.port}`);
    return;
  }
  // The build's own helper (same BC_STATE_DIR) rotates a daemon.log past its size cap.
  const { openDaemonLog } = await import(pathToFileURL(path.join(root, 'mcp-server', 'dist', 'daemon-config.js')).href);
  const log = openDaemonLog();
  const child = spawn(process.execPath, [entry], { detached: true, stdio: ['ignore', log, log], env: process.env });
  child.unref();
  const info = await waitForStart();
  console.log(`daemon started (pid ${info.pid})`);
  console.log(`MCP stdio entry: ${path.join(root, 'mcp-server', 'dist', 'index.js')}`);
  console.log(`daemon endpoints: http/ws://${info.host}:${info.port} (authenticated WS + /pair /status /kill); IPC ${info.socket}`);
}
async function stop() {
  // Without the build the identity proof cannot run; cleaning up "stale" files here could hit a live daemon.
  if (!fs.existsSync(bridgeAuthModule)) throw new Error(buildMissingMessage);
  const info = readInfo();
  // Judge the lock before the liveness check, so only that exact stale file is removed afterwards.
  const { holder, judged } = inspectLock(lockFile);
  if (!(await live(info))) {
    try { fs.unlinkSync(infoFile); } catch {}
    if (holder === null && judged) reclaimStaleLock(lockFile, judged);
    else if (holder !== null) console.log(`lock held by ${holder ? `live pid ${holder}` : 'a daemon still writing it'} (a daemon may be starting); left untouched`);
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
async function main() {
  const command = process.argv[2] || 'status';
  if (command === 'start') await start();
  else if (command === 'stop') await stop();
  else if (command === 'restart') { await stop(); await start(); }
  else if (command === 'status') {
    if (!fs.existsSync(bridgeAuthModule)) {
      console.log(`${buildMissingMessage} (the daemon's identity cannot be checked without it)`);
      process.exitCode = 1;
      return;
    }
    const info = readInfo();
    if (!(await live(info))) { console.log(`daemon is not running${staleNote(info)}`); process.exitCode = 1; }
    else console.log(JSON.stringify({ ...info, running: true }, null, 2));
  } else throw new Error(`unknown command: ${command}`);
}
// Only the CLI runs the command; tests import the helpers.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) await main();
