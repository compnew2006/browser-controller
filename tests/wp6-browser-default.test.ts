import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { ExtensionBridge } from '../mcp-server/src/bridge.js';
import { buildExtensionHelloAck } from '../mcp-server/src/protocol.js';

/**
 * WP6 item 3: the default browser is the EARLIEST-seen live browser. A browser
 * keeps its place across reconnects (service-worker recycles), so connecting a
 * second browser, or recycling the other one, never moves new sessions.
 */
let port = 40_000 + (process.pid % 4_000); // own band: other suites use 20k-28k and 30k-35k
const sockets: WebSocket[] = [];
const bridges: ExtensionBridge[] = [];

afterEach(async () => {
  sockets.forEach((s) => { try { s.close(); } catch { /* closed */ } });
  sockets.length = 0;
  bridges.forEach((b) => b.stop());
  bridges.length = 0;
  await new Promise((r) => setTimeout(r, 30));
});

async function startBridge() {
  const bridge = new ExtensionBridge({ port: ++port, maxRetries: 0, pingIntervalMs: 60_000, handshakeGraceMs: 500 });
  bridges.push(bridge);
  await bridge.start();
  return { bridge, port };
}

/** A fake extension: announces its browser identity and answers tool calls with its name. */
async function fakeBrowser(p: number, browserId: string) {
  const ws = new WebSocket(`ws://localhost:${p}`);
  sockets.push(ws);
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'hello') ws.send(JSON.stringify({ ...buildExtensionHelloAck('test'), browserId, browserLabel: `Chrome ${browserId}` }));
    if (msg.tool) ws.send(JSON.stringify({ id: msg.id, success: true, result: { from: browserId } }));
  });
  await new Promise<void>((resolve, reject) => { ws.on('open', () => resolve()); ws.on('error', reject); });
  await new Promise((r) => setTimeout(r, 60));
  return ws;
}

describe('default browser is the earliest-seen live browser', () => {
  it('a browser connected later does not take over new sessions', async () => {
    const { bridge, port: p } = await startBridge();
    await fakeBrowser(p, 'work');
    await fakeBrowser(p, 'home');
    const { browsers } = await (bridge.callTool('browser_list_browsers', {}, 's1') as Promise<any>);
    expect(browsers.find((b: any) => b.default).browserId).toBe('work');
    expect(await bridge.callTool('browser_tabs', { action: 'list' }, 's2')).toEqual({ from: 'work' });
  });

  it('a service-worker recycle of the other browser does not move the default', async () => {
    const { bridge, port: p } = await startBridge();
    await fakeBrowser(p, 'work');
    const homeFirst = await fakeBrowser(p, 'home');
    const homeClosed = new Promise<void>((r) => homeFirst.once('close', () => r()));
    await fakeBrowser(p, 'home'); // home's worker came back: a new socket, same browserId
    await homeClosed;
    expect(await bridge.callTool('browser_tabs', { action: 'list' }, 's2')).toEqual({ from: 'work' });
  });

  it('when the default disconnects the next earliest one takes over, and the returning one regains its place', async () => {
    const { bridge, port: p } = await startBridge();
    const work = await fakeBrowser(p, 'work');
    await fakeBrowser(p, 'home');
    work.close();
    await new Promise((r) => setTimeout(r, 60));
    expect(await bridge.callTool('browser_tabs', { action: 'list' }, 's2')).toEqual({ from: 'home' });
    await fakeBrowser(p, 'work');
    expect(await bridge.callTool('browser_tabs', { action: 'list' }, 's3')).toEqual({ from: 'work' });
  });
});
