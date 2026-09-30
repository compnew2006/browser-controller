#!/usr/bin/env node
/**
 * Real-profile smoke test for extension reconnect and core tools.
 * Requires the unpacked extension enrolled in the user's normal Chrome profile.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(os.homedir(), '.browser-controller');
const SOCKET = path.join(STATE, 'daemon.sock');
const TOKEN = JSON.parse(fs.readFileSync(path.join(STATE, 'token.json'), 'utf8')).token;
const DAEMON = path.join(ROOT, 'mcp-server', 'dist', 'daemon.js');
const UPLOAD = path.join(STATE, 'smoke-upload.txt');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const execFileAsync = promisify(execFile);
const SYSTEMD_SERVICE = 'browser-controller-daemon.service';
const userSystemdEnv = {
  ...process.env,
  XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`,
};
if (!userSystemdEnv.DBUS_SESSION_BUS_ADDRESS) {
  userSystemdEnv.DBUS_SESSION_BUS_ADDRESS = `unix:path=${userSystemdEnv.XDG_RUNTIME_DIR}/bus`;
}
const log = (...args) => console.log('[smoke]', ...args);
let server, daemon, tabId, client, startedByTest = false;

function textOf(result) {
  if (result?.content) return result.content.map(x => x.text || '').join('\n');
  return typeof result === 'string' ? result : JSON.stringify(result);
}
function parseText(result) { try { return JSON.parse(textOf(result)); } catch { return null; } }
function refsIn(result, role) {
  const refs = [];
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (node.role === role && node.ref) refs.push(node.ref);
    for (const child of node.children || []) walk(child);
    if (node.tree) walk(node.tree);
  };
  walk(parseText(result));
  return refs;
}
function assert(value, message) { if (!value) throw new Error(message); }
function daemonAlive() {
  return new Promise(resolve => {
    const s = net.createConnection(SOCKET);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}
function startDaemon() {
  if (!fs.existsSync(DAEMON)) throw new Error(`Run npm run build first (missing ${DAEMON})`);
  daemon = spawn(process.execPath, [DAEMON], { cwd: ROOT, stdio: 'ignore', detached: false });
  daemon.on('error', error => console.error('[daemon]', error.message));
}
async function waitForDaemon() {
  for (let i = 0; i < 300; i++) { if (await daemonAlive()) return; await sleep(100); }
  throw new Error(`daemon did not become ready: ${SOCKET}`);
}
async function stopDaemon() {
  if (!daemon) {
    try {
      const info = JSON.parse(fs.readFileSync(path.join(STATE, 'daemon.json'), 'utf8'));
      daemon = { kill: () => process.kill(info.pid, 'SIGTERM'), once: (_event, done) => done() };
    } catch { return; }
  }
  const exited = new Promise(resolve => daemon.once('exit', resolve));
  daemon.kill('SIGTERM');
  await Promise.race([exited, sleep(1500)]);
  daemon = undefined;
  for (let i = 0; i < 30 && await daemonAlive(); i++) await sleep(100);
}
async function call(tool, params) { return client.call(tool, params); }

async function hasManagedDaemon() {
  try {
    const { stdout } = await execFileAsync('systemctl', ['--user', 'show', '--property=LoadState', '--value', SYSTEMD_SERVICE], { env: userSystemdEnv });
    return stdout.trim() === 'loaded';
  } catch {
    return false;
  }
}

async function restartManagedDaemon() {
  await execFileAsync('systemctl', ['--user', 'restart', SYSTEMD_SERVICE], { env: userSystemdEnv });
  await waitForDaemon();
}

async function startManagedDaemon() {
  await execFileAsync('systemctl', ['--user', 'start', SYSTEMD_SERVICE], { env: userSystemdEnv });
  await waitForDaemon();
}


async function connect() {
  const socket = net.createConnection(SOCKET);
  socket.setEncoding('utf8');
  let buffer = '', sequence = 0;
  const pending = new Map();
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  socket.on('connect', () => socket.write(JSON.stringify({ kind: 'hello', token: TOKEN, agentName: 'RealChromeSmoke' }) + '\n'));
  socket.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.kind === 'welcome') readyResolve(msg);
      if (msg.kind === 'ping') socket.write(JSON.stringify({ kind: 'pong' }) + '\n');
      if (msg.kind === 'result' && pending.has(msg.id)) {
        const done = pending.get(msg.id); pending.delete(msg.id); done(msg);
      }
    }
  });
  socket.on('error', error => { readyReject(error); });
  await ready;
  return {
    socket,
    call(tool, params) {
      return new Promise((resolve, reject) => {
        const id = String(++sequence);
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${tool} timed out`)); }, 30000);
        pending.set(id, msg => { clearTimeout(timer); msg.success ? resolve(msg.result) : reject(new Error(msg.error || tool)); });
        socket.write(JSON.stringify({ kind: 'call', id, tool, params }) + '\n');
      });
    },
    close() { socket.destroy(); },
  };
}

async function main() {
  fs.writeFileSync(UPLOAD, 'browser-controller smoke upload\n');
  server = http.createServer((req, res) => {
    if (req.url.startsWith('/api')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return; }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>Browser Controller Smoke</title><main><h1>Smoke page</h1><button id="click" onclick="document.querySelector('#result').textContent='clicked'">Click me</button><input id="text" aria-label="Smoke input"><input id="file" type="file"><p id="result">not clicked</p><script>console.log('SMOKE_CONSOLE_MARKER'); fetch('/api?smoke=1');</script></main>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const page = `http://127.0.0.1:${server.address().port}/`;
  const managedDaemon = await hasManagedDaemon();
  const wasRunning = await daemonAlive();
  if (managedDaemon) {
    if (!wasRunning) await startManagedDaemon();
    log(wasRunning ? 'systemd daemon already running; restarting service during test' : 'started systemd daemon for test');
  } else if (!wasRunning) {
    startDaemon();
    startedByTest = true;
  } else {
    log('unmanaged daemon already running; restarting it during test');
  }
  await waitForDaemon();
  client = await connect();
  await call('browser_tabs', { action: 'list' });
  client.close();
  if (managedDaemon) {
    await restartManagedDaemon();
  } else {
    await stopDaemon();
    if (!(await daemonAlive())) startDaemon();
    await waitForDaemon();
  }
  client = await connect();
  assert(Array.isArray((await call('browser_tabs', { action: 'list' }))?.tabs), 'tab list failed after daemon restart');
  log('daemon restart/reconnect verified');

  const created = await call('browser_tabs', { action: 'create', url: page });
  tabId = created.tabId ?? created.tabs?.[0]?.id;
  assert(Number.isInteger(tabId), `could not determine created tabId: ${JSON.stringify(created)}`);
  assert(Array.isArray((await call('browser_tabs', { action: 'list' }))?.tabs), 'tab list failed');
  const snapshot = await call('browser_snapshot', { tabId, compact: false });
  assert(textOf(snapshot).includes('Smoke page'), 'snapshot did not contain smoke page');
  const buttonRef = refsIn(snapshot, 'button')[0];
  const inputRef = refsIn(snapshot, 'textbox')[0];
  assert(buttonRef && inputRef, 'snapshot did not provide button/textbox refs');
  log(`snapshot ok (tab ${tabId})`);
  await call('browser_click', { tabId, ref: buttonRef });
  const clicked = await call('browser_evaluate', { tabId, expression: 'document.querySelector("#result").textContent' });
  assert(textOf(clicked).includes('clicked'), `click verification failed: ${textOf(clicked)}`);
  await call('browser_type', { tabId, ref: inputRef, text: 'typed by smoke', clear: true });
  const value = await call('browser_evaluate', { tabId, expression: 'document.querySelector("#text").value' });
  assert(textOf(value).includes('typed by smoke'), `type verification failed: ${textOf(value)}`);
  log('click and type ok');
  const consoleResult = await call('browser_console', { tabId });
  assert(textOf(consoleResult).includes('SMOKE_CONSOLE_MARKER'), 'console marker was not captured');
  const networkResult = await call('browser_network', { tabId, filter: '/api' });
  assert(textOf(networkResult).includes('/api'), 'network request was not captured');
  log('console and network ok');
  await call('browser_upload_file', { tabId, selector: '#file', filePath: UPLOAD });
  const files = await call('browser_evaluate', { tabId, expression: 'document.querySelector("#file").files[0]?.name' });
  assert(textOf(files).includes('smoke-upload.txt'), `upload verification failed: ${textOf(files)}`);
  log('upload ok');
  await call('browser_tabs', { action: 'close', tabId }); tabId = undefined;
  log('PASS: real Chrome profile, reconnect, and all requested tools verified');
}

main().catch(error => { console.error('[smoke] FAIL:', error.message); process.exitCode = 1; }).finally(async () => {
  if (client) client.close();
  if (tabId !== undefined) { try { await call('browser_tabs', { action: 'close', tabId }); } catch {} }
  if (server) await new Promise(resolve => server.close(resolve));
  if (startedByTest) await stopDaemon();
  try { fs.unlinkSync(UPLOAD); } catch {}
});
