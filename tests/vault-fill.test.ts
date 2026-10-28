import { describe, expect, it, vi } from 'vitest';
import { FillWorkflow } from '../mcp-server/src/vault/fill.js';
import { GrantRegistry } from '../mcp-server/src/vault/grants.js';
import { OperationRegistry } from '../mcp-server/src/vault/operations.js';
import { scopeForBrowser, type CredentialVaultStore } from '../mcp-server/src/vault/store.js';
import type { ProtectedDocument, VaultBrowserContext, VaultInspection } from '../mcp-server/src/vault/service-common.js';

const ORIGIN = 'https://example.test';
const HANDLE = 'cred_fixture';
const context: VaultBrowserContext = {
  browserId: 'browser-a',
  browserLabel: 'Fixture browser',
  connectionId: 'conn-1',
  agentName: 'FixtureAgent',
  supportsVault: true,
};
const inspection: VaultInspection = {
  tabId: 7,
  origin: ORIGIN,
  documentId: 'doc-1',
  targetDocumentId: 'doc-1',
  frameId: 0,
  nonce: 'nonce-1',
  suitable: true,
};
const entry = { id: HANDLE, kind: 'login' as const, label: 'Fixture', identifier: 'fixture', password: 'synthetic-passphrase', origin: ORIGIN, createdAt: 1, updatedAt: 1 };

function workflow(overrides: Record<string, unknown> = {}) {
  const grants = new GrantRegistry(() => 1_000);
  const operations = new OperationRegistry();
  const store = { isUnlocked: true, get: vi.fn(async () => entry) } as unknown as CredentialVaultStore;
  const protectedDocuments: ProtectedDocument[] = [];
  const audit = vi.fn(async () => {});
  const fillPage = vi.fn(async () => ({ success: true, filled_fields: 1 }));
  const inspectPage = vi.fn(async () => inspection);
  const flow = new FillWorkflow({
    grants,
    operations,
    storeFor: () => store,
    inspectPage,
    browserContext: async () => context,
    fillPage,
    registerSecret: vi.fn(),
    markProtected: (_scope, document) => { protectedDocuments.push(document); },
    auditFill: audit,
    now: () => 1_000,
    isSessionLive: () => true,
    ...overrides,
  });
  const grant = grants.create(context, 'session-1', ORIGIN, 'fill', HANDLE);
  return { flow, grants, operations, store, protectedDocuments, audit, fillPage, inspectPage, grant };
}

const run = (w: ReturnType<typeof workflow>, signal?: AbortSignal) =>
  w.flow.run(context, 'session-1', 7, inspection, HANDLE, signal, w.grant.grantId);

describe('fill workflow', () => {
  it('fills once, audits the success and leaves the document protected', async () => {
    const w = workflow();
    const result = await run(w);

    expect(result).toEqual({ success: true, status: 'filled', filled_fields: 1, origin: ORIGIN });
    expect(w.audit).toHaveBeenCalledWith(w.store, HANDLE, 'session-1', ORIGIN, 'success');
    expect(w.protectedDocuments).toEqual([expect.objectContaining({ documentId: 'doc-1', state: 'active' })]);
    expect(w.operations.signalFor('fillop')).toBeUndefined();
  });

  it('refuses before contacting the page when the page is no longer the same origin', async () => {
    const w = workflow({ inspectPage: async () => ({ ...inspection, origin: 'https://other.test' }) });
    const result = await run(w);

    expect(result).toMatchObject({ success: false, code: 'VAULT_ORIGIN_MISMATCH' });
    expect(w.fillPage).not.toHaveBeenCalled();
    expect(w.protectedDocuments).toEqual([]);
  });

  it('reports an unknown outcome and forces recovery when the page fills a different number of fields', async () => {
    const w = workflow({ fillPage: async () => ({ success: true, filled_fields: 2 }) });
    const result = await run(w);

    expect(result).toMatchObject({ success: false, code: 'VAULT_OUTCOME_UNKNOWN' });
    // The document was tainted as active before the write, then escalated: the
    // last word on it must be recovery_required, never active.
    expect(w.protectedDocuments.map((document) => document.state)).toEqual(['active', 'recovery_required']);
    expect(w.audit).not.toHaveBeenCalled();
  });

  it('records a failed audit and forces recovery when the fill throws', async () => {
    const w = workflow({ fillPage: async () => { throw new Error('daemon went away'); } });
    const result = await run(w);

    expect(result).toMatchObject({ success: false, code: 'VAULT_OUTCOME_UNKNOWN' });
    expect(w.audit).toHaveBeenCalledWith(w.store, HANDLE, 'session-1', ORIGIN, 'failed');
    expect(w.protectedDocuments.map((document) => document.state)).toEqual(['active', 'recovery_required']);
  });

  it('does not read the page when the vault is locked', async () => {
    const w = workflow({ storeFor: () => ({ isUnlocked: false, get: vi.fn() }) });
    const result = await run(w);

    expect(result).toMatchObject({ success: false, code: 'VAULT_LOCKED' });
    expect(w.inspectPage).not.toHaveBeenCalled();
  });

  it('refuses a fill whose signal is already aborted', async () => {
    const w = workflow();
    const controller = new AbortController();
    controller.abort();
    const result = await run(w, controller.signal);

    expect(result).toMatchObject({ success: false, code: 'VAULT_PERMISSION_DENIED' });
    expect(w.fillPage).not.toHaveBeenCalled();
  });

  it('consumes a one-shot grant once and refuses the next fill with it', async () => {
    const w = workflow();
    const oneShot = w.grants.create(context, 'session-1', ORIGIN, 'fill', HANDLE, true);

    const first = await w.flow.run(context, 'session-1', 7, inspection, HANDLE, undefined, oneShot.grantId);
    expect(first).toMatchObject({ status: 'filled' });
    expect(w.grants.get(oneShot.grantId)).toBeUndefined();

    const second = await w.flow.run(context, 'session-1', 7, inspection, HANDLE, undefined, oneShot.grantId);
    expect(second).toMatchObject({ success: false, code: 'VAULT_PERMISSION_DENIED' });
  });

  it('refuses when the grant was revoked between the check and the fill', async () => {
    const w = workflow();
    w.grants.revoke(w.grant.grantId);

    const result = await run(w);
    expect(result).toMatchObject({ success: false, code: 'VAULT_PERMISSION_DENIED' });
    expect(w.fillPage).not.toHaveBeenCalled();
  });

  describe('username field and site approvals (specs/006)', () => {
    const scope = scopeForBrowser(context.browserId);
    const runWith = (w: ReturnType<typeof workflow>, page: VaultInspection, grantId = w.grant.grantId) =>
      w.flow.run(context, 'session-1', 7, page, HANDLE, undefined, grantId);

    it('writes the username alone on a first sign-in step, with no password, redaction or protection', async () => {
      const page: VaultInspection = { ...inspection, mode: 'identifier' };
      const registerSecret = vi.fn();
      const fillPage = vi.fn(async (_params: Record<string, unknown>) => ({ success: true, filled_fields: 1, identifier_filled: true }));
      const w = workflow({ inspectPage: async () => page, registerSecret, fillPage });
      const result = await runWith(w, page);

      expect(result).toEqual({ success: true, status: 'filled', filled_fields: 1, origin: ORIGIN, identifier_filled: true, password_filled: false });
      const sent = fillPage.mock.calls[0][0];
      expect(sent).toMatchObject({ identifier: 'fixture' });
      expect(sent).not.toHaveProperty('password');
      expect(registerSecret).not.toHaveBeenCalled();
      expect(w.protectedDocuments).toEqual([]);
    });

    it('fails an identifier-only fill that wrote nothing as an unsafe target, without protecting the page', async () => {
      const page: VaultInspection = { ...inspection, mode: 'identifier' };
      const w = workflow({ inspectPage: async () => page, fillPage: async () => ({ success: true, filled_fields: 1, identifier_filled: false }) });
      expect(await runWith(w, page)).toMatchObject({ success: false, code: 'VAULT_TARGET_UNSAFE' });
      expect(w.protectedDocuments).toEqual([]);
    });

    it('protects the page when the username carries the password, even on an identifier-only step', async () => {
      const page: VaultInspection = { ...inspection, mode: 'identifier' };
      const registerSecret = vi.fn();
      const store = { isUnlocked: true, get: vi.fn(async () => ({ ...entry, identifier: 'x-synthetic-passphrase-x' })) };
      const w = workflow({
        inspectPage: async () => page,
        storeFor: () => store,
        registerSecret,
        fillPage: async () => ({ success: true, filled_fields: 1, identifier_filled: true }),
      });
      expect(await runWith(w, page)).toMatchObject({ success: true, status: 'filled' });
      expect(registerSecret).toHaveBeenCalledWith(scope, 'synthetic-passphrase', 'doc-1');
      expect(w.protectedDocuments).toEqual([expect.objectContaining({ state: 'active' })]);
    });

    it('writes username and password together when the form has both, and counts two fields', async () => {
      const page: VaultInspection = { ...inspection, identifierField: true };
      const fillPage = vi.fn(async (_params: Record<string, unknown>) => ({ success: true, filled_fields: 2, identifier_filled: true }));
      const w = workflow({ inspectPage: async () => page, fillPage });
      expect(await runWith(w, page)).toEqual({
        success: true, status: 'filled', filled_fields: 2, origin: ORIGIN, identifier_filled: true, password_filled: true,
      });
      expect(fillPage.mock.calls[0][0]).toMatchObject({ identifier: 'fixture', password: 'synthetic-passphrase' });
      expect(w.protectedDocuments).toEqual([expect.objectContaining({ state: 'active' })]);
    });

    it('accepts a password-only write when the username field was left alone, and refuses a count that does not match', async () => {
      const page: VaultInspection = { ...inspection, identifierField: true };
      const left = workflow({ inspectPage: async () => page, fillPage: async () => ({ success: true, filled_fields: 1, identifier_filled: false }) });
      expect(await runWith(left, page)).toMatchObject({ status: 'filled', filled_fields: 1, identifier_filled: false, password_filled: true });

      const mismatch = workflow({ inspectPage: async () => page, fillPage: async () => ({ success: true, filled_fields: 1, identifier_filled: true }) });
      expect(await runWith(mismatch, page)).toMatchObject({ success: false, code: 'VAULT_OUTCOME_UNKNOWN' });
      expect(mismatch.protectedDocuments.map((document) => document.state)).toEqual(['active', 'recovery_required']);
    });

    it('fills under a site approval for any session, and stops once that approval is revoked', async () => {
      const w = workflow();
      const site = w.grants.createSite(scope, ORIGIN, 'card');
      expect(await w.flow.run(context, 'session-9', 7, inspection, HANDLE, undefined, site.grantId)).toMatchObject({ status: 'filled' });

      const other = w.grants.createSite(scopeForBrowser('browser-b'), ORIGIN, 'card');
      expect(await w.flow.run(context, 'session-9', 7, inspection, HANDLE, undefined, other.grantId))
        .toMatchObject({ success: false, code: 'VAULT_PERMISSION_DENIED' });

      w.grants.revoke(site.grantId);
      expect(await w.flow.run(context, 'session-9', 7, inspection, HANDLE, undefined, site.grantId))
        .toMatchObject({ success: false, code: 'VAULT_PERMISSION_DENIED' });
    });
  });
});
