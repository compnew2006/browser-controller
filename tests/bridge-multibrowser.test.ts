import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { ExtensionBridge } from '../mcp-server/src/bridge.js';
import { authenticatedHelloAck, sendAuthInit, testBridgeCredentials } from './helpers/bridge-auth.js';
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
  const bridge = new ExtensionBridge({ port: ++port, ...testBridgeCredentials(), maxRetries: 0, pingIntervalMs: 60_000, handshakeGraceMs: 500 });
  bridges.push(bridge);
  await bridge.start();
  return { bridge, port };
}

/** A fake extension: answers the hello with its browser identity and echoes tool calls with its name. */
async function fakeBrowser(p: number, browserId: string, opts: { silent?: boolean; listText?: string } = {}) {
  const ws = new WebSocket(`ws://localhost:${p}`);
  sockets.push(ws);
  const calls: string[] = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'hello') ws.send(authenticatedHelloAck(msg, { browserId, browserLabel: `Chrome ${browserId}` }));
    if (msg.tool) {
      calls.push(msg.tool);
      // silent: never answers a call, except a browser_tabs list (the bridge selects the browser before it lists).
      if (opts.silent && msg.tool !== 'browser_tabs') return;
      // A tab list answers with text (what the agent reads); other calls answer with machine data only.
      const result = msg.tool === 'browser_tabs'
        ? (opts.listText !== undefined ? { success: true, text: opts.listText } : { from: browserId, text: `tabs of ${browserId}` })
        : { from: browserId };
      ws.send(JSON.stringify({ id: msg.id, success: true, result }));
    }
  });
  await new Promise<void>((resolve, reject) => { ws.on('open', () => resolve()); ws.on('error', reject); });
  sendAuthInit(ws);
  await new Promise((r) => setTimeout(r, 60));
  return { ws, calls };
}

/** The browsers a session sees, as browser_tabs lists them (one header line each once several are connected). */
async function browsersSeen(bridge: ExtensionBridge, sessionId: string) {
  const res = await bridge.callTool('browser_tabs', { action: 'list' }, sessionId) as { text: string };
  return [...res.text.matchAll(/^browser (\S+) "([^"]*)"( \(selected\))?$/gm)]
    .map((m) => ({ browserId: m[1], label: m[2], selected: m[3] !== undefined }));
}

/** The browser that answered this session's browser_tabs list (a fake's text ends with "tabs of <browserId>"). */
async function answeredBy(bridge: ExtensionBridge, sessionId: string, browser?: string): Promise<string> {
  const params = browser === undefined ? { action: 'list' } : { action: 'list', browser };
  const res = await bridge.callTool('browser_tabs', params, sessionId) as { text: string };
  return res.text.split('\n').pop()!.replace(/^tabs of /, '');
}

describe('multi-browser bridge', () => {
  it('keeps several browsers connected; the first one seen is the default', async () => {
    const { bridge, port: p } = await startBridge();
    await fakeBrowser(p, 'work');
    await fakeBrowser(p, 'home');
    const browsers = await browsersSeen(bridge, 's1');
    expect(browsers.map((b) => b.browserId).sort()).toEqual(['home', 'work']);
    expect(browsers.find((b) => b.selected)?.browserId).toBe('work');
    expect(await answeredBy(bridge, 's1')).toBe('work');
  });

  it('routes a session to the browser it selected, other sessions keep the default', async () => {
    const { bridge, port: p } = await startBridge();
    await fakeBrowser(p, 'work');
    await fakeBrowser(p, 'home');
    expect(await answeredBy(bridge, 's1', 'Chrome home')).toBe('home');
    expect(await answeredBy(bridge, 's1')).toBe('home');
    expect(await answeredBy(bridge, 's2')).toBe('work');
    expect(await answeredBy(bridge, 's1', 'auto')).toBe('work');
    await expect(bridge.callTool('browser_tabs', { action: 'list', browser: 'nope' }, 's1')).rejects.toThrow(/^NOT_CONNECTED: No connected browser/);
  });

  it('a reconnect of the same browser replaces its old socket; a different browser is untouched', async () => {
    const { bridge, port: p } = await startBridge();
    const first = await fakeBrowser(p, 'work');
    await fakeBrowser(p, 'home');
    const firstClosed = new Promise<void>((r) => first.ws.once('close', () => r()));
    await fakeBrowser(p, 'work');
    await firstClosed;
    const browsers = await browsersSeen(bridge, 's1');
    expect(browsers.map((b) => b.browserId).sort()).toEqual(['home', 'work']);
  });

  it('one browser disconnecting fails only its own calls', async () => {
    const { bridge, port: p } = await startBridge();
    const work = await fakeBrowser(p, 'work', { silent: true });
    await fakeBrowser(p, 'home');
    await answeredBy(bridge, 's1', 'work');
    const hanging = bridge.callTool('browser_wait', { delay: 10 }, 's1');
    await new Promise((r) => setTimeout(r, 50));
    work.ws.close();
    await expect(hanging).rejects.toThrow(/disconnected/);
    expect(await answeredBy(bridge, 's2')).toBe('home');
    // The session that picked the gone browser gets a clear error, not the wrong browser.
    await expect(bridge.callTool('browser_tabs', { action: 'list' }, 's1')).rejects.toThrow(/^NOT_CONNECTED: Selected browser "work" is not connected/);
  });

  it('an auto session stays on its browser when another one connects (batch/retry safe)', async () => {
    const { bridge, port: p } = await startBridge();
    const work = await fakeBrowser(p, 'work');
    // Step 1 of a batch: click in "work" (the only browser).
    expect(await bridge.callTool('browser_click', { tabId: 7 }, 's1')).toEqual({ from: 'work' });
    const home = await fakeBrowser(p, 'home'); // connects later: does not become the default
    // Step 2 must not land in "home" with the same tabId.
    expect(await bridge.callTool('browser_type', { tabId: 7, text: 'x' }, 's1')).toEqual({ from: 'work' });
    expect(work.calls).toEqual(['browser_click', 'browser_type']);
    expect(home.calls).toEqual([]);
    // A new session takes the default (the first browser seen); list shows each session's own browser.
    expect(await answeredBy(bridge, 's2')).toBe('work');
    expect((await browsersSeen(bridge, 's1')).find((b) => b.selected)?.browserId).toBe('work');
    // A failed selection keeps the pin.
    await expect(bridge.callTool('browser_tabs', { action: 'list', browser: 'nope' }, 's1')).rejects.toThrow(/^NOT_CONNECTED: No connected browser/);
    expect(await bridge.callTool('browser_type', { tabId: 7, text: 'z' }, 's1')).toEqual({ from: 'work' });
    // Its browser gone: an error, never a silent switch to the other browser.
    work.ws.close();
    await new Promise((r) => setTimeout(r, 60));
    await expect(bridge.callTool('browser_type', { tabId: 7, text: 'y' }, 's1')).rejects.toThrow(/^NOT_CONNECTED: This session's browser "work" disconnected/);
    expect(home.calls).toEqual([]); // nothing was routed to the browser that connected later
    // Selecting "auto" again re-pins to the current default.
    expect(await answeredBy(bridge, 's1', 'auto')).toBe('home');
  });

  it('releasing a session forgets its browser choice', async () => {
    const { bridge, port: p } = await startBridge();
    await fakeBrowser(p, 'work');
    await fakeBrowser(p, 'home');
    await answeredBy(bridge, 's1', 'home');
    bridge.sendControl('releaseSession', { sessionId: 's1' });
    expect(await answeredBy(bridge, 's1')).toBe('work');
  });

  it('browser_tabs picks the session browser, and a list starts with one line per browser when several are connected', async () => {
    const { bridge, port: p } = await startBridge();
    await fakeBrowser(p, 'work', { listText: 'tabs of work' });
    await fakeBrowser(p, 'home', { listText: 'tabs of home' });
    const list = await bridge.callTool('browser_tabs', { action: 'list' }, 's1') as { text: string };
    expect(list.text).toBe('browser work "Chrome work" (selected)\nbrowser home "Chrome home"\n\ntabs of work');
    // browser: "home" selects it first; the list then shows home as selected, and the browser param never reaches the extension.
    const picked = await bridge.callTool('browser_tabs', { action: 'list', browser: 'home' }, 's1') as { text: string };
    expect(picked.text).toBe('browser work "Chrome work"\nbrowser home "Chrome home" (selected)\n\ntabs of home');
    // "auto" re-pins the session to the default.
    const auto = await bridge.callTool('browser_tabs', { action: 'list', browser: 'auto' }, 's1') as { text: string };
    expect(auto.text.split('\n')[0]).toBe('browser work "Chrome work" (selected)');
  });

  it('browser_tabs with one browser connected returns the extension text unchanged', async () => {
    const { bridge, port: p } = await startBridge();
    await fakeBrowser(p, 'work', { listText: 'only tabs' });
    expect(await bridge.callTool('browser_tabs', { action: 'list' }, 's1')).toEqual({ success: true, text: 'only tabs' });
  });

  it('browser_tabs close and focus get no browser lines, and an unknown browser fails before anything is sent', async () => {
    const { bridge, port: p } = await startBridge();
    const work = await fakeBrowser(p, 'work', { listText: 'x' });
    await fakeBrowser(p, 'home', { listText: 'x' });
    await bridge.callTool('browser_tabs', { action: 'focus', tabId: 7 }, 's1');
    expect(work.calls).toEqual(['browser_tabs']);
    await expect(bridge.callTool('browser_tabs', { action: 'list', browser: 'nope' }, 's1')).rejects.toThrow(/^NOT_CONNECTED: No connected browser "nope"/);
    expect(work.calls).toEqual(['browser_tabs']);
  });

  it('a browser selection without a client session is INVALID_ARGUMENT, not a connection problem', async () => {
    const { bridge, port: p } = await startBridge();
    await fakeBrowser(p, 'work');
    await expect(bridge.callTool('browser_tabs', { action: 'list', browser: 'work' })).rejects.toThrow(/^INVALID_ARGUMENT: Selecting a browser needs a client session/);
  });

  it('waiting for an extension that never connects says NOT_CONNECTED and what to check', async () => {
    const { bridge } = await startBridge();
    await expect(bridge.waitForConnection(50)).rejects.toThrow(
      /^NOT_CONNECTED: no Browser Controller extension connected within 0\.05 s; check that it is installed and enabled$/,
    );
  });

  it('the extension announces its browser identity in helloAck', () => {
    expect(extensionHelloAck('2.4.0', { browserId: 'abc123', browserLabel: 'Chrome on Windows (abc1)' }))
      .toMatchObject({ type: 'helloAck', browserId: 'abc123', browserLabel: 'Chrome on Windows (abc1)' });
    expect(extensionHelloAck('2.4.0')).not.toHaveProperty('browserId');
  });
});
