import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { VaultService, type VaultBrowserContext, type VaultTransport } from '../mcp-server/src/vault/service.js';
import { safeMessage } from '../mcp-server/src/vault/service-common.js';
import { scopeForBrowser } from '../mcp-server/src/vault/store.js';
import { forwardHandler } from '../mcp-server/src/tools/types.js';
import { routeVaultAwareCall } from '../mcp-server/src/vault/daemon-routing.js';

const ORIGIN = 'https://fixture.test';
const SESSION = 'session-fixture';

function makeTransport(overrides: Partial<VaultBrowserContext> = {}) {
  const state: {
    context: VaultBrowserContext;
    calls: Array<{ action: string; params: Record<string, unknown> }>;
    fillCount: number;
    disconnect: boolean;
    fillHook?: (signal?: AbortSignal) => Promise<unknown>;
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
      throw new Error('unexpected action');
    },
  };
  return { state, transport };
}

describe('VaultService', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  async function setup(overrides: Partial<VaultBrowserContext> = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bc-vault-service-'));
    roots.push(root);
    const { state, transport } = makeTransport(overrides);
    let live = true;
    const service = new VaultService(root, transport, () => live);
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

  it('pins tab-list replies to the selected replacement profile and revokes the old profile grant', async () => {
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

    state.context = { ...state.context, browserId: 'profile-fixture', browserLabel: 'Fixture', connectionId: 'connection-fixture-0001' };
    await service.pinBrowserId(SESSION);
    const needsApproval = await service.handlePublic(SESSION, { action: 'fill', tabId: 3, handle });
    expect(needsApproval).toMatchObject({ status: 'user_action_required', purpose: 'fill' });
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

  it('retains a session fill grant after the Save and fill attempt completes', async () => {
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
    expect(grants).toEqual([expect.objectContaining({ purpose: 'fill', handle: expect.any(String) })]);
    expect(grants[0]).not.toHaveProperty('oneShot');
    expect(grants[0].sessionLabel).toBe('FixtureAgent · session fixture');
    expect(grants[0]).not.toHaveProperty('sessionId');
    const handle = grants[0].handle;
    expect(await service.handlePublic(SESSION, { action: 'list', tabId: 13 })).toMatchObject({ success: true, status: 'ready' });
    expect(await service.handlePublic(SESSION, { action: 'fill', tabId: 13, handle }))
      .toMatchObject({ success: true, status: 'filled' });
    const retained = (await service.handlePrivateUi(connection(), { operation: 'getState' }) as any).grants;
    expect(retained).toEqual([expect.objectContaining({ purpose: 'fill', handle })]);
    expect(retained[0]).not.toHaveProperty('oneShot');
  });

  it('completes a dedicated one-fill request exactly once without retaining its grant', async () => {
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
    expect((await service.handlePrivateUi(connection(), { operation: 'getState' }) as any).grants).toEqual([]);
    expect(state.fillCount).toBe(1);
    const nextFill = await service.handlePublic(SESSION, { action: 'fill', tabId: 14, handle });
    expect(nextFill).toMatchObject({ success: true, status: 'user_action_required', purpose: 'fill' });
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
});
