import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { ExtensionBridge } from '../mcp-server/src/bridge.js';
import { authenticatedHelloAck, sendAuthInit, testBridgeCredentials } from './helpers/bridge-auth.js';
import { freePort } from './helpers/free-port.js';

/**
 * F4-2: when an extension connection becomes ready the bridge sends that connection (only) the
 * live session ids, so the extension frees locks whose release was lost while it was away.
 */
// The OS assigns the port: vitest runs test files in parallel, and a range
// picked by arithmetic can collide with another file in the same run.
let port = 0;
const sockets: WebSocket[] = [];
const bridges: ExtensionBridge[] = [];

afterEach(async () => {
  sockets.forEach((s) => { try { s.close(); } catch { /* closed */ } });
  sockets.length = 0;
  bridges.forEach((b) => b.stop());
  bridges.length = 0;
  await new Promise((r) => setTimeout(r, 30));
});

async function startBridge(roster?: () => string[]) {
  port = await freePort();
  const bridge = new ExtensionBridge({ port, ...testBridgeCredentials(), maxRetries: 0, pingIntervalMs: 60_000, handshakeGraceMs: 500 });
  if (roster) bridge.setSessionRoster(roster);
  bridges.push(bridge);
  await bridge.start();
  return bridge;
}

/** A fake extension that records every frame it receives and answers the hello. */
async function connectBrowser(p: number, browserId: string) {
  const ws = new WebSocket(`ws://localhost:${p}`);
  sockets.push(ws);
  const frames: Array<Record<string, unknown>> = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    frames.push(msg);
    if (msg.type === 'hello') ws.send(authenticatedHelloAck(msg, { browserId, browserLabel: `Chrome ${browserId}` }));
  });
  await new Promise<void>((resolve, reject) => { ws.on('open', () => resolve()); ws.on('error', reject); });
  sendAuthInit(ws);
  await new Promise((r) => setTimeout(r, 80));
  return { ws, frames };
}

const rosters = (frames: Array<Record<string, unknown>>) => frames.filter((f) => f.type === 'sessionRoster');

describe('session roster on connection ready (F4-2)', () => {
  it('sends the live session ids to the connection that became ready, after authentication', async () => {
    const bridge = await startBridge(() => ['s1', 's2']);
    const a = await connectBrowser(port, 'a');
    expect(rosters(a.frames)).toEqual([{ type: 'sessionRoster', sessionIds: ['s1', 's2'] }]);
    expect(a.frames.findIndex((f) => f.type === 'hello')).toBeLessThan(a.frames.findIndex((f) => f.type === 'sessionRoster'));
    expect(bridge.isConnected()).toBe(true);
  });

  it('a second browser getting ready does not send the roster to the first', async () => {
    await startBridge(() => ['s1']);
    const a = await connectBrowser(port, 'a');
    const b = await connectBrowser(port, 'b');
    expect(rosters(a.frames)).toHaveLength(1);
    expect(rosters(b.frames)).toEqual([{ type: 'sessionRoster', sessionIds: ['s1'] }]);
  });

  it('sends an empty roster when no session is live, and none without a provider', async () => {
    await startBridge(() => []);
    const a = await connectBrowser(port, 'a');
    expect(rosters(a.frames)).toEqual([{ type: 'sessionRoster', sessionIds: [] }]);
    const bare = await startBridge();
    const b = await connectBrowser(port, 'b');
    expect(rosters(b.frames)).toEqual([]);
    expect(bare.isConnected()).toBe(true);
  });
});
