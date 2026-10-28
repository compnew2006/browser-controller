import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { VaultService, type VaultBrowserContext, type VaultTransport } from '../mcp-server/src/vault/service.js';
import { safeMessage, type PrivateConnection } from '../mcp-server/src/vault/service-common.js';
import { scopeForBrowser } from '../mcp-server/src/vault/store.js';
import { forwardHandler } from '../mcp-server/src/tools/types.js';
import { routeVaultAwareCall } from '../mcp-server/src/vault/daemon-routing.js';

const ORIGIN = 'https://fixture.test';
const SESSION = 'session-fixture';
const OTHER_SESSION = 'session-other';

/** Saves one account for ORIGIN through a private save request, with no session consent. */
async function saveAccount(service: VaultService, connection: () => { browserId: string; browserLabel: string; connectionId: string }, tabId: number): Promise<string> {
  const request = await service.handlePublic(SESSION, { action: 'save_login', tabId });
  const saved = await service.handlePrivateUi(connection(), {
    operation: 'save', requestId: request.requestId, origin: ORIGIN,
    identifier: 'fixture-user', password: 'synthetic-only', label: 'fixture', allowSession: false, saveAndFill: false,
  });
  return String(saved.handle);
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt++) await new Promise((resolve) => setTimeout(resolve, 2));
  expect(condition()).toBe(true);
}

function makeTransport(overrides: Partial<VaultBrowserContext> = {}) {
  const state: {
    context: VaultBrowserContext;
    calls: Array<{ action: string; params: Record<string, unknown> }>;
    fillCount: number;
    disconnect: boolean;
    fillHook?: (signal?: AbortSignal) => Promise<unknown>;
    /** Runs before an inspection answers; a rejection fails it. */
    inspectHook?: () => Promise<void>;
    /** Answers the in-page card action; without it the action is unknown, as on an older extension. */
    prompt?: (params: Record<string, unknown>) => unknown;
  } = {
    context: {
      browserId: 'profile-fixture', browserLabel: 'Fixture', connectionId: 'connection-fixture-0001',
      supportsVault: true, ...overrides,
    },
    calls: [],
    fillCount: 0,
    disconnect: false,
  };
  const transport: VaultTransport = {
    async getBrowserContext() {
      if (state.disconnect) throw new Error('gone');
      return state.context;
    },
    async callVaultAction(action, params, _sessionId, signal) {
      state.calls.push({ action, params });
      if (action === 'inspect') {
        if (state.inspectHook) await state.inspectHook();
        return {
          success: true, tabId: params.tabId, origin: ORIGIN, documentId: 'document-fixture',
          targetDocumentId: 'document-fixture', frameId: 0, nonce: 'nonce-fixture', suitable: true,
        };
      }
      if (action === 'fill') {
        state.fillCount++;
        if (state.fillHook) return state.fillHook(signal);
        return { success: true, filled_fields: 1 };
      }
      if (action === 'openUi') return { success: true };
      if (action === 'prompt' && state.prompt) return state.prompt(params);
      throw new Error('unexpected action');
    },
    async closeCard(connectionId, params) {
      state.calls.push({ action: 'promptClose', params: { ...params, connectionId } });
      return { success: true, closed: true };
    },
  };
  return { state, transport };
}

describe('VaultService', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  async function setup(overrides: Partial<VaultBrowserContext> = {}, now?: () => number) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bc-vault-service-'));
    roots.push(root);
    const { state, transport } = makeTransport(overrides);
    let live = true;
    const service = new VaultService(root, transport, () => live, now);
    return {
      root,
      state,
      service,
      setLive(value: boolean) { live = value; },
      connection: () => ({
        browserId: state.context.browserId,
        browserLabel: state.context.browserLabel,
        connectionId: state.context.connectionId,
      }),
    };
  }

  it('allows ordinary browsing with an older extension that lacks the optional vault capability', async () => {
    const { service } = await setup({ supportsVault: false, browserId: 'older-profile' });
    await expect(service.assertToolAllowed(SESSION, 'browser_snapshot', { tabId: 1 })).resolves.toBeUndefined();
    await expect(service.assertToolAllowed(SESSION, 'browser_evaluate', { tabId: 1 })).resolves.toBeUndefined();
    await expect(service.handlePublic(SESSION, { action: 'status' })).rejects.toMatchObject({ code: 'VAULT_EXTENSION_REQUIRED' });
  });

  it('pins reply redaction to the dispatch profile and fails closed when no safe scope is known', async () => {
    const { state, service } = await setup();
    const secret = `fixture-${crypto.randomBytes(16).toString('hex')}`;
    service.redaction.register(scopeForBrowser(state.context.browserId), secret, 'document-fixture');
    const pinnedBrowserId = await service.pinBrowserId(SESSION);
    state.context = { ...state.context, browserId: 'replacement-profile', connectionId: 'connection-replacement-0001' };
    const reply = await service.sanitizeForSession(SESSION, { result: { status: secret, identifier: secret } }, 'browser_text', pinnedBrowserId);
    expect(JSON.stringify(reply).includes(secret)).toBe(false);
    state.disconnect = true;
    const uncertain = await service.sanitizeForSession(SESSION, { text: secret }, 'browser_text');
    expect(JSON.stringify(uncertain).includes(secret)).toBe(false);
    const disconnected = await service.sanitizeForSession(SESSION, 'NOT_CONNECTED: Selected browser "profile-fixture" is not connected. secret detail', 'browser_text');
    expect(disconnected).toBe('NOT_CONNECTED: The selected browser is unavailable. Select a connected browser with browser_tabs.');
    expect(uncertain).not.toBe(secret);
    const unknownScope = await service.sanitizeForSession('unknown-session', { text: secret }, 'browser_text');
    expect(unknownScope).toMatchObject({ success: false, code: 'VAULT_PERMISSION_DENIED' });
  });

  it('labels private requests with the authenticated agent and a short session discriminator', async () => {
    const { service, connection } = await setup();
    await service.pinBrowserId(SESSION, 'FixtureAgent');
    await service.handlePublic(SESSION, { action: 'save_login', tabId: 3 });
    const state = await service.handlePrivateUi(connection(), { operation: 'getState' }) as any;
    expect(state.requests[0].sessionLabel).toBe('FixtureAgent · session fixture');
  });

  it('routes a public vault refusal through redaction and the real MCP error wrapper with its code intact', async () => {
    const { service, state } = await setup();
    service.redaction.register(scopeForBrowser(state.context.browserId), 'VAULT_PERMISSION_DENIED', 'document-fixture');
    const raw = await service.handlePublic(SESSION, { action: 'status', requestId: 'missing-request' });
    expect(raw).toMatchObject({
      success: false,
      code: 'VAULT_PERMISSION_DENIED',
      error: expect.stringMatching(/^VAULT_PERMISSION_DENIED: /),
    });
    const sanitized = await service.sanitizeForSession(SESSION, raw, 'browser_vault', state.context.browserId) as Record<string, unknown>;
    const wrapped = await forwardHandler('browser_vault')({ callTool: async () => sanitized }, {});
    expect(wrapped.isError).toBe(true);
    const text = wrapped.content.find((item) => item.type === 'text');
    expect(text?.type === 'text' ? text.text : '').not.toContain('VAULT_PERMISSION_DENIED');
  });

  it('gives the unsupported-origin and unresponsive-page codes their own message, not the generic one', () => {
    // The agent decides its next move from this sentence; the generic fallback
    // says nothing about the site or about retrying.
    expect(safeMessage('VAULT_ORIGIN_UNSUPPORTED')).toMatch(/only on HTTPS sites and on loopback HTTP/);
    expect(safeMessage('VAULT_PAGE_UNRESPONSIVE')).toMatch(/did not respond/);
  });

  it('writes a daemon-ephemeral HMAC session reference instead of a raw session ID to audit', async () => {
    const { service, state, connection } = await setup();
    const internal = service as unknown as {
      storeFor(browserId: string): { audit(event: unknown): Promise<void> };
    };
    const store = internal.storeFor(state.context.browserId) as any;
    const originalAudit = store.audit.bind(store);
    let captured: unknown;
    store.audit = async (event: unknown) => {
      captured = event;
      return originalAudit(event);
    };
    const request = await service.handlePublic(SESSION, { action: 'unlock', tabId: 8 });
    await service.handlePrivateUi(connection(), { operation: 'unlock', requestId: request.requestId });
    expect(captured).toMatchObject({ sessionRef: expect.stringMatching(/^[a-f0-9]{24}$/) });
    expect(captured).not.toHaveProperty('sessionId');
    expect(JSON.stringify(captured)).not.toContain(SESSION);
  });

  it('pins tab-list replies to the selected replacement profile and keeps a site approval to its own profile', async () => {
    const { state, service, connection } = await setup();
    await service.handlePrivateUi(connection(), { operation: 'unlock' });
    const request = await service.handlePublic(SESSION, { action: 'save_login', tabId: 3 });
    const saved = await service.handlePrivateUi(connection(), {
      operation: 'save', requestId: request.requestId,
      identifier: 'fixture-user', password: 'fixture-password-a', label: 'fixture',
      allowSession: true, saveAndFill: false,
    });
    const handle = String(saved.handle);
    await service.pinBrowserId(SESSION);

    state.context = { ...state.context, browserId: 'profile-b', browserLabel: 'Profile B', connectionId: 'connection-profile-b-0001' };
    const selected = await service.pinBrowserId(SESSION);
    const secretB = 'fixture-password-b';
    service.redaction.register(scopeForBrowser('profile-b'), secretB, 'document-profile-b');
    const tabsReply = await service.sanitizeForSession(SESSION, { text: `tabs title ${secretB}` }, 'browser_tabs', selected);
    expect(JSON.stringify(tabsReply).includes(secretB)).toBe(false);
    // The site was approved in the first profile only: the second profile asks for itself.
    const needsApproval = await service.handlePublic(SESSION, { action: 'fill', tabId: 3, handle });
    expect(needsApproval).toMatchObject({ status: 'user_action_required', purpose: 'fill' });

    // Back on the first profile, its site approval still stands: it ends with the vault lock, not a profile switch.
    state.context = { ...state.context, browserId: 'profile-fixture', browserLabel: 'Fixture', connectionId: 'connection-fixture-0001' };
    await service.pinBrowserId(SESSION);
    expect(await service.handlePublic(SESSION, { action: 'fill', tabId: 3, handle })).toMatchObject({ success: true, status: 'filled' });
  });

  it('blocks high-risk output profile-wide and checks the returned image after the tool finishes', async () => {
    const { service } = await setup();
    service.noteProtectionState('profile-fixture', 'connection-fixture-0001', 1, [{
      tabId: 1, documentId: 'protected-document', origin: ORIGIN, state: 'active', current: true,
    }]);
    await expect(service.assertToolAllowed(SESSION, 'browser_evaluate', { tabId: 99 })).rejects.toMatchObject({ code: 'VAULT_CONTEXT_PROTECTED' });
    await expect(service.assertToolAllowed(SESSION, 'browser_mock', { tabId: 99 })).rejects.toMatchObject({ code: 'VAULT_CONTEXT_PROTECTED' });
    await expect(service.assertToolAllowed(SESSION, 'browser_logs', { tabId: 99 })).rejects.toMatchObject({ code: 'VAULT_CONTEXT_PROTECTED' });
    await expect(service.assertToolAllowed(SESSION, 'browser_screenshot', { tabId: 99 })).rejects.toMatchObject({ code: 'VAULT_CONTEXT_PROTECTED' });
    await expect(service.assertToolAllowed(SESSION, 'browser_snapshot', { tabId: 99 })).resolves.toBeUndefined();
    await expect(service.assertToolAllowed(SESSION, 'browser_batch', {
      actions: [{ tool: 'browser_text' }, { tool: 'browser_evaluate' }],
    })).rejects.toMatchObject({ code: 'VAULT_CONTEXT_PROTECTED' });
    const afterRace = await service.sanitizeForSession(SESSION, { image: { data: 'opaque-fixture' } }, 'browser_screenshot', 'profile-fixture');
    expect(afterRace).toMatchObject({ success: false, code: 'VAULT_CONTEXT_PROTECTED' });
    expect(JSON.stringify(afterRace).includes('opaque-fixture')).toBe(false);
  });

  it('keeps a restart recovery scope blocked until each previously protected tab is closed', async () => {
    const { service } = await setup();
    service.noteProtectionState('profile-fixture', 'connection-fixture-0001', 1, [], true, [31, 32]);
    await expect(service.assertToolAllowed(SESSION, 'browser_text', { tabId: 31 })).rejects.toMatchObject({ code: 'VAULT_RECOVERY_REQUIRED' });
    service.discardProtectedTab('profile-fixture', 'connection-fixture-0001', 31, []);
    await expect(service.assertToolAllowed(SESSION, 'browser_text', { tabId: 32 })).rejects.toMatchObject({ code: 'VAULT_RECOVERY_REQUIRED' });
    service.discardProtectedTab('profile-fixture', 'connection-fixture-0001', 32, []);
    await expect(service.assertToolAllowed(SESSION, 'browser_text', { tabId: 32 })).resolves.toBeUndefined();
  });

  it('keeps redaction active until an in-flight browser reply has been sanitized after tab close', async () => {
    const { service, state } = await setup();
    const secret = 'fixture-' + crypto.randomBytes(16).toString('hex');
    const scope = scopeForBrowser(state.context.browserId);
    service.redaction.register(scope, secret, 'protected-document');
    service.noteProtectionState(state.context.browserId, state.context.connectionId, 1, [{
      tabId: 21, documentId: 'protected-document', origin: ORIGIN, state: 'active', current: true,
    }]);

    let finishTool: ((value: unknown) => void) | undefined;
    let notifyStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    const bridge = {
      vaultTransport: { selectBrowser: () => undefined },
      callTool: async (
        _tool: string,
        _params: Record<string, unknown>,
        _sessionId: string,
        _signal: AbortSignal,
        _agentName: string,
      ) => {
        notifyStarted?.();
        return new Promise<unknown>((resolve) => { finishTool = resolve; });
      },
    };

    const pendingReply = routeVaultAwareCall({
      bridge,
      vaultService: service,
      sessionId: SESSION,
      agentName: 'FixtureAgent',
      tool: 'browser_text',
      params: { tabId: 21 },
      signal: new AbortController().signal,
    });
    await started;
    service.discardProtectedTab(state.context.browserId, state.context.connectionId, 21, ['protected-document']);
    finishTool?.({ text: 'page echoed ' + secret });

    const reply = await pendingReply;
    expect(JSON.stringify(reply).includes(secret)).toBe(false);
    expect(service.redaction.hasSecretForDocument(scope, 'protected-document')).toBe(false);
  });

  it('ignores delayed empty snapshots and only clears taint on explicit current-connection tab discard', async () => {
    const { service, state } = await setup();
    const secret = `fixture-${crypto.randomBytes(16).toString('hex')}`;
    service.redaction.register(scopeForBrowser(state.context.browserId), secret, 'protected-document');
    service.noteProtectionState(state.context.browserId, state.context.connectionId, 1, [{
      tabId: 21, documentId: 'protected-document', origin: ORIGIN, state: 'active', current: true,
    }]);
    // A delayed pre-fill/worker-start empty sync cannot erase a taint installed
    // by the daemon, and a fresh connection's empty snapshot is also additive.
    service.noteProtectionState(state.context.browserId, state.context.connectionId, 2, []);
    service.noteProtectionState(state.context.browserId, 'connection-replacement-0001', 1, []);
    service.discardProtectedTab(state.context.browserId, state.context.connectionId, 21, ['protected-document']);
    expect(service.redaction.hasSecretForDocument(scopeForBrowser(state.context.browserId), 'protected-document')).toBe(true);
    service.discardProtectedTab(state.context.browserId, 'connection-replacement-0001', 21, ['protected-document']);
    expect(service.redaction.hasSecretForDocument(scopeForBrowser(state.context.browserId), 'protected-document')).toBe(false);
  });

  it('keeps save requests pending across unlock and rejects unknown request ids without saving', async () => {
    const { service, state, connection } = await setup();
    const unlocked = await service.handlePrivateUi(connection(), { operation: 'unlock' });
    expect(unlocked).toMatchObject({ success: true, status: 'unlocked' });
    const requested = await service.handlePublic(SESSION, { action: 'save_login', tabId: 7 });
    const requestId = String(requested.requestId);
    await service.handlePrivateUi(connection(), { operation: 'unlock', requestId });
    expect(await service.handlePublic(SESSION, { action: 'status', requestId })).toMatchObject({ status: 'pending' });

    const rejected = await service.handlePrivateUi(connection(), {
      operation: 'save', requestId: 'req_unknown', origin: ORIGIN,
      identifier: 'fixture-user', password: 'synthetic-only', label: 'fixture',
      allowSession: false, saveAndFill: false,
    });
    expect(rejected).toMatchObject({ success: false, code: 'VAULT_PERMISSION_DENIED' });
    const requestState = await service.handlePrivateUi(connection(), {
      operation: 'save', requestId, origin: ORIGIN,
      identifier: 'fixture-user', password: 'synthetic-only', label: 'fixture',
      allowSession: true, saveAndFill: false,
    });
    expect(requestState).toMatchObject({ success: true, status: 'saved' });
    expect(JSON.stringify(requestState).includes('synthetic-only')).toBe(false);
    expect(state.calls.some((call) => call.action === 'fill')).toBe(false);
  });

  it('marks failed claimed requests terminal so invalid private input cannot strand or replay them', async () => {
    const { service, connection } = await setup();
    await service.handlePrivateUi(connection(), { operation: 'unlock' });
    const created = await service.handlePublic(SESSION, { action: 'save_login', tabId: 3 });
    const requestId = String(created.requestId);
    const failed = await service.handlePrivateUi(connection(), {
      operation: 'save', requestId, origin: ORIGIN,
      identifier: 'fixture-user', password: '', label: 'fixture', allowSession: false, saveAndFill: false,
    });
    expect(failed).toMatchObject({ success: false, code: 'INVALID_ARGUMENT' });
    expect(await service.handlePublic(SESSION, { action: 'status', requestId })).toMatchObject({ status: 'failed' });
    const replay = await service.handlePrivateUi(connection(), {
      operation: 'save', requestId, origin: ORIGIN,
      identifier: 'fixture-user', password: 'synthetic-only', label: 'fixture', allowSession: false, saveAndFill: false,
    });
    expect(replay).toMatchObject({ status: 'failed' });
  });

  it('cancels a private save when its initiating session ends before submission', async () => {
    const { service, connection, setLive } = await setup();
    await service.handlePrivateUi(connection(), { operation: 'unlock' });
    const created = await service.handlePublic(SESSION, { action: 'save_login', tabId: 8 });
    const requestId = String(created.requestId);
    setLive(false);
    const result = await service.handlePrivateUi(connection(), {
      operation: 'save', requestId, origin: ORIGIN,
      identifier: 'fixture-user', password: 'synthetic-only', label: 'fixture', allowSession: false, saveAndFill: false,
    });
    expect(result).toMatchObject({ success: false, code: 'VAULT_REQUEST_EXPIRED' });
    setLive(true);
    expect(await service.handlePublic(SESSION, { action: 'status', requestId })).toMatchObject({ status: 'failed' });
  });

  it('aborts a private Save & fill when the originating session disconnects during dispatch', async () => {
    const { service, state, connection, setLive } = await setup();
    await service.handlePrivateUi(connection(), { operation: 'unlock' });
    const created = await service.handlePublic(SESSION, { action: 'save_login', tabId: 9 });
    const requestId = String(created.requestId);
    let fillStarted!: () => void;
    const started = new Promise<void>((resolve) => { fillStarted = resolve; });
    state.fillHook = (signal) => new Promise((resolve, reject) => {
      fillStarted();
      const onAbort = () => reject(new Error('aborted'));
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
      void resolve;
    });
    const saving = service.handlePrivateUi(connection(), {
      operation: 'save', requestId, origin: ORIGIN,
      identifier: 'fixture-user', password: 'synthetic-only', label: 'fixture', allowSession: true, saveAndFill: true,
    });
    await started;
    setLive(false);
    service.revokeSession(SESSION);
    const result = await saving;
    expect(result).toMatchObject({ success: false, status: 'cancelled' });
    expect(state.fillCount).toBe(1);
    expect(JSON.stringify(result).includes('synthetic-only')).toBe(false);
  });

  it('aborts an in-flight direct public fill when locked or its grant is revoked', async () => {
    for (const cancel of ['lock', 'revoke'] as const) {
      const { service, state, connection } = await setup();
      await service.handlePrivateUi(connection(), { operation: 'unlock' });
      const created = await service.handlePublic(SESSION, { action: 'save_login', tabId: 33 });
      const saved = await service.handlePrivateUi(connection(), {
        operation: 'save', requestId: created.requestId, origin: ORIGIN,
        identifier: 'fixture-user', password: 'fixture-password-cancel', label: 'fixture',
        allowSession: true, saveAndFill: false,
      });
      const handle = String(saved.handle);
      const grantId = String((await service.handlePrivateUi(connection(), { operation: 'getState' }) as any).grants[0].grantId);
      let fillStarted!: (signal?: AbortSignal) => void;
      const started = new Promise<void>((resolve) => { fillStarted = () => resolve(); });
      let observedSignal: AbortSignal | undefined;
      state.fillHook = (signal) => new Promise((_, reject) => {
        observedSignal = signal;
        fillStarted(signal);
        const abort = () => reject(new Error('aborted'));
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
      });
      const filling = service.handlePublic(SESSION, { action: 'fill', tabId: 33, handle });
      await started;
      const cancelled = cancel === 'lock'
        ? await service.handlePrivateUi(connection(), { operation: 'lock' })
        : await service.handlePrivateUi(connection(), { operation: 'revoke', grantId });
      expect(cancelled).toMatchObject({ success: true });
      expect(observedSignal?.aborted).toBe(true);
      const fillResult = await filling;
      expect(fillResult).toMatchObject({ success: false, code: 'VAULT_OUTCOME_UNKNOWN' });
      expect(JSON.stringify(fillResult).includes('fixture-password-cancel')).toBe(false);
    }
  });

  it('allows a credential-specific fill grant to list only its account metadata', async () => {
    const { service, connection } = await setup();
    await service.handlePrivateUi(connection(), { operation: 'unlock' });
    const created = await service.handlePublic(SESSION, { action: 'save_login', tabId: 10 });
    const requestId = String(created.requestId);
    const saved = await service.handlePrivateUi(connection(), {
      operation: 'save', requestId, origin: ORIGIN,
      identifier: 'fixture-user', password: 'synthetic-only', label: 'fixture account', allowSession: true, saveAndFill: false,
    });
    const handle = String(saved.handle);
    const listed = await service.handlePublic(SESSION, { action: 'list', tabId: 10 });
    expect(listed).toMatchObject({ success: true, status: 'ready' });
    expect((listed.accounts as Array<{ handle: string; id?: string }>).map((entry) => entry.handle)).toEqual([handle]);
    expect((listed.accounts as Array<{ id?: string }>).every((entry) => entry.id === undefined)).toBe(true);
    expect(JSON.stringify(listed).includes('synthetic-only')).toBe(false);
  });

  it('withholds list metadata that contains that credential password without tainting a document', async () => {
    const { service, connection, state } = await setup();
    await service.handlePrivateUi(connection(), { operation: 'unlock' });
    const created = await service.handlePublic(SESSION, { action: 'save_login', tabId: 12 });
    await service.handlePrivateUi(connection(), {
      operation: 'save', requestId: String(created.requestId), origin: ORIGIN,
      identifier: 'fixture-user', password: 'fixture', label: 'fixture account', allowSession: true, saveAndFill: false,
    });

    const listed = await service.handlePublic(SESSION, { action: 'list', tabId: 12 });
    const serialized = JSON.stringify(listed);
    expect(serialized).not.toContain('fixture');
    expect(listed).not.toHaveProperty('origin');
    expect(service.redaction.hasSecrets(scopeForBrowser(state.context.browserId))).toBe(false);
    const accounts = listed.accounts as Array<Record<string, unknown>>;
    expect(accounts).toHaveLength(1);
    expect(accounts[0].label).not.toBe('fixture account');
    expect(accounts[0].identifier).not.toBe('fixture-user');
    expect(accounts[0].origin).not.toBe(ORIGIN);
    expect(accounts[0].handle).toMatch(/^cred_[a-f0-9]{32}$/);
  });

  it('approves the site for the profile after Save and fill, for every later list and fill', async () => {
    const { service, connection } = await setup();
    await service.pinBrowserId(SESSION, 'FixtureAgent');
    await service.handlePrivateUi(connection(), { operation: 'unlock' });
    const saveRequest = await service.handlePublic(SESSION, { action: 'save_login', tabId: 13 });
    const saved = await service.handlePrivateUi(connection(), {
      operation: 'save', requestId: saveRequest.requestId, origin: ORIGIN,
      identifier: 'fixture-user', password: 'synthetic-only', label: 'fixture', allowSession: true, saveAndFill: true,
    });
    expect(saved).toMatchObject({ success: true, status: 'accepted' });
    const grants = (await service.handlePrivateUi(connection(), { operation: 'getState' }) as any).grants;
    expect(grants).toEqual([expect.objectContaining({ purpose: 'site', origin: ORIGIN, via: 'page', sessionLabel: 'Every agent session' })]);
    expect(grants[0]).not.toHaveProperty('oneShot');
    expect(grants[0]).not.toHaveProperty('sessionId');
    const listed = await service.handlePublic(SESSION, { action: 'list', tabId: 13 });
    expect(listed).toMatchObject({ success: true, status: 'ready' });
    const handle = (listed.accounts as Array<{ handle: string }>)[0].handle;
    expect(await service.handlePublic(SESSION, { action: 'fill', tabId: 13, handle }))
      .toMatchObject({ success: true, status: 'filled' });
    const retained = (await service.handlePrivateUi(connection(), { operation: 'getState' }) as any).grants;
    expect(retained).toEqual([expect.objectContaining({ purpose: 'site', grantId: grants[0].grantId })]);
  });

  it('runs an approved fill request exactly once and lets later fills on the site go ahead', async () => {
    const { service, state, connection } = await setup();
    await service.handlePrivateUi(connection(), { operation: 'unlock' });
    const saveRequest = await service.handlePublic(SESSION, { action: 'save_login', tabId: 14 });
    const saved = await service.handlePrivateUi(connection(), {
      operation: 'save', requestId: saveRequest.requestId, origin: ORIGIN,
      identifier: 'fixture-user', password: 'synthetic-only', label: 'fixture', allowSession: false, saveAndFill: false,
    });
    const handle = String(saved.handle);
    const approval = await service.handlePublic(SESSION, { action: 'fill', tabId: 14, handle });
    expect(approval).toMatchObject({ status: 'user_action_required', purpose: 'fill' });
    const approved = await service.handlePrivateUi(connection(), {
      operation: 'approve', requestId: approval.requestId, credentialId: handle, purpose: 'fill',
    });
    expect(approved).toMatchObject({ success: true, status: 'filled', filled_fields: 1 });
    expect(state.fillCount).toBe(1);
    expect(await service.handlePublic(SESSION, { action: 'status', requestId: approval.requestId })).toMatchObject({ status: 'accepted' });
    expect((await service.handlePrivateUi(connection(), { operation: 'getState' }) as any).grants)
      .toEqual([expect.objectContaining({ purpose: 'site', origin: ORIGIN, via: 'page' })]);
    const nextFill = await service.handlePublic(SESSION, { action: 'fill', tabId: 14, handle });
    expect(nextFill).toMatchObject({ success: true, status: 'filled' });
    expect(state.fillCount).toBe(2);
  });

  it('lets one list approval cover listing and filling for every session of the profile', async () => {
    const { service, state, connection } = await setup();
    await service.handlePrivateUi(connection(), { operation: 'unlock' });
    const handle = await saveAccount(service, connection, 17);
    const listRequest = await service.handlePublic(SESSION, { action: 'list', tabId: 17 });
    expect(listRequest).toMatchObject({ status: 'user_action_required', purpose: 'approve' });
    expect(await service.handlePrivateUi(connection(), { operation: 'approve', requestId: listRequest.requestId, purpose: 'list' }))
      .toMatchObject({ success: true, status: 'approved' });
    expect(await service.handlePublic(OTHER_SESSION, { action: 'list', tabId: 17 })).toMatchObject({ success: true, status: 'ready' });
    expect(await service.handlePublic(OTHER_SESSION, { action: 'fill', tabId: 17, handle })).toMatchObject({ success: true, status: 'filled' });
    // The session that asked ending, or the extension reconnecting, does not end the site approval.
    service.revokeSession(SESSION);
    const previous = state.context.connectionId;
    state.context = { ...state.context, connectionId: 'connection-fixture-0002' };
    service.revokeConnection(state.context.browserId, previous);
    expect(await service.handlePublic(SESSION, { action: 'fill', tabId: 17, handle })).toMatchObject({ success: true, status: 'filled' });
    expect(state.fillCount).toBe(2);
  });

  it('ends every site approval when the vault locks, and the owner can revoke one', async () => {
    const { service, connection } = await setup();
    await service.handlePrivateUi(connection(), { operation: 'unlock' });
    const handle = await saveAccount(service, connection, 18);
    const approval = await service.handlePublic(SESSION, { action: 'list', tabId: 18 });
    await service.handlePrivateUi(connection(), { operation: 'approve', requestId: approval.requestId, purpose: 'list' });
    await service.handlePrivateUi(connection(), { operation: 'lock' });
    await service.handlePrivateUi(connection(), { operation: 'unlock' });
    expect(await service.handlePublic(SESSION, { action: 'fill', tabId: 18, handle })).toMatchObject({ status: 'user_action_required' });

    const again = await service.handlePublic(SESSION, { action: 'list', tabId: 18 });
    await service.handlePrivateUi(connection(), { operation: 'approve', requestId: again.requestId, purpose: 'list' });
    const [grant] = (await service.handlePrivateUi(connection(), { operation: 'getState' }) as any).grants;
    expect(await service.handlePrivateUi(connection(), { operation: 'revoke', grantId: grant.grantId })).toMatchObject({ success: true });
    expect(await service.handlePublic(SESSION, { action: 'list', tabId: 18 })).toMatchObject({ status: 'user_action_required' });
  });

  it('does not let a list approval request grant a fill permission without a fill request', async () => {
    const { service, connection } = await setup();
    await service.handlePrivateUi(connection(), { operation: 'unlock' });
    const saveRequest = await service.handlePublic(SESSION, { action: 'save_login', tabId: 14 });
    const saved = await service.handlePrivateUi(connection(), {
      operation: 'save', requestId: saveRequest.requestId, origin: ORIGIN,
      identifier: 'fixture-user', password: 'synthetic-only', label: 'fixture', allowSession: false, saveAndFill: false,
    });
    const listRequest = await service.handlePublic(SESSION, { action: 'list', tabId: 14 });
    const denied = await service.handlePrivateUi(connection(), {
      operation: 'approve', requestId: listRequest.requestId, credentialId: saved.handle, purpose: 'fill',
    });
    expect(denied).toMatchObject({ success: false, code: 'VAULT_PERMISSION_DENIED' });
    expect(await service.handlePublic(SESSION, { action: 'fill', tabId: 14, handle: saved.handle }))
      .toMatchObject({ status: 'user_action_required', purpose: 'fill' });
  });

  it('requires explicit session consent before saving and filling', async () => {
    const { service, connection } = await setup();
    await service.handlePrivateUi(connection(), { operation: 'unlock' });
    const request = await service.handlePublic(SESSION, { action: 'save_login', tabId: 15 });
    const result = await service.handlePrivateUi(connection(), {
      operation: 'save', requestId: request.requestId, origin: ORIGIN,
      identifier: 'fixture-user', password: 'synthetic-only', label: 'fixture', allowSession: false, saveAndFill: true,
    });
    expect(result).toMatchObject({ success: false, code: 'VAULT_PERMISSION_DENIED' });
    expect((await service.handlePublic(SESSION, { action: 'list', tabId: 15 })).status).toBe('user_action_required');
  });

  it('cancels pending private requests when the trusted vault page closes', async () => {
    const { service, connection } = await setup();
    const request = await service.handlePublic(SESSION, { action: 'save_login', tabId: 16 });
    service.cancelPrivateUiRequests(connection().browserId, connection().connectionId);
    const status = await service.handlePublic(SESSION, { action: 'status', requestId: request.requestId });
    expect(status).toMatchObject({ success: true, status: 'cancelled' });
    const lateSave = await service.handlePrivateUi(connection(), {
      operation: 'save', requestId: request.requestId, origin: ORIGIN,
      identifier: 'fixture-user', password: 'synthetic-only', label: 'fixture', allowSession: false, saveAndFill: false,
    });
    expect(lateSave).toMatchObject({ success: true, status: 'cancelled' });
    expect((await service.handlePrivateUi(connection(), { operation: 'getState' }) as any).entries).toEqual([]);
  });

  it('rejects grants and private requests from a replacement extension connection', async () => {
    const { service, state, connection } = await setup();
    await service.handlePrivateUi(connection(), { operation: 'unlock' });
    const created = await service.handlePublic(SESSION, { action: 'save_login', tabId: 5 });
    const requestId = String(created.requestId);
    const originalConnection = connection();
    state.context = { ...state.context, connectionId: 'connection-replacement-0001' };
    service.revokeConnection(state.context.browserId, originalConnection.connectionId);
    const replacement = connection();
    const result = await service.handlePrivateUi(replacement, {
      operation: 'save', requestId, origin: ORIGIN,
      identifier: 'fixture-user', password: 'synthetic-only', label: 'fixture', allowSession: false, saveAndFill: false,
    });
    expect(result).toMatchObject({ success: false, code: 'VAULT_PERMISSION_DENIED' });
  });

  it('checks the live connection and grant again before resolving a fill secret', async () => {
    const { service, state, connection } = await setup();
    await service.handlePrivateUi(connection(), { operation: 'unlock' });
    const created = await service.handlePublic(SESSION, { action: 'save_login', tabId: 11 });
    const requestId = String(created.requestId);
    const saved = await service.handlePrivateUi(connection(), {
      operation: 'save', requestId, origin: ORIGIN,
      identifier: 'fixture-user', password: 'synthetic-only', label: 'fixture', allowSession: true, saveAndFill: false,
    });
    const handle = String(saved.handle);
    let contextCalls = 0;
    const original = state.context;
    const transport = (service as unknown as { transport: VaultTransport }).transport;
    const getContext = transport.getBrowserContext.bind(transport);
    transport.getBrowserContext = async (sessionId) => {
      contextCalls++;
      if (contextCalls >= 3) state.context = { ...original, connectionId: 'connection-replacement-0001' };
      return getContext(sessionId);
    };
    const result = await service.handlePublic(SESSION, { action: 'fill', tabId: 11, handle });
    expect(result).toMatchObject({ success: false, code: 'VAULT_PERMISSION_DENIED' });
    expect(state.fillCount).toBe(0);
  });

  describe('in-page approval card (specs/006)', () => {
    async function setupCard(now?: () => number) {
      const context = await setup({ supportsSiteApproval: true }, now);
      context.state.prompt = () => ({ success: true, shown: true });
      return context;
    }
    const prompts = (state: { calls: Array<{ action: string; params: Record<string, unknown> }> }) =>
      state.calls.filter((call) => call.action === 'prompt').map((call) => call.params);
    /** Waits until the daemon holds `count` live requests on the connection, so a joining call has reached the journal. */
    async function waitForRequests(service: VaultService, connection: () => PrivateConnection, count: number): Promise<void> {
      for (let attempt = 0; attempt < 500; attempt++) {
        const view = await service.handlePrivateUi(connection(), { operation: 'getState' }) as { requests?: unknown[] };
        if ((view.requests?.length ?? 0) >= count) return;
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      throw new Error(`the daemon never held ${count} live requests`);
    }

    it('waits for an allow on the card and answers the same list call', async () => {
      const { service, state, connection } = await setupCard();
      await service.pinBrowserId(SESSION, 'FixtureAgent');
      await service.handlePrivateUi(connection(), { operation: 'unlock' });
      await saveAccount(service, connection, 20);
      const openedBefore = state.calls.filter((call) => call.action === 'openUi').length;
      const listing = service.handlePublic(SESSION, { action: 'list', tabId: 20 });
      await waitFor(() => prompts(state).length === 1);
      expect(prompts(state)[0]).toMatchObject({
        tabId: 20, origin: ORIGIN, documentId: 'document-fixture', purpose: 'list', unlock: false, agentName: 'FixtureAgent',
      });
      const decided = await service.handlePrivateUi(connection(), {
        operation: 'cardDecision', requestId: prompts(state)[0].requestId, decision: 'allow', always: false,
      });
      expect(decided).toMatchObject({ success: true, status: 'approved' });
      expect(await listing).toMatchObject({ success: true, status: 'ready', accounts: [expect.objectContaining({ handle: expect.any(String) })] });
      expect(state.calls.filter((call) => call.action === 'openUi')).toHaveLength(openedBefore);
      expect((await service.handlePrivateUi(connection(), { operation: 'getState' }) as any).grants)
        .toEqual([expect.objectContaining({ purpose: 'site', via: 'card' })]);
    });

    it('unlocks a locked vault from the card and fills in the same call', async () => {
      const { service, state, connection } = await setupCard();
      await service.handlePrivateUi(connection(), { operation: 'unlock' });
      const handle = await saveAccount(service, connection, 21);
      await service.handlePrivateUi(connection(), { operation: 'lock' });
      const filling = service.handlePublic(SESSION, { action: 'fill', tabId: 21, handle });
      await waitFor(() => prompts(state).length === 1);
      expect(prompts(state)[0]).toMatchObject({ purpose: 'fill', unlock: true });
      expect(prompts(state)[0]).not.toHaveProperty('account');
      await service.handlePrivateUi(connection(), { operation: 'cardDecision', requestId: prompts(state)[0].requestId, decision: 'allow', always: false });
      expect(await filling).toMatchObject({ success: true, status: 'filled' });
      expect(state.fillCount).toBe(1);
    });

    it('reports a denial as VAULT_DECLINED and approves nothing', async () => {
      const { service, state, connection } = await setupCard();
      await service.handlePrivateUi(connection(), { operation: 'unlock' });
      const handle = await saveAccount(service, connection, 22);
      const filling = service.handlePublic(SESSION, { action: 'fill', tabId: 22, handle });
      await waitFor(() => prompts(state).length === 1);
      expect(prompts(state)[0]).toMatchObject({ purpose: 'fill', account: 'fixture' });
      await service.handlePrivateUi(connection(), { operation: 'cardDecision', requestId: prompts(state)[0].requestId, decision: 'deny', always: false });
      expect(await filling).toMatchObject({ success: false, code: 'VAULT_DECLINED' });
      expect(state.fillCount).toBe(0);
      expect((await service.handlePrivateUi(connection(), { operation: 'getState' }) as any).grants).toEqual([]);
    });

    it('shows one card for concurrent requests on a site and settles them with one decision', async () => {
      const { service, state, connection } = await setupCard();
      await service.handlePrivateUi(connection(), { operation: 'unlock' });
      const handle = await saveAccount(service, connection, 23);
      const listing = service.handlePublic(SESSION, { action: 'list', tabId: 23 });
      const filling = service.handlePublic(OTHER_SESSION, { action: 'fill', tabId: 23, handle });
      await waitFor(() => prompts(state).length === 1);
      // Let the second call reach the journal and join the card instead of drawing its own.
      await waitForRequests(service, connection, 2);
      expect(prompts(state)).toHaveLength(1);
      await service.handlePrivateUi(connection(), { operation: 'cardDecision', requestId: prompts(state)[0].requestId, decision: 'allow', always: false });
      expect(await listing).toMatchObject({ success: true, status: 'ready' });
      expect(await filling).toMatchObject({ success: true, status: 'filled' });
    });

    it('allowlists a site with "always", so later approvals need no card after the vault unlocks again', async () => {
      const { service, state, connection } = await setupCard();
      await service.handlePrivateUi(connection(), { operation: 'unlock' });
      const handle = await saveAccount(service, connection, 24);
      const listing = service.handlePublic(SESSION, { action: 'list', tabId: 24 });
      await waitFor(() => prompts(state).length === 1);
      const refused = await service.handlePrivateUi(connection(), { operation: 'cardDecision', requestId: prompts(state)[0].requestId, decision: 'deny', always: true });
      expect(refused).toMatchObject({ success: false, code: 'INVALID_ARGUMENT' });
      await service.handlePrivateUi(connection(), { operation: 'cardDecision', requestId: prompts(state)[0].requestId, decision: 'allow', always: true });
      expect(await listing).toMatchObject({ success: true, status: 'ready' });
      expect((await service.handlePrivateUi(connection(), { operation: 'getState' }) as any).allowlist)
        .toEqual([expect.objectContaining({ origin: ORIGIN })]);

      await service.handlePrivateUi(connection(), { operation: 'lock' });
      await service.handlePrivateUi(connection(), { operation: 'unlock' });
      expect(await service.handlePublic(OTHER_SESSION, { action: 'fill', tabId: 24, handle })).toMatchObject({ success: true, status: 'filled' });
      expect(prompts(state)).toHaveLength(1);
      expect((await service.handlePrivateUi(connection(), { operation: 'getState' }) as any).grants)
        .toEqual([expect.objectContaining({ purpose: 'site', via: 'allowlist' })]);

      // Removing the site from the allowlist ends the approval it gave.
      expect(await service.handlePrivateUi(connection(), { operation: 'allowlistRemove', origin: ORIGIN })).toMatchObject({ success: true, status: 'removed' });
      expect((await service.handlePrivateUi(connection(), { operation: 'getState' }) as any).grants).toEqual([]);
      const asked = service.handlePublic(SESSION, { action: 'list', tabId: 24 });
      await waitFor(() => prompts(state).length === 2);
      await service.handlePrivateUi(connection(), { operation: 'cardDecision', requestId: prompts(state)[1].requestId, decision: 'cancel', always: false });
      expect(await asked).toMatchObject({ status: 'cancelled' });
    });

    it('lets the owner allowlist a typed site from the vault page, and refuses one that is not a site origin', async () => {
      const { service, connection } = await setupCard();
      expect(await service.handlePrivateUi(connection(), { operation: 'allowlistAdd', origin: 'https://fixture.test/login' }))
        .toMatchObject({ success: false, code: 'VAULT_LOCKED' });
      await service.handlePrivateUi(connection(), { operation: 'unlock' });
      expect(await service.handlePrivateUi(connection(), { operation: 'allowlistAdd', origin: 'https://fixture.test/login' }))
        .toMatchObject({ success: true, status: 'added', origin: ORIGIN });
      expect(await service.handlePrivateUi(connection(), { operation: 'allowlistAdd', origin: ORIGIN }))
        .toMatchObject({ success: true, status: 'unchanged' });
      expect(await service.handlePrivateUi(connection(), { operation: 'allowlistAdd', origin: 'javascript:alert(1)' }))
        .toMatchObject({ success: false, code: 'INVALID_ARGUMENT' });
      expect(await service.handlePrivateUi(connection(), { operation: 'allowlistAdd', origin: 'https://owner:secret@fixture.test' }))
        .toMatchObject({ success: false, code: 'INVALID_ARGUMENT' });
      expect(await service.handlePublic(SESSION, { action: 'list', tabId: 25 })).toMatchObject({ success: true, status: 'ready' });
    });

    it('reads a typed bare host as HTTPS, and a bare loopback host as HTTP', async () => {
      const { service, connection } = await setupCard();
      await service.handlePrivateUi(connection(), { operation: 'unlock' });
      const add = (origin: string) => service.handlePrivateUi(connection(), { operation: 'allowlistAdd', origin });
      expect(await add('fixture.test')).toMatchObject({ success: true, origin: 'https://fixture.test' });
      expect(await add('127.0.0.1:8123')).toMatchObject({ success: true, origin: 'http://127.0.0.1:8123' });
      expect(await add('localhost:3000/login')).toMatchObject({ success: true, origin: 'http://localhost:3000' });
      expect(await add('https://localhost:3443')).toMatchObject({ success: true, origin: 'https://localhost:3443' });
      expect(await add('http://fixture.test')).toMatchObject({ success: false, code: 'INVALID_ARGUMENT' });
    });

    it('moves the request to the private page when the owner picks it on the card', async () => {
      const { service, state, connection } = await setupCard();
      await service.handlePrivateUi(connection(), { operation: 'unlock' });
      const listing = service.handlePublic(SESSION, { action: 'list', tabId: 26 });
      await waitFor(() => prompts(state).length === 1);
      const requestId = prompts(state)[0].requestId;
      expect(await service.handlePrivateUi(connection(), { operation: 'cardDecision', requestId, decision: 'page', always: false }))
        .toMatchObject({ success: true, status: 'moved' });
      const reply = await listing;
      expect(reply).toMatchObject({ status: 'user_action_required', requestId });
      expect(String(reply.message)).not.toMatch(/approval card/);
      expect(state.calls.some((call) => call.action === 'openUi' && call.params.requestId === requestId)).toBe(true);
      expect(await service.handlePrivateUi(connection(), { operation: 'approve', requestId, purpose: 'list' }))
        .toMatchObject({ success: true, status: 'approved' });
    });

    it('opens the private page when the extension cannot draw the card', async () => {
      const { service, state, connection } = await setupCard();
      state.prompt = () => ({ success: false, code: 'VAULT_TARGET_UNSAFE' });
      await service.handlePrivateUi(connection(), { operation: 'unlock' });
      const reply = await service.handlePublic(SESSION, { action: 'list', tabId: 27 });
      expect(reply).toMatchObject({ status: 'user_action_required', purpose: 'approve' });
      expect(state.calls.some((call) => call.action === 'openUi' && call.params.requestId === reply.requestId)).toBe(true);
    });

    it('answers a waiting call when its own request is cancelled, and accepts decisions only for card requests on this connection', async () => {
      const { service, state, connection } = await setupCard();
      await service.handlePrivateUi(connection(), { operation: 'unlock' });
      const controller = new AbortController();
      const listing = service.handlePublic(SESSION, { action: 'list', tabId: 28 }, controller.signal);
      await waitFor(() => prompts(state).length === 1);
      const requestId = prompts(state)[0].requestId;
      const stranger = { ...connection(), connectionId: 'connection-stranger-0001' };
      expect(await service.handlePrivateUi(stranger, { operation: 'cardDecision', requestId, decision: 'allow', always: false }))
        .toMatchObject({ success: false, code: 'VAULT_PERMISSION_DENIED' });
      controller.abort();
      expect(await listing).toMatchObject({ status: 'user_action_required', requestId });
      // The card still stands for the owner; a later call joins it rather than drawing another.
      const again = service.handlePublic(SESSION, { action: 'list', tabId: 28 });
      await waitForRequests(service, connection, 2);
      expect(prompts(state)).toHaveLength(1);
      await service.handlePrivateUi(connection(), { operation: 'cardDecision', requestId, decision: 'allow', always: false });
      expect(await again).toMatchObject({ success: true, status: 'ready' });

      const saveRequest = await service.handlePublic(SESSION, { action: 'save_login', tabId: 28 });
      expect(await service.handlePrivateUi(connection(), { operation: 'cardDecision', requestId: saveRequest.requestId, decision: 'allow', always: false }))
        .toMatchObject({ success: false, code: 'VAULT_PERMISSION_DENIED' });
    });

    it('closes the card when its request ends without a card decision', async () => {
      let clock = Date.now();
      const { service, state, connection } = await setupCard(() => clock);
      await service.handlePrivateUi(connection(), { operation: 'unlock' });
      const listing = service.handlePublic(SESSION, { action: 'list', tabId: 29 });
      await waitFor(() => prompts(state).length === 1);
      const requestId = prompts(state)[0].requestId;
      clock += 5 * 60_000;
      await service.handlePrivateUi(connection(), { operation: 'getState' });
      expect(await listing).toMatchObject({ status: 'expired' });
      await waitFor(() => state.calls.some((call) => call.action === 'promptClose' && call.params.requestId === requestId));
    });

    it('keeps the card for the site when its session ends: the call ends cancelled, and Allow still approves the site', async () => {
      const { service, state, connection, setLive } = await setupCard();
      await service.handlePrivateUi(connection(), { operation: 'unlock' });
      const listing = service.handlePublic(SESSION, { action: 'list', tabId: 29 });
      await waitFor(() => prompts(state).length === 1);
      const requestId = prompts(state)[0].requestId;
      setLive(false);
      service.revokeSession(SESSION);
      expect(await listing).toMatchObject({ status: 'cancelled' });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(state.calls.some((call) => call.action === 'promptClose')).toBe(false);
      const inspections = state.calls.filter((call) => call.action === 'inspect').length;
      expect(await service.handlePrivateUi(connection(), { operation: 'cardDecision', requestId, decision: 'allow', always: false }))
        .toMatchObject({ success: true, status: 'approved', requestId });
      // The ended session is not used to look at the page again; the extension ends the card with its document.
      expect(state.calls.filter((call) => call.action === 'inspect')).toHaveLength(inspections);
      const after = await service.handlePrivateUi(connection(), { operation: 'getState' }) as any;
      expect(after.grants).toEqual([expect.objectContaining({ purpose: 'site', via: 'card' })]);
      expect(after.requests).toEqual([]);
      await waitFor(() => state.calls.some((call) => call.action === 'promptClose' && call.params.requestId === requestId));
      expect(state.calls.find((call) => call.action === 'promptClose')?.params.connectionId).toBe(state.context.connectionId);
      // The card decides once; its own request stays cancelled.
      expect(await service.handlePrivateUi(connection(), { operation: 'cardDecision', requestId, decision: 'deny', always: false }))
        .toMatchObject({ success: false, code: 'VAULT_REQUEST_EXPIRED' });
      expect((await service.handlePrivateUi(connection(), { operation: 'getState' }) as any).grants).toHaveLength(1);
    });

    it('keeps the requests that joined a card on it when the card’s session ends, and moves them to the next card for the site', async () => {
      const { service, state, connection } = await setupCard();
      await service.pinBrowserId(OTHER_SESSION, 'OtherAgent');
      await service.handlePrivateUi(connection(), { operation: 'unlock' });
      const leading = service.handlePublic(SESSION, { action: 'list', tabId: 30 });
      await waitFor(() => prompts(state).length === 1);
      const joined = service.handlePublic(OTHER_SESSION, { action: 'list', tabId: 30 });
      await waitForRequests(service, connection, 2);
      service.revokeSession(SESSION);
      expect(await leading).toMatchObject({ status: 'cancelled' });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(prompts(state)).toHaveLength(1);
      // A later request gets a card that names its own agent; the held card comes down and its requests move over.
      const later = service.handlePublic(OTHER_SESSION, { action: 'list', tabId: 30 });
      await waitFor(() => prompts(state).length === 2);
      expect(prompts(state)[1]).toMatchObject({ agentName: 'OtherAgent' });
      expect(state.calls.some((call) => call.action === 'promptClose' && call.params.requestId === prompts(state)[0].requestId)).toBe(true);
      expect(await service.handlePrivateUi(connection(), { operation: 'cardDecision', requestId: prompts(state)[1].requestId, decision: 'deny', always: false }))
        .toMatchObject({ success: true, status: 'declined' });
      expect(await joined).toMatchObject({ success: false, code: 'VAULT_DECLINED' });
      expect(await later).toMatchObject({ success: false, code: 'VAULT_DECLINED' });
      expect(state.calls.some((call) => call.action === 'openUi')).toBe(false);
    });

    it('lets a held card decline the requests that joined it', async () => {
      const { service, state, connection } = await setupCard();
      await service.handlePrivateUi(connection(), { operation: 'unlock' });
      const leading = service.handlePublic(SESSION, { action: 'list', tabId: 35 });
      await waitFor(() => prompts(state).length === 1);
      const joined = service.handlePublic(OTHER_SESSION, { action: 'list', tabId: 35 });
      await waitForRequests(service, connection, 2);
      service.revokeSession(SESSION);
      await leading;
      expect(await service.handlePrivateUi(connection(), { operation: 'cardDecision', requestId: prompts(state)[0].requestId, decision: 'deny', always: false }))
        .toMatchObject({ success: true, status: 'cancelled' });
      expect(await joined).toMatchObject({ success: false, code: 'VAULT_DECLINED' });
      expect((await service.handlePrivateUi(connection(), { operation: 'getState' }) as any).grants).toEqual([]);
    });

    it('holds a card whose session ends while it is being drawn, and takes down one that never showed', async () => {
      const { service, state, connection } = await setupCard();
      await service.handlePrivateUi(connection(), { operation: 'unlock' });
      let draw!: (value: unknown) => void;
      state.prompt = () => new Promise((resolve) => { draw = resolve; });
      const listing = service.handlePublic(SESSION, { action: 'list', tabId: 36 });
      await waitFor(() => prompts(state).length === 1);
      service.revokeSession(SESSION);
      draw({ success: true, shown: true });
      expect(await listing).toMatchObject({ status: 'cancelled' });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(state.calls.some((call) => call.action === 'promptClose')).toBe(false);
      expect(await service.handlePrivateUi(connection(), { operation: 'cardDecision', requestId: prompts(state)[0].requestId, decision: 'allow', always: false }))
        .toMatchObject({ success: true, status: 'approved' });

      // Locking ends that approval, so the next request asks again.
      await service.handlePrivateUi(connection(), { operation: 'lock' });
      await service.handlePrivateUi(connection(), { operation: 'unlock' });
      const other = service.handlePublic(OTHER_SESSION, { action: 'list', tabId: 37 });
      await waitFor(() => prompts(state).length === 2);
      const otherId = prompts(state)[1].requestId;
      service.revokeSession(OTHER_SESSION);
      draw({ success: false, code: 'VAULT_TARGET_UNSAFE' });
      expect(await other).toMatchObject({ status: 'cancelled' });
      await waitFor(() => state.calls.some((call) => call.action === 'promptClose' && call.params.requestId === otherId));
      expect(await service.handlePrivateUi(connection(), { operation: 'cardDecision', requestId: otherId, decision: 'allow', always: false }))
        .toMatchObject({ success: false, code: 'VAULT_REQUEST_EXPIRED' });
    });

    it('finishes an Allow for the site when the asking session ends during it', async () => {
      const { service, state, connection } = await setupCard();
      await service.handlePrivateUi(connection(), { operation: 'unlock' });
      const listing = service.handlePublic(SESSION, { action: 'list', tabId: 38 });
      await waitFor(() => prompts(state).length === 1);
      const joined = service.handlePublic(OTHER_SESSION, { action: 'list', tabId: 38 });
      await waitForRequests(service, connection, 2);
      let fail!: () => void;
      state.inspectHook = () => new Promise((_resolve, reject) => { fail = () => reject(new Error('NOT_CONNECTED: gone')); });
      const inspections = state.calls.filter((call) => call.action === 'inspect').length;
      const deciding = service.handlePrivateUi(connection(), { operation: 'cardDecision', requestId: prompts(state)[0].requestId, decision: 'allow', always: false });
      await waitFor(() => state.calls.filter((call) => call.action === 'inspect').length > inspections);
      state.inspectHook = undefined;
      // The page check runs through the asking session, which ends while it waits.
      service.revokeSession(SESSION);
      fail();
      expect(await deciding).toMatchObject({ success: true, status: 'approved' });
      expect(await listing).toMatchObject({ status: 'cancelled' });
      expect(await joined).toMatchObject({ success: true, status: 'ready' });
      expect((await service.handlePrivateUi(connection(), { operation: 'getState' }) as any).grants)
        .toEqual([expect.objectContaining({ purpose: 'site', via: 'card' })]);
    });

    it('lets a held card approve the requests that joined it', async () => {
      const { service, state, connection } = await setupCard();
      await service.handlePrivateUi(connection(), { operation: 'unlock' });
      await service.handlePrivateUi(connection(), { operation: 'lock' });
      const leading = service.handlePublic(SESSION, { action: 'list', tabId: 30 });
      await waitFor(() => prompts(state).length === 1);
      const joined = service.handlePublic(OTHER_SESSION, { action: 'list', tabId: 30 });
      await waitForRequests(service, connection, 2);
      service.revokeSession(SESSION);
      await leading;
      // A locked vault unlocks from the held card, as from a live one.
      expect(await service.handlePrivateUi(connection(), { operation: 'cardDecision', requestId: prompts(state)[0].requestId, decision: 'allow', always: true }))
        .toMatchObject({ success: true, status: 'approved' });
      expect(await joined).toMatchObject({ success: true, status: 'ready' });
      const after = await service.handlePrivateUi(connection(), { operation: 'getState' }) as any;
      expect(after.grants).toEqual([expect.objectContaining({ purpose: 'site', via: 'allowlist' })]);
      expect(after.allowlist).toEqual([expect.objectContaining({ origin: ORIGIN })]);
    });

    it('moves the requests that joined a held card to the private page when the card expires', async () => {
      let clock = Date.now();
      const { service, state, connection } = await setupCard(() => clock);
      await service.handlePrivateUi(connection(), { operation: 'unlock' });
      const leading = service.handlePublic(SESSION, { action: 'list', tabId: 31 });
      await waitFor(() => prompts(state).length === 1);
      const requestId = prompts(state)[0].requestId;
      clock += 60_000;
      const joined = service.handlePublic(OTHER_SESSION, { action: 'list', tabId: 31 });
      await waitForRequests(service, connection, 2);
      service.revokeSession(SESSION);
      expect(await leading).toMatchObject({ status: 'cancelled' });
      // Past the card's expiry, before the joined request's own.
      clock += 4 * 60_000 + 1_000;
      await service.handlePrivateUi(connection(), { operation: 'getState' });
      const reply = await joined;
      expect(reply).toMatchObject({ status: 'user_action_required' });
      expect(state.calls.some((call) => call.action === 'openUi' && call.params.requestId === reply.requestId)).toBe(true);
      expect(state.calls.some((call) => call.action === 'promptClose' && call.params.requestId === requestId)).toBe(true);
      expect(await service.handlePrivateUi(connection(), { operation: 'cardDecision', requestId, decision: 'allow', always: false }))
        .toMatchObject({ success: false, code: 'VAULT_REQUEST_EXPIRED' });
      // The owner can still approve the moved request there, and the approval covers the site.
      expect(await service.handlePrivateUi(connection(), { operation: 'approve', requestId: reply.requestId, purpose: 'list' }))
        .toMatchObject({ success: true, status: 'approved' });
      expect((await service.handlePrivateUi(connection(), { operation: 'getState' }) as any).grants)
        .toEqual([expect.objectContaining({ purpose: 'site' })]);
    });

    it('takes down a held card that outlived its retention when no call expired it first', async () => {
      let clock = Date.now();
      const { service, state, connection } = await setupCard(() => clock);
      await service.handlePrivateUi(connection(), { operation: 'unlock' });
      const listing = service.handlePublic(SESSION, { action: 'list', tabId: 34 });
      await waitFor(() => prompts(state).length === 1);
      const requestId = prompts(state)[0].requestId;
      service.revokeSession(SESSION);
      await listing;
      clock += 16 * 60_000;
      service.revokeSession(OTHER_SESSION);
      await waitFor(() => state.calls.some((call) => call.action === 'promptClose' && call.params.requestId === requestId));
    });

    it('ends a held card with its connection, and with a move to the vault page when nothing waits on it', async () => {
      const { service, state, connection } = await setupCard();
      await service.handlePrivateUi(connection(), { operation: 'unlock' });
      const first = service.handlePublic(SESSION, { action: 'list', tabId: 32 });
      await waitFor(() => prompts(state).length === 1);
      const firstId = prompts(state)[0].requestId;
      service.revokeSession(SESSION);
      await first;
      service.revokeConnection(state.context.browserId, state.context.connectionId);
      await waitFor(() => state.calls.some((call) => call.action === 'promptClose' && call.params.requestId === firstId));
      expect(await service.handlePrivateUi(connection(), { operation: 'cardDecision', requestId: firstId, decision: 'allow', always: false }))
        .toMatchObject({ success: false, code: 'VAULT_REQUEST_EXPIRED' });

      const second = service.handlePublic(OTHER_SESSION, { action: 'list', tabId: 33 });
      await waitFor(() => prompts(state).length === 2);
      const secondId = prompts(state)[1].requestId;
      service.revokeSession(OTHER_SESSION);
      await second;
      // Nothing is left to move: the daemon says so, and the extension opens the vault page itself.
      expect(await service.handlePrivateUi(connection(), { operation: 'cardDecision', requestId: secondId, decision: 'page', always: false }))
        .toMatchObject({ success: false, code: 'VAULT_REQUEST_EXPIRED' });
      expect((await service.handlePrivateUi(connection(), { operation: 'getState' }) as any).grants).toEqual([]);
    });

    it('opens no page for joined requests that one card decision settled', async () => {
      const { service, state, connection } = await setupCard();
      await service.handlePrivateUi(connection(), { operation: 'unlock' });
      const leading = service.handlePublic(SESSION, { action: 'list', tabId: 31 });
      await waitFor(() => prompts(state).length === 1);
      const joined = service.handlePublic(OTHER_SESSION, { action: 'list', tabId: 31 });
      await waitForRequests(service, connection, 2);
      const openedBefore = state.calls.filter((call) => call.action === 'openUi').length;
      await service.handlePrivateUi(connection(), { operation: 'cardDecision', requestId: prompts(state)[0].requestId, decision: 'deny', always: false });
      expect(await leading).toMatchObject({ code: 'VAULT_DECLINED' });
      expect(await joined).toMatchObject({ code: 'VAULT_DECLINED' });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(state.calls.filter((call) => call.action === 'openUi')).toHaveLength(openedBefore);
    });

    it('ends an "always" approval from the card as soon as the owner removes the site from the list', async () => {
      const { service, state, connection } = await setupCard();
      await service.handlePrivateUi(connection(), { operation: 'unlock' });
      const listing = service.handlePublic(SESSION, { action: 'list', tabId: 32 });
      await waitFor(() => prompts(state).length === 1);
      await service.handlePrivateUi(connection(), { operation: 'cardDecision', requestId: prompts(state)[0].requestId, decision: 'allow', always: true });
      expect(await listing).toMatchObject({ success: true, status: 'ready' });
      expect((await service.handlePrivateUi(connection(), { operation: 'getState' }) as any).grants)
        .toEqual([expect.objectContaining({ purpose: 'site', via: 'allowlist' })]);
      await service.handlePrivateUi(connection(), { operation: 'allowlistRemove', origin: ORIGIN });
      expect((await service.handlePrivateUi(connection(), { operation: 'getState' }) as any).grants).toEqual([]);
    });

    it('writes one grant audit row for an "always" decision', async () => {
      const { service, state, connection } = await setupCard();
      await service.handlePrivateUi(connection(), { operation: 'unlock' });
      const store = (service as unknown as { storeFor(browserId: string): { audit(event: any): Promise<void> } }).storeFor(state.context.browserId);
      const original = store.audit.bind(store);
      const actions: string[] = [];
      store.audit = async (event: any) => {
        actions.push(event.action);
        return original(event);
      };
      const listing = service.handlePublic(SESSION, { action: 'list', tabId: 35 });
      await waitFor(() => prompts(state).length === 1);
      await service.handlePrivateUi(connection(), { operation: 'cardDecision', requestId: prompts(state)[0].requestId, decision: 'allow', always: true });
      expect(await listing).toMatchObject({ success: true, status: 'ready' });
      expect(actions.filter((action) => action === 'grant')).toHaveLength(1);
    });

    it('takes a revoked site off the always-allowed list, so the next list asks again', async () => {
      const { service, state, connection } = await setupCard();
      await service.handlePrivateUi(connection(), { operation: 'unlock' });
      expect(await service.handlePrivateUi(connection(), { operation: 'allowlistAdd', origin: ORIGIN })).toMatchObject({ status: 'added' });
      expect(await service.handlePublic(SESSION, { action: 'list', tabId: 36 })).toMatchObject({ success: true, status: 'ready' });
      const before = await service.handlePrivateUi(connection(), { operation: 'getState' }) as any;
      expect(before.grants).toEqual([expect.objectContaining({ purpose: 'site', via: 'allowlist' })]);
      expect(await service.handlePrivateUi(connection(), { operation: 'revoke', grantId: before.grants[0].grantId }))
        .toMatchObject({ success: true, status: 'revoked' });
      const after = await service.handlePrivateUi(connection(), { operation: 'getState' }) as any;
      expect(after.grants).toEqual([]);
      expect(after.allowlist ?? []).toEqual([]);
      const asked = service.handlePublic(SESSION, { action: 'list', tabId: 36 });
      await waitFor(() => prompts(state).length === 1);
      await service.handlePrivateUi(connection(), { operation: 'cardDecision', requestId: prompts(state)[0].requestId, decision: 'cancel', always: false });
      expect(await asked).toMatchObject({ status: 'cancelled' });
    });

    it('ends a card approval too when the owner removes its site from the list', async () => {
      const { service, state, connection } = await setupCard();
      await service.handlePrivateUi(connection(), { operation: 'unlock' });
      const listing = service.handlePublic(SESSION, { action: 'list', tabId: 37 });
      await waitFor(() => prompts(state).length === 1);
      await service.handlePrivateUi(connection(), { operation: 'cardDecision', requestId: prompts(state)[0].requestId, decision: 'allow', always: false });
      expect(await listing).toMatchObject({ success: true, status: 'ready' });
      await service.handlePrivateUi(connection(), { operation: 'allowlistAdd', origin: ORIGIN });
      expect((await service.handlePrivateUi(connection(), { operation: 'getState' }) as any).grants)
        .toEqual([expect.objectContaining({ purpose: 'site', via: 'card' })]);
      expect(await service.handlePrivateUi(connection(), { operation: 'allowlistRemove', origin: ORIGIN })).toMatchObject({ status: 'removed' });
      expect((await service.handlePrivateUi(connection(), { operation: 'getState' }) as any).grants).toEqual([]);
    });

    it('grants nothing when "always" cannot be added to the list', async () => {
      const { service, state, connection } = await setupCard();
      await service.handlePrivateUi(connection(), { operation: 'unlock' });
      const store = (service as unknown as { storeFor: (browserId: string) => { allowlistAdd: () => Promise<boolean> } })
        .storeFor(connection().browserId);
      store.allowlistAdd = async () => { throw new Error('allowlist limit reached'); };
      const listing = service.handlePublic(SESSION, { action: 'list', tabId: 33 });
      await waitFor(() => prompts(state).length === 1);
      const decided = await service.handlePrivateUi(connection(), {
        operation: 'cardDecision', requestId: prompts(state)[0].requestId, decision: 'allow', always: true,
      });
      expect(decided).toMatchObject({ success: false });
      expect((await service.handlePrivateUi(connection(), { operation: 'getState' }) as any).grants).toEqual([]);
      expect(await listing).not.toMatchObject({ status: 'ready' });
    });
  });
});
