#!/usr/bin/env node
/**
 * Minimal thin-client driver that talks to the daemon over its IPC socket.
 * Usage: node scripts/drive.mjs <tool> [json params]
 *   e.g. node scripts/drive.mjs browser_tabs '{"action":"list"}'
 * Authenticates with the token from ~/.browser-controller/token.json, sends a
 * `hello` + `call`, prints the JSON result. This is exactly what Cursor does.
 */
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const STATE = path.join(os.homedir(), '.browser-controller');
const token = JSON.parse(fs.readFileSync(path.join(STATE, 'token.json'), 'utf8')).token;
const sockPath = path.join(STATE, 'daemon.sock');

const tool = process.argv[2];
if (!tool) { console.error('usage: drive.mjs <tool> [json params]'); process.exit(1); }
let params = {};
if (process.argv[3]) params = JSON.parse(process.argv[3]);

const sock = net.createConnection(sockPath);
sock.setEncoding('utf8');
let buf = '';
let callId = '1';
let authed = false;

sock.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.kind === 'welcome') {
      authed = true;
      sock.write(JSON.stringify({ kind: 'call', id: callId, tool, params }) + '\n');
    } else if (msg.kind === 'denied') {
      console.error('DENIED:', msg.reason); process.exit(1);
    } else if (msg.kind === 'result') {
      console.log(JSON.stringify(msg, null, 2));
      process.exit(msg.success === false ? 1 : 0);
    }
  }
});
sock.on('error', (e) => { console.error('socket error:', e.message); process.exit(1); });
sock.write(JSON.stringify({ kind: 'hello', token, agentName: 'CLI-driver' }) + '\n');
setTimeout(() => { console.error('TIMEOUT (no result)'); process.exit(2); }, 60_000);
