import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { ExtensionBridge } from '../mcp-server/src/bridge.js';
import { CREDENTIAL_VAULT_CAPABILITY, EXTENSION_PROTOCOL_CAPABILITIES, VAULT_SITE_APPROVAL_CAPABILITY } from '../mcp-server/src/protocol/index.js';
import { authenticatedHelloAck, sendAuthInit, testBridgeCredentials } from './helpers/bridge-auth.js';
import { freePort } from './helpers/free-port.js';
import {
  MAX_PORTABLE_CHUNK_BYTES, PortableTransferSessions,
} from '../mcp-server/src/vault/portable-transfers.js';
import { MAX_PORTABLE_ARCHIVE_BYTES } from '../mcp-server/src/vault/portable-format.js';

// The OS assigns the port: vitest runs test files in parallel, and a range
// picked by arithmetic can collide with another file in the same run.
let port = 0;
const sockets: WebSocket[] = [];
const bridges: ExtensionBridge[] = [];

afterEach(async () => {
  sockets.forEach((socket) => { try { socket.close(); } catch { /* already closed */ } });
  sockets.length = 0;
  bridges.forEach((bridge) => bridge.stop());
  bridges.length = 0;
  await new Promise((resolve) => setTimeout(resolve, 40));
  vi.restoreAllMocks();
});

async function startBridge() {
  port = await freePort();
  const bridge = new ExtensionBridge({ port, ...testBridgeCredentials(), maxRetries: 0, pingIntervalMs: 60_000, defaultTimeoutMs: 150 });
  bridges.push(bridge);
  await bridge.start();
  return bridge;
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

describe('private portable transfer bounds', () => {
  let now = 1_000;
  let transfers: PortableTransferSessions;

  afterEach(() => transfers?.dispose());

  it('serves export bytes in bounded sequential chunks and clears the completed transfer', () => {
    transfers = new PortableTransferSessions(() => now, 0);
    const archive = Buffer.alloc(MAX_PORTABLE_CHUNK_BYTES + 17, 0x5a);
    const started = transfers.startExport('fixture-connection-001', archive);

    expect(started.byteLength).toBe(archive.length);
    const first = transfers.readExportChunk('fixture-connection-001', started.transferId, 0);
    expect(Buffer.from(first.chunkBase64, 'base64')).toEqual(archive.subarray(0, MAX_PORTABLE_CHUNK_BYTES));
    expect(first.done).toBe(false);
    expect(() => transfers.readExportChunk('fixture-connection-001', started.transferId, 1)).toThrow(/INVALID_ARGUMENT/);

    const expectedLast = Buffer.from(archive.subarray(MAX_PORTABLE_CHUNK_BYTES));
    const last = transfers.readExportChunk('fixture-connection-001', started.transferId, MAX_PORTABLE_CHUNK_BYTES);
    expect(Buffer.from(last.chunkBase64, 'base64')).toEqual(expectedLast);
    expect(last.done).toBe(true);
    expect(() => transfers.readExportChunk('fixture-connection-001', started.transferId, archive.length)).toThrow();
    expect(archive.every((byte) => byte === 0)).toBe(true);
  });

  it('requires canonical, contiguous upload chunks and binds previews to the owning connection', () => {
    transfers = new PortableTransferSessions(() => now, 0);
    const started = transfers.startImport('fixture-connection-001', 5);
    expect(() => transfers.appendImportChunk('fixture-connection-001', started.transferId, 1, 'YQ==')).toThrow(/INVALID_ARGUMENT/);
    expect(() => transfers.appendImportChunk('fixture-connection-001', started.transferId, 0, 'YQ===')).toThrow(/INVALID_ARGUMENT/);
    const uploaded = Buffer.from('abcde');
    expect(transfers.appendImportChunk('fixture-connection-001', started.transferId, 0, uploaded.toString('base64'))).toMatchObject({ received: 5, done: true });

    const preview = transfers.beginImportPreview('fixture-connection-001', started.transferId);
    expect(preview.archive).toEqual(uploaded);
    expect(() => transfers.beginImportPreview('fixture-other-connection', started.transferId)).toThrow(/VAULT_PERMISSION_DENIED/);
    transfers.finishImportPreview('fixture-connection-001', started.transferId, preview.previewToken, true);
    expect(() => transfers.beginImportCommit('fixture-other-connection', preview.previewToken)).toThrow(/VAULT_PERMISSION_DENIED/);
    expect(transfers.beginImportCommit('fixture-connection-001', preview.previewToken)).toEqual({ transferId: started.transferId, archive: uploaded });
    transfers.finishImportCommit('fixture-connection-001', started.transferId, preview.previewToken, false);
    expect(transfers.cancel('fixture-connection-001', preview.previewToken)).toBe(true);
    expect(transfers.cancel('fixture-connection-001', preview.previewToken)).toBe(false);
  });

  it('limits transfers per connection, across the daemon, and by archive size', () => {
    transfers = new PortableTransferSessions(() => now, 0);
    const fullArchive = Buffer.alloc(MAX_PORTABLE_ARCHIVE_BYTES, 0x1);
    const first = transfers.startExport('fixture-connection-001', fullArchive);
    expect(() => transfers.startImport('fixture-connection-001', 1)).toThrow(/VAULT_BUSY/);
    transfers.startImport('fixture-connection-002', MAX_PORTABLE_ARCHIVE_BYTES);
    expect(() => transfers.startImport('fixture-connection-003', 1)).toThrow(/VAULT_BUSY/);
    expect(() => transfers.startImport('fixture-connection-003', MAX_PORTABLE_ARCHIVE_BYTES + 1)).toThrow(/RESPONSE_TOO_LARGE/);
    expect(transfers.cancel('fixture-connection-001', first.transferId)).toBe(true);
    expect(transfers.startImport('fixture-connection-003', 1).chunkBytes).toBe(MAX_PORTABLE_CHUNK_BYTES);
  });

  it('wipes buffers on idle expiry, absolute expiry, connection cleanup, and disposal', () => {
    transfers = new PortableTransferSessions(() => now, 0, 10, 30);
    const idleArchive = Buffer.from('idle-only');
    const idle = transfers.startExport('fixture-idle-connection', idleArchive);
    now += 10;
    expect(() => transfers.readExportChunk('fixture-idle-connection', idle.transferId, 0)).toThrow(/VAULT_PERMISSION_DENIED/);
    expect(idleArchive.every((byte) => byte === 0)).toBe(true);

    now += 1;
    const hardArchive = Buffer.alloc(MAX_PORTABLE_CHUNK_BYTES * 2 + 1, 0x2a);
    const hard = transfers.startImport('fixture-hard-connection', hardArchive.length);
    transfers.appendImportChunk('fixture-hard-connection', hard.transferId, 0, hardArchive.subarray(0, MAX_PORTABLE_CHUNK_BYTES).toString('base64'));
    now += 9;
    transfers.appendImportChunk('fixture-hard-connection', hard.transferId, MAX_PORTABLE_CHUNK_BYTES,
      hardArchive.subarray(MAX_PORTABLE_CHUNK_BYTES, MAX_PORTABLE_CHUNK_BYTES * 2).toString('base64'));
    now += 9;
    transfers.appendImportChunk('fixture-hard-connection', hard.transferId, MAX_PORTABLE_CHUNK_BYTES * 2, hardArchive.subarray(-1).toString('base64'));
    const preview = transfers.beginImportPreview('fixture-hard-connection', hard.transferId);
    transfers.finishImportPreview('fixture-hard-connection', hard.transferId, preview.previewToken, true);
    now += 9;
    transfers.beginImportCommit('fixture-hard-connection', preview.previewToken);
    transfers.finishImportCommit('fixture-hard-connection', hard.transferId, preview.previewToken, false);
    now += 3;
    expect(() => transfers.beginImportCommit('fixture-hard-connection', preview.previewToken)).toThrow(/VAULT_PERMISSION_DENIED/);
    expect(preview.archive.every((byte) => byte === 0)).toBe(true);

    const disconnectedArchive = Buffer.from('disconnect-only');
    transfers.startExport('fixture-disconnect-connection', disconnectedArchive);
    transfers.clearConnection('fixture-disconnect-connection');
    expect(disconnectedArchive.every((byte) => byte === 0)).toBe(true);

    const disposedArchive = Buffer.from('dispose-only');
    transfers.startExport('fixture-dispose-connection', disposedArchive);
    transfers.dispose();
    expect(disposedArchive.every((byte) => byte === 0)).toBe(true);
  });
});

describe('portable private UI bridge protocol', () => {
  function uiClient() {
    const pending = new Map<string, (result: Record<string, any>) => void>();
    let sequence = 0;
    return {
      onFrame(_socket: WebSocket, frame: Record<string, any>) {
        if (frame.type !== 'vaultUiResponse' || typeof frame.id !== 'string') return;
        const resolve = pending.get(frame.id);
        if (!resolve) return;
        pending.delete(frame.id);
        resolve(frame.result);
      },
      request(socket: WebSocket, payload: Record<string, unknown>) {
        const id = `ui_${String(++sequence).padStart(32, '0')}`;
        return new Promise<Record<string, any>>((resolve) => {
          pending.set(id, resolve);
          socket.send(JSON.stringify({ type: 'vaultUiRequest', id, payload }));
        });
      },
    };
  }

  it('keeps the export archive inside the daemon and returns only sequential encrypted chunks', async () => {
    const bridge = await startBridge();
    const archive = Buffer.from('synthetic-archive-content');
    const logs: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args) => logs.push(args.join(' ')));
    bridge.vaultTransport.setService({
      revokeConnection() {},
      cancelPrivateUiRequests() {},
      async handlePrivateUi(_connection: unknown, payload: Record<string, unknown>) {
        if (payload.operation === 'portableExportStart') return { success: true, status: 'portable_export_ready', archive: Buffer.from(archive) };
        return { success: false, code: 'INVALID_ARGUMENT' };
      },
    } as any);
    const client = uiClient();
    const socket = await connectExtension(bridge['port'], 'fixture-portable-export', { onFrame: client.onFrame });

    const started = await client.request(socket, { operation: 'portableExportStart', passphrase: 'synthetic-only-secret' });
    expect(started).toMatchObject({ success: true, byteLength: archive.length, chunkBytes: MAX_PORTABLE_CHUNK_BYTES });
    expect(started).not.toHaveProperty('archive');
    const chunk = await client.request(socket, { operation: 'portableExportChunk', transferId: started.transferId, offset: 0 });
    expect(chunk).toMatchObject({ success: true, offset: 0, done: true });
    expect(Buffer.from(chunk.chunkBase64, 'base64')).toEqual(archive);
    expect(JSON.stringify(started)).not.toContain('synthetic-only-secret');
    expect(archive.every((byte) => byte !== 0)).toBe(true);
    expect(logs.join('\n')).not.toContain('synthetic-only-secret');
    expect(logs.join('\n')).not.toContain(archive.toString());
  });

  it('routes import preview and commit by the owning connection and reuses only encrypted bytes', async () => {
    const bridge = await startBridge();
    const archive = Buffer.from('synthetic-encrypted-import-archive');
    const serviceCalls: Array<{ operation: unknown; archive?: Buffer; passphrase?: unknown; confirmReplace?: unknown }> = [];
    bridge.vaultTransport.setService({
      revokeConnection() {},
      cancelPrivateUiRequests() {},
      async handlePrivateUi(_connection: unknown, payload: Record<string, unknown>) {
        serviceCalls.push({
          operation: payload.operation,
          ...(Buffer.isBuffer(payload.archive) ? { archive: Buffer.from(payload.archive) } : {}),
          ...(typeof payload.passphrase === 'string' ? { passphrase: payload.passphrase } : {}),
          ...(payload.confirmReplace !== undefined ? { confirmReplace: payload.confirmReplace } : {}),
        });
        if (payload.operation === 'portableImportPreview') return { success: true, entryCount: 2, allowlistCount: 1 };
        if (payload.operation === 'portableImportCommit') return { success: true, status: 'imported', entryCount: 2, allowlistCount: 1 };
        return { success: false, code: 'INVALID_ARGUMENT' };
      },
    } as any);

    const ownerClient = uiClient();
    const owner = await connectExtension(bridge['port'], 'fixture-portable-owner', { onFrame: ownerClient.onFrame });
    const upload = await ownerClient.request(owner, { operation: 'portableImportStart', byteLength: archive.length });
    const uploaded = await ownerClient.request(owner, {
      operation: 'portableImportChunk', transferId: upload.transferId, offset: 0, chunkBase64: archive.toString('base64'),
    });
    expect(uploaded).toMatchObject({ success: true, received: archive.length, done: true });
    const preview = await ownerClient.request(owner, {
      operation: 'portableImportPreview', transferId: upload.transferId, passphrase: 'synthetic-owner-passphrase',
    });
    expect(preview).toMatchObject({ success: true, entryCount: 2, allowlistCount: 1, previewToken: expect.stringMatching(/^pvi_[a-f0-9]{32}$/) });
    expect(preview).not.toHaveProperty('archive');

    const otherClient = uiClient();
    const other = await connectExtension(bridge['port'], 'fixture-portable-other', { onFrame: otherClient.onFrame });
    await expect(otherClient.request(other, {
      operation: 'portableImportCommit', previewToken: preview.previewToken,
      passphrase: 'synthetic-owner-passphrase', confirmReplace: true,
    })).resolves.toMatchObject({ success: false, code: 'VAULT_PERMISSION_DENIED' });

    const committed = await ownerClient.request(owner, {
      operation: 'portableImportCommit', previewToken: preview.previewToken,
      passphrase: 'synthetic-owner-passphrase', confirmReplace: true,
    });
    expect(committed).toMatchObject({ success: true, status: 'imported', entryCount: 2, allowlistCount: 1 });
    expect(serviceCalls.map((call) => call.operation)).toEqual(['portableImportPreview', 'portableImportCommit']);
    expect(serviceCalls.every((call) => call.archive?.equals(archive))).toBe(true);
    expect(serviceCalls.every((call) => call.passphrase === 'synthetic-owner-passphrase')).toBe(true);
    expect(serviceCalls[1]?.confirmReplace).toBe(true);
  });

  it('clears the connection-owned encrypted bytes when the vault page closes or the extension disconnects', async () => {
    const bridge = await startBridge();
    const closeArchive = Buffer.from('clear-on-ui-close');
    const disconnectArchive = Buffer.from('clear-on-disconnect');
    const archives = [closeArchive, disconnectArchive];
    bridge.vaultTransport.setService({
      revokeConnection() {},
      cancelPrivateUiRequests() {},
      async handlePrivateUi() {
        return { success: true, status: 'portable_export_ready', archive: archives.shift() };
      },
    } as any);

    const closingClient = uiClient();
    const closingSocket = await connectExtension(bridge['port'], 'fixture-portable-close', { onFrame: closingClient.onFrame });
    await closingClient.request(closingSocket, { operation: 'portableExportStart', passphrase: 'synthetic-close-passphrase' });
    closingSocket.send(JSON.stringify({ type: 'vaultUiClosed' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(closeArchive.every((byte) => byte === 0)).toBe(true);

    const disconnectClient = uiClient();
    const disconnectSocket = await connectExtension(bridge['port'], 'fixture-portable-disconnect', { onFrame: disconnectClient.onFrame });
    await disconnectClient.request(disconnectSocket, { operation: 'portableExportStart', passphrase: 'synthetic-disconnect-passphrase' });
    const closed = new Promise<void>((resolve) => disconnectSocket.once('close', () => resolve()));
    disconnectSocket.close();
    await closed;
    const cleanupDeadline = Date.now() + 250;
    while (disconnectArchive.some((byte) => byte !== 0) && Date.now() < cleanupDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(disconnectArchive.every((byte) => byte === 0)).toBe(true);
  });
});
