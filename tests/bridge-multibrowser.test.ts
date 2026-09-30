import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { ExtensionBridge } from '../mcp-server/src/bridge.js';
import { buildExtensionHelloAck } from '../mcp-server/src/protocol.js';
import { buildExtensionHelloAck as extensionHelloAck } from '../extension/lib/protocol.js';

let port = 26_000 + (process.pid % 3_000);
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

/** A fake extension: answers the hello with its browser identity and echoes tool calls with its name. */
async function fakeBrowser(p: number, browserId: string, opts: { silent?: boolean } = {}) {
  const ws = new WebSocket(`ws://localhost:${p}`);
  sockets.push(ws);
  const calls: string[] = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'hello') ws.send(JSON.stringify({ ...buildExtensionHelloAck('test'), browserId, browserLabel: `Chrome ${browserId}` }));
    if (msg.tool) {
      calls.push(msg.tool);
      if (!opts.silent) ws.send(JSON.stringify({ id: msg.id, success: true, result: { from: browserId } }));
    }
  });
  await new Promise<void>((resolve, reject) => { ws.on('open', () => resolve()); ws.on('error', reject); });
  await new Promise((r) => setTimeout(r, 60));
  return { ws, calls };
}

describe('multi-browser bridge', () => {
  it('keeps several browsers connected; the newest is the default', async () => {
    const { bridge, port: p } = await startBridge();
    await fakeBrowser(p, 'work');
    await fakeBrowser(p, 'home');
    const list = bridge.callTool('browser_list_browsers', {}, 's1') as Promise<any>;
    const { browsers } = await list;
    expect(browsers.map((b: any) => b.browserId).sort()).toEqual(['home', 'work']);
    expect(browsers.find((b: any) => b.default).browserId).toBe('home');
    expect(await bridge.callTool('browser_tabs', { action: 'list' }, 's1')).toEqual({ from: 'home' });
  });

  it('routes a session to the browser it selected, other sessions keep the default', async () => {
    const { bridge, port: p } = await startBridge();
    await fakeBrowser(p, 'work');
    await fakeBrowser(p, 'home');
    expect(await bridge.callTool('browser_select_browser', { browserId: 'Chrome work' }, 's1')).toMatchObject({ selected: 'work' });
    expect(await bridge.callTool('browser_tabs', { action: 'list' }, 's1')).toEqual({ from: 'work' });
    expect(await bridge.callTool('browser_tabs', { action: 'list' }, 's2')).toEqual({ from: 'home' });
    await bridge.callTool('browser_select_browser', { browserId: 'auto' }, 's1');
    expect(await bridge.callTool('browser_tabs', { action: 'list' }, 's1')).toEqual({ from: 'home' });
    await expect(bridge.callTool('browser_select_browser', { browserId: 'nope' }, 's1')).rejects.toThrow(/No connected browser/);
  });

  it('a reconnect of the same browser replaces its old socket; a different browser is untouched', async () => {
    const { bridge, port: p } = await startBridge();
    const first = await fakeBrowser(p, 'work');
    await fakeBrowser(p, 'home');
    const firstClosed = new Promise<void>((r) => first.ws.once('close', () => r()));
    await fakeBrowser(p, 'work');
    await firstClosed;
    const { browsers } = await (bridge.callTool('browser_list_browsers', {}, 's1') as Promise<any>);
    expect(browsers.map((b: any) => b.browserId).sort()).toEqual(['home', 'work']);
  });

  it('one browser disconnecting fails only its own calls', async () => {
    const { bridge, port: p } = await startBridge();
    const work = await fakeBrowser(p, 'work', { silent: true });
    await fakeBrowser(p, 'home');
    await bridge.callTool('browser_select_browser', { browserId: 'work' }, 's1');
    const hanging = bridge.callTool('browser_wait', { delay: 10 }, 's1');
    await new Promise((r) => setTimeout(r, 50));
    work.ws.close();
    await expect(hanging).rejects.toThrow(/disconnected/);
    expect(await bridge.callTool('browser_tabs', { action: 'list' }, 's2')).toEqual({ from: 'home' });
    // The session that picked the gone browser gets a clear error, not the wrong browser.
    await expect(bridge.callTool('browser_tabs', { action: 'list' }, 's1')).rejects.toThrow(/not connected/);
  });

  it('releasing a session forgets its browser choice', async () => {
    const { bridge, port: p } = await startBridge();
    await fakeBrowser(p, 'work');
    await fakeBrowser(p, 'home');
    await bridge.callTool('browser_select_browser', { browserId: 'work' }, 's1');
    bridge.sendControl('releaseSession', { sessionId: 's1' });
    expect(await bridge.callTool('browser_tabs', { action: 'list' }, 's1')).toEqual({ from: 'home' });
  });

  it('the extension announces its browser identity in helloAck', () => {
    expect(extensionHelloAck('2.4.0', { browserId: 'abc123', browserLabel: 'Chrome on Windows (abc1)' }))
      .toMatchObject({ type: 'helloAck', browserId: 'abc123', browserLabel: 'Chrome on Windows (abc1)' });
    expect(extensionHelloAck('2.4.0')).not.toHaveProperty('browserId');
  });
});
