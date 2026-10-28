import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EXTENSION_PROTOCOL_CAPABILITIES,
  IPC_PROTOCOL_CAPABILITIES,
  MEMORY_ADMIN_CAPABILITY,
  PROTOCOL_VERSION,
  SITE_CONTEXT_CAPABILITY,
  SITE_MAP_CAPABILITY,
  buildIpcWelcome,
  validateExtensionCapabilities,
  validateIpcHandshake,
} from '../mcp-server/src/protocol.js';
import { parseMemoryAdminRequest } from '../mcp-server/src/daemon-config.js';
import { OBSERVABLE_TOOLS, withObserve } from '../mcp-server/src/bridge-frames.js';
import { VaultService, type VaultBrowserContext, type VaultTransport } from '../mcp-server/src/vault/service.js';
import { scopeForBrowser } from '../mcp-server/src/vault/store.js';
import { routeVaultAwareCall } from '../mcp-server/src/vault/daemon-routing.js';

const ORIGIN = 'https://fixture.test';
const SESSION = 'session-fixture';
const BROWSER = 'profile-fixture';
const CONNECTION = 'connection-fixture-0001';

describe('memory capabilities', () => {
  it('advertises site-context from the extension side without making it required', () => {
    expect(EXTENSION_PROTOCOL_CAPABILITIES).toContain(SITE_CONTEXT_CAPABILITY);
    const withoutSiteContext = EXTENSION_PROTOCOL_CAPABILITIES.filter((c) => c !== SITE_CONTEXT_CAPABILITY);
    expect(validateExtensionCapabilities(withoutSiteContext)).toEqual({ ok: true, legacy: false });
  });

  it('advertises site-map as additive too (specs/004 T012)', () => {
    expect(EXTENSION_PROTOCOL_CAPABILITIES).toContain(SITE_MAP_CAPABILITY);
    expect(validateExtensionCapabilities(EXTENSION_PROTOCOL_CAPABILITIES.filter((c) => c !== SITE_MAP_CAPABILITY))).toEqual({ ok: true, legacy: false });
  });

  it('keeps memory-admin out of the mutual IPC list so an older client still connects', () => {
    expect(IPC_PROTOCOL_CAPABILITIES).not.toContain(MEMORY_ADMIN_CAPABILITY);
    expect(buildIpcWelcome('s1').capabilities).not.toContain(MEMORY_ADMIN_CAPABILITY);
  });

  it('adds memory-admin to the welcome only when the daemon can serve it, and both sides still accept it', () => {
    const welcome = buildIpcWelcome('s1', { memoryAdmin: true });
    expect(welcome.capabilities).toContain(MEMORY_ADMIN_CAPABILITY);
    expect(validateIpcHandshake(welcome, 'older')).toEqual({ ok: true, legacy: false });
    expect(validateIpcHandshake({ protocolVersion: PROTOCOL_VERSION, capabilities: IPC_PROTOCOL_CAPABILITIES }, 'older'))
      .toEqual({ ok: true, legacy: false });
  });
});

describe('observe request flag', () => {
  it('sets observe only on observable tools and only when asked', () => {
    expect([...OBSERVABLE_TOOLS].sort()).toEqual(['browser_click', 'browser_navigate', 'browser_snapshot']);
    expect(withObserve('browser_navigate', { url: 'https://a.test' }, true)).toEqual({ url: 'https://a.test', observe: true });
    expect(withObserve('browser_snapshot', { tabId: 1 }, false)).toEqual({ tabId: 1 });
    expect(withObserve('browser_click', { tabId: 1 }, true)).toEqual({ tabId: 1, observe: true });
    expect(withObserve('browser_type', { tabId: 1 }, true)).toEqual({ tabId: 1 });
  });

  it('drops an agent-supplied observe on observable tools and leaves other tools alone', () => {
    expect(withObserve('browser_navigate', { url: 'https://a.test', observe: true }, false)).toEqual({ url: 'https://a.test' });
    expect(withObserve('browser_snapshot', { observe: 'x' }, true)).toEqual({ observe: true });
    expect(withObserve('browser_click', { observe: 'diff' }, false)).toEqual({});
    expect(withObserve('browser_type', { observe: 'diff' }, true)).toEqual({ observe: 'diff' });
  });
});

describe('memory-admin request validation', () => {
  const ok = (value: unknown) => parseMemoryAdminRequest(value);

  it('accepts each command with the fields the contract allows', () => {
    expect(ok({ kind: 'memory-admin', id: '1', command: 'status' })).toMatchObject({ ok: true });
    expect(ok({ kind: 'memory-admin', id: '1', command: 'enable' })).toMatchObject({ ok: true });
    expect(ok({ kind: 'memory-admin', id: '1', command: 'export' })).toMatchObject({ ok: true });
    for (const command of ['exclude', 'include', 'inspect', 'delete']) {
      expect(ok({ kind: 'memory-admin', id: '1', command, origin: 'https://a.test:8443' })).toMatchObject({ ok: true });
    }
    expect(ok({ kind: 'memory-admin', id: '1', command: 'delete', all: true })).toEqual({
      ok: true, request: { kind: 'memory-admin', id: '1', command: 'delete', all: true },
    });
  });

  it.each([
    ['not an object', 'x'],
    ['array', []],
    ['wrong kind', { kind: 'call', id: '1', command: 'status' }],
    ['missing id', { kind: 'memory-admin', command: 'status' }],
    ['id too long', { kind: 'memory-admin', id: 'x'.repeat(65), command: 'status' }],
    ['unknown command', { kind: 'memory-admin', id: '1', command: 'wipe' }],
    ['unknown field', { kind: 'memory-admin', id: '1', command: 'status', ownerConfirmed: true }],
    ['origin missing for exclude', { kind: 'memory-admin', id: '1', command: 'exclude' }],
    ['origin missing for delete without all', { kind: 'memory-admin', id: '1', command: 'delete' }],
    ['origin with a path', { kind: 'memory-admin', id: '1', command: 'inspect', origin: 'https://a.test/x' }],
    ['non-http origin', { kind: 'memory-admin', id: '1', command: 'inspect', origin: 'file:///etc' }],
    ['origin on enable', { kind: 'memory-admin', id: '1', command: 'enable', origin: 'https://a.test' }],
    ['all on status', { kind: 'memory-admin', id: '1', command: 'status', all: true }],
    ['all with origin', { kind: 'memory-admin', id: '1', command: 'delete', all: true, origin: 'https://a.test' }],
    ['all not boolean', { kind: 'memory-admin', id: '1', command: 'delete', all: 'yes' }],
  ])('rejects %s with INVALID_ARGUMENT', (_name, value) => {
    const result = ok(value);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^INVALID_ARGUMENT: /);
  });
});

function makeTransport() {
  const context: VaultBrowserContext = {
    browserId: BROWSER, browserLabel: 'Fixture', connectionId: CONNECTION, supportsVault: true,
  };
  const transport: VaultTransport = {
    async getBrowserContext() { return context; },
    async callVaultAction() { throw new Error('unexpected action'); },
    async closeCard() { throw new Error('unexpected action'); },
  };
  return transport;
}

describe('vault memoryEligibility and result routing', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  async function setup() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bc-memory-protocol-'));
    roots.push(root);
    return new VaultService(root, makeTransport(), () => true);
  }

  const doc = { tabId: 1, documentId: 'protected-document', origin: ORIGIN, state: 'active', current: true };

  it('is clear with no protection state, protected with a document, unknown when recovery is needed', async () => {
    const service = await setup();
    expect(service.memoryEligibility(BROWSER, 1)).toBe('clear');
    expect(service.memoryEligibility('', 1)).toBe('unknown');

    service.noteProtectionState(BROWSER, CONNECTION, 1, [doc]);
    expect(service.memoryEligibility(BROWSER, 1)).toBe('protected');
    expect(service.memoryEligibility(BROWSER, 99)).toBe('protected');
    expect(service.memoryEligibility('other-profile', 1)).toBe('clear');

    service.noteProtectionState(BROWSER, CONNECTION, 2, [], true, [7]);
    expect(service.memoryEligibility(BROWSER, 1)).toBe('unknown');
  });

  it('returns to clear once the protected tab is discarded', async () => {
    const service = await setup();
    service.redaction.register(scopeForBrowser(BROWSER), 'fixture-' + crypto.randomBytes(8).toString('hex'), 'protected-document');
    service.noteProtectionState(BROWSER, CONNECTION, 1, [doc]);
    expect(service.memoryEligibility(BROWSER, 1)).toBe('protected');
    service.discardProtectedTab(BROWSER, CONNECTION, 1, ['protected-document']);
    expect(service.memoryEligibility(BROWSER, 1)).toBe('clear');
  });

  async function route(service: VaultService, tool: string, params: Record<string, unknown>, reply: unknown, observe?: boolean) {
    const seen: Array<{ tool: string; params: Record<string, unknown> }> = [];
    const bridge = {
      vaultTransport: { selectBrowser: () => undefined },
      callTool: async (calledTool: string, calledParams: Record<string, unknown>) => {
        seen.push({ tool: calledTool, params: calledParams });
        return reply;
      },
    };
    const outcome = await routeVaultAwareCall({
      bridge, vaultService: service, sessionId: SESSION, agentName: 'FixtureAgent', tool, params,
      signal: new AbortController().signal, ...(observe === undefined ? {} : { observe }),
    });
    return { outcome, seen };
  }

  const siteContext = { url: `${ORIGIN}/`, incognito: false, topLevel: true, stable: true, anonymous: true, anonymityReason: 'ok' };

  it('passes observe to the extension, removes siteContext from the result and reports matching digests', async () => {
    const service = await setup();
    await service.pinBrowserId(SESSION, 'FixtureAgent');
    const { outcome, seen } = await route(service, 'browser_navigate', { url: `${ORIGIN}/` }, { tabId: 3, url: `${ORIGIN}/`, siteContext }, true);
    expect(seen[0].params).toEqual({ url: `${ORIGIN}/`, observe: true });
    expect(outcome.success).toBe(true);
    expect(JSON.stringify(outcome.result)).not.toContain('siteContext');
    expect(outcome.result).toEqual({ tabId: 3, url: `${ORIGIN}/` });
    expect(outcome.observation).toMatchObject({ siteContext, sanitizedUnchanged: true });
    expect(outcome.observation?.digestBefore).toBe(outcome.observation?.digestAfter);
  });

  it('reports siteContext null for an extension that sent none', async () => {
    const service = await setup();
    await service.pinBrowserId(SESSION, 'FixtureAgent');
    const { outcome } = await route(service, 'browser_snapshot', { tabId: 3 }, { text: 'page' }, true);
    expect(outcome.observation).toMatchObject({ siteContext: null, sanitizedUnchanged: true });
  });

  it('flags a result that sanitizing changed', async () => {
    const service = await setup();
    await service.pinBrowserId(SESSION, 'FixtureAgent');
    const secret = 'fixture-' + crypto.randomBytes(16).toString('hex');
    service.redaction.register(scopeForBrowser(BROWSER), secret, 'document-x');
    const { outcome } = await route(service, 'browser_snapshot', { tabId: 3 }, { text: `echo ${secret}`, siteContext }, true);
    expect(JSON.stringify(outcome.result)).not.toContain(secret);
    expect(outcome.observation?.sanitizedUnchanged).toBe(false);
    expect(outcome.observation?.digestBefore).not.toBe(outcome.observation?.digestAfter);
  });

  it('adds no observe flag and no observation when the daemon did not ask, and drops an agent-sent flag', async () => {
    const service = await setup();
    await service.pinBrowserId(SESSION, 'FixtureAgent');
    const { outcome, seen } = await route(service, 'browser_navigate', { url: `${ORIGIN}/`, observe: true }, { tabId: 3, siteContext });
    expect(seen[0].params).toEqual({ url: `${ORIGIN}/` });
    expect(outcome.observation).toBeUndefined();
    expect(JSON.stringify(outcome.result)).not.toContain('siteContext');
  });

  it('never observes tools other than navigate and snapshot', async () => {
    const service = await setup();
    await service.pinBrowserId(SESSION, 'FixtureAgent');
    const { outcome, seen } = await route(service, 'browser_text', { tabId: 3 }, { text: 'x' }, true);
    expect(seen[0].params).toEqual({ tabId: 3 });
    expect(outcome.observation).toBeUndefined();
  });

  it('gives no observation for a failed call', async () => {
    const service = await setup();
    await service.pinBrowserId(SESSION, 'FixtureAgent');
    const bridge = {
      vaultTransport: { selectBrowser: () => undefined },
      callTool: async () => { throw new Error('TAB_LOCKED: nope'); },
    };
    const outcome = await routeVaultAwareCall({
      bridge, vaultService: service, sessionId: SESSION, agentName: 'FixtureAgent', tool: 'browser_navigate',
      params: { url: `${ORIGIN}/` }, signal: new AbortController().signal, observe: true,
    });
    expect(outcome.success).toBe(false);
    expect(outcome.observation).toBeUndefined();
  });
});
