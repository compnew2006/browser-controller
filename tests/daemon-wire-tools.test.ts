import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildIpcHello } from '../mcp-server/src/protocol.js';
import { isKnownWireTool } from '../mcp-server/src/wire-tools.js';
import { allTools } from '../mcp-server/src/tools/index.js';
import { freePort } from './helpers/free-port.js';

/**
 * Daemon-side tool allow-list (audit F6-3): an authenticated IPC client other
 * than the MCP server must not push an arbitrary tool name to the extension.
 * The integration half runs the compiled daemon, as tests/daemon.test.ts does;
 * BC_TEST_DAEMON_JS points it at another build when dist is stale.
 */
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAEMON_JS = process.env.BC_TEST_DAEMON_JS || path.join(ROOT, 'mcp-server', 'dist', 'daemon.js');

describe('isKnownWireTool', () => {
  it('accepts every registered tool and the internal classify action', () => {
    for (const tool of allTools) expect(isKnownWireTool(tool.name)).toBe(true);
    expect(isKnownWireTool('browser_classify_action')).toBe(true);
  });

  it('refuses unknown or malformed names', () => {
    for (const name of ['browser_nope', '', 'constructor', '__proto__', 'browser_click ', undefined, 42]) {
      expect(isKnownWireTool(name)).toBe(false);
    }
  });
});

describe('daemon routeCall allow-list', { timeout: 30_000 }, () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-wire-'));
  const sock = path.join(stateDir, 'daemon.sock');
  let proc: ChildProcess | null = null;

  beforeAll(async () => {
    if (!fs.existsSync(DAEMON_JS)) throw new Error(`${DAEMON_JS} missing, run \`npm run build\` first`);
    proc = spawn(process.execPath, [DAEMON_JS], {
      // No extension ever connects here: keep the plain 5 s wait (no reconnect wait after the start).
      env: { ...process.env, BC_STATE_DIR: stateDir, BC_RECONNECT_WAIT_MS: '0', WS_PORT: String(await freePort()), WS_HOST: '127.0.0.1' },
      stdio: 'ignore',
    });
    for (let i = 0; i < 100; i++) {
      const up = await new Promise<boolean>((resolve) => {
        const s = net.createConnection(sock);
        s.once('connect', () => { s.destroy(); resolve(true); });
        s.once('error', () => resolve(false));
      });
      if (up) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('daemon never came up');
  });

  afterAll(() => {
    proc?.kill('SIGTERM');
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  /** Hello, then send each call and return the results by id. */
  function callAll(tools: string[]): Promise<Record<string, { success: boolean; error?: string }>> {
    const token = JSON.parse(fs.readFileSync(path.join(stateDir, 'token.json'), 'utf8')).token;
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(sock);
      socket.setEncoding('utf8');
      const out: Record<string, { success: boolean; error?: string }> = {};
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('timeout')); }, 8_000);
      let buf = '';
      socket.on('connect', () => socket.write(JSON.stringify(buildIpcHello(token, 'WireToolsTest')) + '\n'));
      socket.on('data', (chunk: string) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const msg = JSON.parse(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          if (msg.kind === 'welcome') {
            tools.forEach((tool, i) => socket.write(JSON.stringify({ kind: 'call', id: `c${i}`, tool, params: {} }) + '\n'));
          } else if (msg.kind === 'ping') {
            socket.write(JSON.stringify({ kind: 'pong' }) + '\n');
          } else if (msg.kind === 'result') {
            out[tools[Number(msg.id.slice(1))]] = msg;
            if (Object.keys(out).length === tools.length) { clearTimeout(timer); socket.destroy(); resolve(out); }
          }
        }
      });
      socket.on('error', reject);
    });
  }

  it('refuses an unknown tool with UNKNOWN_TOOL; registered and classify names still route', async () => {
    const res = await callAll(['browser_nope', 'browser_snapshot', 'browser_classify_action']);
    expect(res.browser_nope.success).toBe(false);
    expect(res.browser_nope.error).toMatch(/^UNKNOWN_TOOL: browser_nope/);
    // No extension is paired here: routed calls fail in the bridge, not at the allow-list.
    for (const name of ['browser_snapshot', 'browser_classify_action']) {
      expect(res[name].success).toBe(false);
      expect(res[name].error).not.toMatch(/^UNKNOWN_TOOL/);
    }
  });
});
