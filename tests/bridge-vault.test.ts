import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { ExtensionBridge } from '../mcp-server/src/bridge.js';
import { CREDENTIAL_VAULT_CAPABILITY, EXTENSION_PROTOCOL_CAPABILITIES, VAULT_SITE_APPROVAL_CAPABILITY } from '../mcp-server/src/protocol.js';
import { authenticatedHelloAck, sendAuthInit, testBridgeCredentials } from './helpers/bridge-auth.js';

let port = 31_000 + (process.pid % 3_000);
const sockets: WebSocket[] = [];
const bridges: ExtensionBridge[] = [];

afterEach(async () => {
  sockets.forEach((socket) => { try { socket.close(); } catch { /* already closed */ } });
  sockets.length = 0;
  bridges.forEach((bridge) => bridge.stop());
  bridges.length = 0;
  await new Promise((resolve) => setTimeout(resolve, 40));
});

function startBridge() {
  const bridge = new ExtensionBridge({ port: ++port, ...testBridgeCredentials(), maxRetries: 0, pingIntervalMs: 60_000, defaultTimeoutMs: 150 });
  bridges.push(bridge);
  return bridge.start().then(() => bridge);
}

async function connectExtension(
  targetPort: number,
  browserId: string,
  options: { vault?: boolean; siteApproval?: boolean; onFrame?: (socket: WebSocket, frame: Record<string, any>) => void } = {},
) {
  const socket = new WebSocket(`ws://127.0.0.1:${targetPort}`);
  sockets.push(socket);
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    if (message.type === 'hello') {
      const capabilities = options.vault === false
        ? EXTENSION_PROTOCOL_CAPABILITIES.filter((capability) => capability !== CREDENTIAL_VAULT_CAPABILITY)
        : options.siteApproval === false
          ? EXTENSION_PROTOCOL_CAPABILITIES.filter((capability) => capability !== VAULT_SITE_APPROVAL_CAPABILITY)
          : undefined;
      const ack = authenticatedHelloAck(message, {
        browserId,
        browserLabel: `Fixture ${browserId}`,
        ...(capabilities ? { capabilities } : {}),
      });
      socket.send(ack);
      return;
    }
    options.onFrame?.(socket, message);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  sendAuthInit(socket);
  await new Promise((resolve) => setTimeout(resolve, 35));
  return socket;
}

describe('credential vault bridge boundary', () => {
  it('negotiates the vault capability without disabling base tools for an older extension', async () => {
    const bridge = await startBridge();
    const browser = await connectExtension(bridge['port'], 'fixture-old', {
      vault: false,
      onFrame(socket, frame) {
        if (frame.tool === 'browser_snapshot') socket.send(JSON.stringify({ id: frame.id, success: true, result: { text: 'fixture' } }));
      },
    });
    const context = bridge.vaultTransport.getBrowserContext('session-old');
    expect(context.supportsVault).toBe(false);
    await expect(bridge.callTool('browser_snapshot', { tabId: 1 }, 'session-old')).resolves.toMatchObject({ text: 'fixture' });
    await expect(bridge.vaultTransport.callAction('inspect', { tabId: 1 }, 'session-old')).rejects.toThrow(/VAULT_EXTENSION_REQUIRED/);
    expect(browser.readyState).toBe(WebSocket.OPEN);
  });

  it('uses a unique connection epoch and revokes the old epoch on profile reconnect', async () => {
    const bridge = await startBridge();
    const revoked: Array<{ browserId: string; connectionId: string }> = [];
    bridge.vaultTransport.setService({ revokeConnection(browserId: string, connectionId: string) { revoked.push({ browserId, connectionId }); } } as any);
    const first = await connectExtension(bridge['port'], 'fixture-profile');
    const firstContext = bridge.vaultTransport.getBrowserContext('session-epoch');
    await connectExtension(bridge['port'], 'fixture-profile');
    expect(first.readyState === WebSocket.CLOSED || first.readyState === WebSocket.CLOSING).toBe(true);
    expect(revoked).toContainEqual({ browserId: 'fixture-profile', connectionId: firstContext.connectionId });
    expect(bridge.vaultTransport.getBrowserContext('session-epoch').connectionId).not.toBe(firstContext.connectionId);
  });

  it('can leave a disconnected selected profile and pins the tabs reply to the newly selected browser', async () => {
    const bridge = await startBridge();
    const first = await connectExtension(bridge['port'], 'profile-a');
    await connectExtension(bridge['port'], 'profile-b', {
      onFrame(socket, frame) {
        if (frame.tool === 'browser_tabs') socket.send(JSON.stringify({
          id: frame.id, success: true, result: { success: true, text: 'tabs from profile-b' },
        }));
      },
    });
    bridge.vaultTransport.selectBrowser('session-switch', 'profile-a');
    expect(bridge.vaultTransport.getBrowserContext('session-switch').browserId).toBe('profile-a');
    const closed = new Promise<void>((resolve) => first.once('close', () => resolve()));
    first.close();
    await closed;

    bridge.vaultTransport.selectBrowser('session-switch', 'auto');
    expect(bridge.vaultTransport.getBrowserContext('session-switch').browserId).toBe('profile-b');
    const tabs = await bridge.callTool('browser_tabs', { action: 'list' }, 'session-switch') as { text: string };
    expect(tabs.text).toContain('tabs from profile-b');
  });

  it('dispatches a private fill once and never retries after abort', async () => {
    const bridge = await startBridge();
    let fills = 0;
    let fillStarted!: () => void;
    const started = new Promise<void>((resolve) => { fillStarted = resolve; });
    await connectExtension(bridge['port'], 'fixture-profile', {
      onFrame(_socket, frame) {
        if (frame.type === 'vaultAction' && frame.action === 'fill') {
          fills++;
          fillStarted();
        }
      },
    });
    const controller = new AbortController();
    const fill = bridge.vaultTransport.callAction('fill', {
      tabId: 5, origin: 'https://fixture.test', documentId: 'doc-5', targetDocumentId: 'doc-5', frameId: 0,
      nonce: 'nonce-5', password: 'synthetic-only',
    }, 'session-fill', controller.signal);
    await started;
    controller.abort();
    await expect(fill).rejects.toThrow(/cancelled/);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(fills).toBe(1);
  });

  it('accepts private UI and protection messages only from the negotiated browser connection', async () => {
    const bridge = await startBridge();
    let received: Record<string, unknown> | undefined;
    bridge.vaultTransport.setService({
      async handlePrivateUi(connection: Record<string, unknown>, payload: unknown) {
        received = { ...connection, payload };
        return { success: true, status: 'fixture' };
      },
      noteProtectionState(browserId: string, connectionId: string, sequence: number, documents: unknown) {
        received = { browserId, connectionId, sequence, documents };
      },
      discardProtectedTab(browserId: string, connectionId: string, tabId: number, documentIds: unknown) {
        received = { browserId, connectionId, tabId, documentIds };
      },
    } as any);
    let socket!: WebSocket;
    const replies = new Map<string, (message: Record<string, any>) => void>();
    const uiReply = new Promise<Record<string, any>>((resolve) => { replies.set('ui_11111111111111111111111111111111', resolve); });
    socket = await connectExtension(bridge['port'], 'fixture-private', {
      onFrame(_socket, frame) {
        if (frame.type === 'vaultUiResponse') replies.get(frame.id)?.(frame);
      },
    });
    const context = bridge.vaultTransport.getBrowserContext('session-private');
    socket.send(JSON.stringify({ type: 'vaultUiRequest', id: 'ui_11111111111111111111111111111111', payload: { operation: 'getState' } }));
    await expect(uiReply).resolves.toMatchObject({ result: { success: true, status: 'fixture' } });
    expect(received).toMatchObject({ browserId: 'fixture-private', connectionId: context.connectionId, payload: { operation: 'getState' } });

    socket.send(JSON.stringify({ type: 'vaultProtectionState', sequence: 9, documents: [] }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(received).toMatchObject({ browserId: 'fixture-private', connectionId: context.connectionId, sequence: 9, documents: [] });
  });

  describe('site approval capability (specs/006)', () => {
    const fillBase = {
      tabId: 5, origin: 'https://fixture.test', documentId: 'doc-5', targetDocumentId: 'doc-5', frameId: 0, nonce: 'nonce-5',
    };
    const card = {
      tabId: 5, requestId: 'req_fixture', documentId: 'doc-5', origin: 'https://fixture.test', purpose: 'list',
      browserLabel: 'Fixture', agentName: 'FixtureAgent', unlock: false, expiresAt: 1_000,
    };

    it('keeps an extension without it on the private page and the password-only fill', async () => {
      const bridge = await startBridge();
      await connectExtension(bridge['port'], 'fixture-older', { siteApproval: false });
      expect(bridge.vaultTransport.getBrowserContext('session-older')).toMatchObject({ supportsVault: true, supportsSiteApproval: false });
      await expect(bridge.vaultTransport.callAction('prompt', card, 'session-older')).rejects.toThrow(/VAULT_EXTENSION_REQUIRED/);
      await expect(bridge.vaultTransport.callAction('promptClose', { tabId: 5, requestId: 'req_fixture' }, 'session-older')).rejects.toThrow(/VAULT_EXTENSION_REQUIRED/);
      const { connectionId } = bridge.vaultTransport.getBrowserContext('session-older');
      await expect(bridge.vaultTransport.closeCard(connectionId, { tabId: 5, requestId: 'req_fixture' }, 'session-older')).resolves.toEqual({ success: true, closed: false });
      await expect(bridge.vaultTransport.callAction('inspect', { tabId: 5, withIdentifier: true }, 'session-older')).rejects.toThrow(/INVALID_ARGUMENT/);
      await expect(bridge.vaultTransport.callAction('fill', { ...fillBase, password: 'synthetic-only', identifier: 'fixture-user' }, 'session-older'))
        .rejects.toThrow(/INVALID_ARGUMENT/);
    });

    it('sends well-formed card, inspection and username fills, and refuses malformed ones before sending', async () => {
      const bridge = await startBridge();
      const sent: Array<Record<string, any>> = [];
      await connectExtension(bridge['port'], 'fixture-card', {
        onFrame(socket, frame) {
          if (frame.type !== 'vaultAction') return;
          sent.push(frame);
          socket.send(JSON.stringify({ type: 'vaultActionResponse', id: frame.id, success: true, result: { success: true, shown: true } }));
        },
      });
      expect(bridge.vaultTransport.getBrowserContext('session-card')).toMatchObject({ supportsSiteApproval: true });
      await expect(bridge.vaultTransport.callAction('prompt', card, 'session-card')).resolves.toMatchObject({ shown: true });
      await expect(bridge.vaultTransport.callAction('promptClose', { tabId: 5, requestId: 'req_fixture' }, 'session-card')).resolves.toBeDefined();
      await expect(bridge.vaultTransport.callAction('inspect', { tabId: 5, withIdentifier: true }, 'session-card')).resolves.toBeDefined();
      await expect(bridge.vaultTransport.callAction('fill', { ...fillBase, identifier: 'fixture-user' }, 'session-card')).resolves.toBeDefined();

      for (const malformed of [
        { ...card, extra: true },
        { ...card, purpose: 'save' },
        { ...card, agentName: 'x'.repeat(121) },
        { ...card, unlock: 'no' },
        { ...card, documentId: '' },
      ]) {
        await expect(bridge.vaultTransport.callAction('prompt', malformed, 'session-card')).rejects.toThrow(/INVALID_ARGUMENT/);
      }
      await expect(bridge.vaultTransport.callAction('promptClose', { tabId: 5, requestId: 'req_fixture', origin: 'x' }, 'session-card')).rejects.toThrow(/INVALID_ARGUMENT/);
      await expect(bridge.vaultTransport.callAction('inspect', { tabId: 5, withIdentifier: false }, 'session-card')).rejects.toThrow(/INVALID_ARGUMENT/);
      await expect(bridge.vaultTransport.callAction('fill', fillBase, 'session-card')).rejects.toThrow(/INVALID_ARGUMENT/);
      await expect(bridge.vaultTransport.callAction('fill', { ...fillBase, identifier: 7 }, 'session-card')).rejects.toThrow(/INVALID_ARGUMENT/);
      expect(sent.map((frame) => frame.action)).toEqual(['prompt', 'promptClose', 'inspect', 'fill']);
    });

    it('takes a card down through the connection that drew it, after the asking session ended', async () => {
      const bridge = await startBridge();
      const recorder = (frames: Array<Record<string, any>>) => (socket: WebSocket, frame: Record<string, any>) => {
        if (frame.type !== 'vaultAction') return;
        frames.push(frame);
        socket.send(JSON.stringify({ type: 'vaultActionResponse', id: frame.id, success: true, result: { success: true, closed: true } }));
      };
      const primary: Array<Record<string, any>> = [];
      const other: Array<Record<string, any>> = [];
      await connectExtension(bridge['port'], 'fixture-a', { onFrame: recorder(primary) });
      await connectExtension(bridge['port'], 'fixture-b', { onFrame: recorder(other) });
      bridge.vaultTransport.selectBrowser('session-b', 'fixture-b');
      const { connectionId } = bridge.vaultTransport.getBrowserContext('session-b');
      // 'session-gone' selected no browser: routed by session, the close would reach the primary browser instead.
      await expect(bridge.vaultTransport.closeCard(connectionId, { tabId: 5, requestId: 'req_fixture' }, 'session-gone')).resolves.toMatchObject({ closed: true });
      expect(other.map((frame) => [frame.action, frame.params])).toEqual([['promptClose', { tabId: 5, requestId: 'req_fixture' }]]);
      expect(primary).toEqual([]);
      await expect(bridge.vaultTransport.closeCard('connection-unknown', { tabId: 5, requestId: 'req_fixture' }, 'session-gone')).resolves.toEqual({ success: true, closed: false });
      expect(primary).toEqual([]);
      expect(other).toHaveLength(1);
    });
  });
});
