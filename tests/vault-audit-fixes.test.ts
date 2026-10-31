import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { routeVaultAwareCall } from '../mcp-server/src/vault/daemon-routing.js';
import { failureReasonOf, VaultServiceError } from '../mcp-server/src/vault/service-common.js';
import { VaultBridgeTransport } from '../mcp-server/src/vault/bridge-transport.js';
import { ExtensionConnections, type ExtensionConnection } from '../mcp-server/src/bridge-connections.js';
import { CREDENTIAL_VAULT_CAPABILITY } from '../mcp-server/src/protocol/index.js';
import type { VaultService } from '../mcp-server/src/vault/service.js';

// The vault work of the live measurement (F-34 … F-40) landed in three places:
// the daemon boundary that answers the agent, the private page that answers the
// owner, and the vault service that holds the request journal. This file covers
// the branches those three paths added.

const CARD_HINT = ' An approval card is open on this tab: the owner has not decided yet, so the page may not answer.';

afterEach(() => {
  vi.restoreAllMocks();
});

/** Collects the operator log lines the daemon writes. */
function captureLog(): string[] {
  const lines: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    lines.push(args.map((item) => String(item)).join(' '));
  });
  return lines;
}

function stubService(options: { result?: unknown; throws?: Error; hint?: string } = {}): VaultService {
  return {
    pinBrowserId: async () => 'browser-a',
    retainRedactionForBrowser: () => () => {},
    sanitizeForSession: async (_sessionId: string, value: unknown) => value,
    assertToolAllowed: async () => {},
    handlePublic: async () => {
      if (options.throws) throw options.throws;
      return options.result ?? { success: true, status: 'ready' };
    },
    approvalCardHint: () => options.hint,
  } as unknown as VaultService;
}

const bridge = {
  vaultTransport: { selectBrowser: () => undefined },
  callTool: async () => ({ text: 'fixture' }),
};

function route(service: VaultService, params: Record<string, unknown>) {
  return routeVaultAwareCall({
    bridge,
    vaultService: service,
    sessionId: 'session-1',
    agentName: 'FixtureAgent',
    tool: 'browser_vault',
    params,
    signal: new AbortController().signal,
  });
}

describe('the vault calls the daemon operator can read (F-37)', () => {
  it('writes one line per call, with the outcome and the site', async () => {
    const lines = captureLog();
    const reply = await route(
      stubService({ result: { success: true, status: 'ready', origin: 'https://fixture.test', requestId: 'req-1' } }),
      { action: 'list' },
    );

    expect(reply.success).toBe(true);
    expect(lines.join('\n')).toMatch(/vault list -> ready origin=https:\/\/fixture\.test request=req-1/);
  });

  it('names the error code when the answer carries no status', async () => {
    const lines = captureLog();
    await route(stubService({ result: { success: false, code: 'VAULT_DECLINED' } }), { action: 'fill' });

    expect(lines.join('\n')).toMatch(/vault fill -> VAULT_DECLINED/);
  });

  it('says unknown when the answer names no outcome at all', async () => {
    const lines = captureLog();
    await route(stubService({ result: { success: true } }), { action: 'status' });

    expect(lines.join('\n')).toMatch(/vault status -> unknown/);
  });

  it('names the call when the request carries no action', async () => {
    const lines = captureLog();
    await route(stubService({ result: { success: true, status: 'ready' } }), {});

    expect(lines.join('\n')).toMatch(/vault call -> ready/);
  });

  it('writes no line when the answer is not a record', async () => {
    const lines = captureLog();
    await route(stubService({ result: 'not a record' }), { action: 'list' });

    expect(lines).toHaveLength(0);
  });
});

describe('a call that did not answer while a card was open (F-34)', () => {
  it('names the open card in the timeout', async () => {
    const reply = await route(
      stubService({ throws: new Error('TIMEOUT: the page could not be read'), hint: CARD_HINT }),
      { action: 'list', tabId: 21 },
    );

    expect(reply.success).toBe(false);
    expect(reply.error).toContain('TIMEOUT');
    expect(reply.error).toContain('approval card is open');
  });

  it('leaves a timeout without a card as it was', async () => {
    const reply = await route(
      stubService({ throws: new Error('TIMEOUT: the page could not be read') }),
      { action: 'list', tabId: 21 },
    );

    expect(reply.error).toContain('TIMEOUT');
    expect(reply.error).not.toContain('approval card');
  });

  it('does not blame a card for an error that is not a timeout', async () => {
    const reply = await route(
      stubService({ throws: new Error('VAULT_DECLINED: the owner said no'), hint: CARD_HINT }),
      { action: 'list', tabId: 21 },
    );

    expect(reply.error).toContain('VAULT_DECLINED');
    expect(reply.error).not.toContain('approval card');
  });
});

describe('why a request failed (F-39)', () => {
  it('keeps the vault message and drops the code in front of it', () => {
    expect(failureReasonOf(new VaultServiceError('INVALID_ARGUMENT', 'password is required')))
      .toBe('password is required');
  });

  it('keeps a message that carries no code', () => {
    const error = new VaultServiceError('INVALID_ARGUMENT', 'password is required');
    error.message = 'the owner closed the page';
    expect(failureReasonOf(error)).toBe('the owner closed the page');
  });

  it('says nothing about an error that is not the vault\'s own', () => {
    expect(failureReasonOf(new Error('ENOENT: no such file'))).toBe('the vault could not complete the operation');
  });
});

describe('the owner\'s own decisions in the operator log (F-37)', () => {
  function connection(): ExtensionConnection {
    const ws = { readyState: WebSocket.OPEN, send: vi.fn() } as unknown as WebSocket;
    return {
      ws,
      connectionId: 'conn-1',
      browserId: 'browser-a',
      label: 'Fixture browser',
      capabilities: [CREDENTIAL_VAULT_CAPABILITY],
      state: 'ready',
      handshakeTimer: null,
      missedPongs: 0,
      connectedAt: Date.now(),
    };
  }

  async function decide(result: unknown, payload: unknown = { operation: 'save' }): Promise<string[]> {
    const lines = captureLog();
    const connections = new ExtensionConnections();
    const conn = connection();
    connections.add(conn);
    const transport = new VaultBridgeTransport(connections);
    transport.setService({ handlePrivateUi: async () => result } as unknown as VaultService);
    transport.handleMessage({ type: 'vaultUiRequest', id: `ui_${'a'.repeat(32)}`, payload }, conn);
    await new Promise((resolve) => setTimeout(resolve, 5));
    return lines;
  }

  it('writes the operation and its outcome', async () => {
    const lines = await decide({ success: true, status: 'saved' });
    expect(lines.join('\n')).toMatch(/vault ui save -> saved/);
  });

  it('names the request when the page sent no operation', async () => {
    const lines = await decide({ success: true, status: 'saved' }, { tabId: 21 });
    expect(lines.join('\n')).toMatch(/vault ui request -> saved/);
  });

  it('names the error code when the decision failed', async () => {
    const lines = await decide({ success: false, code: 'VAULT_STORAGE_INVALID' });
    expect(lines.join('\n')).toMatch(/vault ui save -> VAULT_STORAGE_INVALID/);
  });

  it('says unknown when the decision named no outcome', async () => {
    const lines = await decide('not a record');
    expect(lines.join('\n')).toMatch(/vault ui save -> unknown/);
  });
});
