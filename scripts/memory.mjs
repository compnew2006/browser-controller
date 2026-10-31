#!/usr/bin/env node
/**
 * Owner CLI for website memory. It talks to the running daemon over the local IPC socket
 * (token hello, then `memory-admin` messages) and prints the daemon's answer as JSON.
 *
 *   node scripts/memory.mjs status
 *   node scripts/memory.mjs enable | disable
 *   node scripts/memory.mjs exclude <origin> | include <origin>
 *   node scripts/memory.mjs inspect <origin> | export
 *   node scripts/memory.mjs delete <origin> | delete --all
 *
 * Site map (per browser profile; --browser <id> picks one):
 *   node scripts/memory.mjs map status [--browser <id>]
 *   node scripts/memory.mjs map enable --browser <id> | map disable --browser <id>
 *   node scripts/memory.mjs map exclude-path <origin> <path> | map include-path <origin> <path>
 *   node scripts/memory.mjs map inspect <origin> [--browser <id>] | map export [--browser <id>]
 *   node scripts/memory.mjs map delete <origin> [<path>] [--browser <id>] | map delete --all [--browser <id>]
 *
 * Exit codes: 0 done, 1 the daemon refused the command, 2 usage error (nothing sent),
 * 3 the daemon is not reachable or denied the hello, 4 the daemon cannot serve `memory-admin`
 * (nothing sent). The token is read from the state directory and never printed.
 * State directory: BC_STATE_DIR, else ~/.browser-controller.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { buildIpcHello, MEMORY_ADMIN_CAPABILITY } = await import(pathToFileURL(path.join(ROOT, 'mcp-server', 'dist', 'protocol', 'index.js')).href);

const STATE_DIR = process.env.BC_STATE_DIR || path.join(os.homedir(), '.browser-controller');
const SOCKET = process.platform === 'win32' ? '\\\\.\\pipe\\browser-controller' : path.join(STATE_DIR, 'daemon.sock');
const TIMEOUT_MS = 30_000;
const USAGE = 'usage: memory.mjs status | enable | disable | exclude <origin> | include <origin> | inspect <origin> | export | delete <origin> | delete --all | map <command> (see the file header)';

const fail = (code, message) => {
  console.error(message);
  process.exit(code);
};

function origin(value) {
  let url;
  try { url = new URL(value); } catch { fail(2, `INVALID_ARGUMENT: "${value}" is not an origin (example: https://example.com)`); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') fail(2, 'INVALID_ARGUMENT: only http and https origins are supported');
  return url.origin;
}

function mapPath(value) {
  if (!/^\/[^?#]*$/.test(value) || value.length > 200) fail(2, 'INVALID_ARGUMENT: a path starts with "/" and has no query or fragment (example: /account)');
  return value;
}

/** `map <command> ...`: the --browser and --all flags anywhere, then the positional arguments. */
function parseMap(argv) {
  const [command, ...rest] = argv;
  const positional = [];
  const map = { command };
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--browser' && rest[i + 1]) map.browser = rest[(i += 1)];
    else if (rest[i] === '--all') map.all = true;
    else positional.push(rest[i]);
  }
  const need = (count) => { if (positional.length !== count) fail(2, USAGE); };
  switch (command) {
    case 'status': case 'export':
      need(0);
      break;
    case 'enable': case 'disable':
      need(0);
      if (!map.browser) fail(2, `map ${command} needs --browser <id> (browser_tabs lists the ids)`);
      break;
    case 'exclude-path': case 'include-path':
      need(2);
      map.origin = origin(positional[0]);
      map.path = mapPath(positional[1]);
      break;
    case 'inspect':
      need(1);
      map.origin = origin(positional[0]);
      break;
    case 'delete':
      if (map.all) { need(0); break; }
      if (positional.length < 1 || positional.length > 2) fail(2, USAGE);
      map.origin = origin(positional[0]);
      if (positional[1] !== undefined) map.path = mapPath(positional[1]);
      break;
    default:
      return fail(2, USAGE);
  }
  if (map.all && command !== 'delete') fail(2, '--all is only valid with map delete');
  return { command: 'map', map };
}

function parse(argv) {
  const [command, ...rest] = argv;
  if (command === 'map') return parseMap(rest);
  const need = (count) => { if (rest.length !== count) fail(2, USAGE); };
  switch (command) {
    case 'status': case 'enable': case 'disable': case 'export':
      need(0);
      return { command };
    case 'exclude': case 'include': case 'inspect':
      need(1);
      return { command, origin: origin(rest[0]) };
    case 'delete':
      if (rest.length === 1 && rest[0] === '--all') return { command, all: true };
      need(1);
      return { command, origin: origin(rest[0]) };
    default:
      return fail(2, USAGE);
  }
}

function readToken() {
  try {
    const { token } = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'token.json'), 'utf8'));
    if (typeof token === 'string' && token) return token;
  } catch { /* handled below */ }
  return fail(3, `daemon not set up: no token in ${STATE_DIR}. Start it with: npm run daemon:start`);
}

const request = { kind: 'memory-admin', id: `cli-${crypto.randomBytes(6).toString('hex')}`, ...parse(process.argv.slice(2)) };
const token = readToken();

const socket = net.createConnection(SOCKET);
socket.setEncoding('utf8');
let buffer = '';
let sent = false;
const timer = setTimeout(() => fail(3, 'TIMEOUT: the daemon did not answer'), TIMEOUT_MS);

socket.on('error', (error) => fail(3, `daemon not reachable at ${SOCKET} (${error.code ?? error.message}). Start it with: npm run daemon:start`));
socket.on('close', () => fail(3, 'the daemon closed the connection before answering'));
socket.on('connect', () => socket.write(`${JSON.stringify(buildIpcHello(token, 'memory-cli'))}\n`));
socket.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.kind === 'denied') fail(3, `the daemon denied the connection: ${String(message.reason ?? 'unknown reason')}`);
    if (message.kind === 'ping') { socket.write(`${JSON.stringify({ kind: 'pong' })}\n`); continue; }
    if (message.kind === 'welcome') {
      if (!Array.isArray(message.capabilities) || !message.capabilities.includes(MEMORY_ADMIN_CAPABILITY)) {
        fail(4, 'this daemon is too old for memory commands (no memory-admin capability). Restart it from the current build: npm run daemon:restart');
      }
      sent = true;
      socket.write(`${JSON.stringify(request)}\n`);
    } else if (message.kind === 'memory-admin-result' && message.id === request.id) {
      clearTimeout(timer);
      process.stdout.write(`${JSON.stringify(message, null, 2)}\n`);
      process.exit(message.success ? 0 : 1);
    }
  }
});
