import crypto from 'node:crypto';
import { CredentialVaultStore, VaultStorageError, scopeForBrowser } from './store.js';
import { VaultRedactionRegistry } from './redaction.js';
import { canonicalizeOrigin, randomId, type VaultPrivateRequest } from './types.js';
import { OperationRegistry } from './operations.js';
import { GrantRegistry } from './grants.js';
import { RequestJournal } from './requests.js';
import { FillWorkflow } from './fill.js';
import {
  VaultServiceError, publicError, safeCode, safeMessage, type VaultBrowserContext,
  type VaultInspection, type VaultTransport, type ProtectedDocument, type InternalPending,
  type PrivateConnection, type PendingOperation,
} from './service-common.js';
import { isRecord } from '../core/guards.js';
import { ERROR_CODES, isKnownErrorCode } from '../core/error-codes.js';

export abstract class VaultServiceCore {

  readonly redaction = new VaultRedactionRegistry();
  protected readonly auditPseudonymKey = crypto.randomBytes(32);
  protected readonly stores = new Map<string, CredentialVaultStore>();
  protected readonly grants = new GrantRegistry(() => this.now());
  protected readonly operations = new OperationRegistry();
  protected readonly requests = new RequestJournal({
    now: () => this.now(),
    isSessionLive: (sessionId) => this.isSessionLive(sessionId),
    operations: this.operations,
    openUi: async (requestId, sessionId, agentName) => {
      await this.transport.callVaultAction('openUi', { requestId }, sessionId, undefined, agentName);
    },
    showCard: (pending) => this.showCard(pending),
    closeCard: (pending) => this.closeCard(pending),
  });
  /**
   * The fill is a strategy rather than an abstract method: nothing in this file
   * needs to know how a password reaches a page, and the branch table in
   * fill.ts is testable without a browser (ADR-02).
   */
  protected readonly fill = new FillWorkflow({
    grants: this.grants,
    operations: this.operations,
    storeFor: (browserId) => this.storeFor(browserId),
    inspectPage: (tabId, sessionId, signal) => this.inspect(tabId, sessionId, signal),
    browserContext: (sessionId) => this.transport.getBrowserContext(sessionId),
    fillPage: (params, sessionId, signal, agentName) => this.transport.callVaultAction('fill', params, sessionId, signal, agentName),
    registerSecret: (scope, secret, documentId) => this.redaction.register(scope, secret, documentId),
    markProtected: (scope, document) => this.markProtected(scope, document),
    auditFill: (store, credentialId, sessionId, origin, result) => this.writeAudit(store, 'fill', credentialId, sessionId, origin, result),
    now: () => this.now(),
    isSessionLive: (sessionId) => this.isSessionLive(sessionId),
  });
  protected readonly protectedDocuments = new Map<string, Map<string, ProtectedDocument>>();
  protected readonly protectionSequences = new Map<string, number>();
  protected readonly protectionConnections = new Map<string, string>();
  protected readonly protectionUnknownScopes = new Set<string>();
  protected readonly protectionUnknownTabs = new Map<string, Set<number>>();
  protected readonly sessionBrowserIds = new Map<string, string>();
  protected readonly sessionAgentNames = new Map<string, string>();

  constructor(
    protected readonly stateDir: string,
    protected readonly transport: VaultTransport,
    protected readonly isSessionLive: (sessionId: string) => boolean,
    protected readonly now: () => number = Date.now,
  ) {}

  protected async publicStatus(sessionId: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const context = await this.contextForSession(sessionId);
    if (params.requestId !== undefined) {
      if (typeof params.requestId !== 'string') throw new VaultServiceError(ERROR_CODES.INVALID_ARGUMENT, 'request id is invalid');
      const pending = this.requests.get(params.requestId);
      if (!pending || pending.request.sessionId !== sessionId || pending.request.browserScope !== scopeForBrowser(context.browserId)) {
        return publicError(ERROR_CODES.VAULT_PERMISSION_DENIED);
      }
      return {
        success: true,
        status: pending.request.state,
        requestId: pending.request.requestId,
        purpose: pending.request.purpose,
        ...(pending.request.origin ? { origin: pending.request.origin } : {}),
        ...(pending.request.credentialId ? { handle: pending.request.credentialId } : {}),
      };
    }
    const store = this.storeFor(context.browserId);
    const state = await store.status();
    return {
      success: true,
      status: state === 'ready' ? (store.isUnlocked ? 'ready' : 'locked') : state,
      browserLabel: context.browserLabel,
    };
  }

  protected async contextForSession(sessionId: string, requireVault = true): Promise<VaultBrowserContext> {
    if (!sessionId || !this.isSessionLive(sessionId)) throw new VaultServiceError(ERROR_CODES.VAULT_PERMISSION_DENIED, 'session is no longer active');
    const current = await this.transport.getBrowserContext(sessionId);
    const context = { ...current, ...(this.sessionAgentNames.get(sessionId) ? { agentName: this.sessionAgentNames.get(sessionId) } : {}) };
    if (requireVault && !context.supportsVault) throw new VaultServiceError(ERROR_CODES.VAULT_EXTENSION_REQUIRED, 'the connected extension does not support the credential vault');
    if (requireVault && (context.ambiguous || !context.browserId || context.browserId === 'default')) {
      throw new VaultServiceError(ERROR_CODES.VAULT_PERMISSION_DENIED, 'browser identity is not unique and verified');
    }
    return context;
  }

  protected storeFor(browserId: string): CredentialVaultStore {
    const scope = scopeForBrowser(browserId);
    let store = this.stores.get(scope);
    if (!store) {
      store = new CredentialVaultStore({ stateDir: this.stateDir, browserId });
      this.stores.set(scope, store);
    }
    return store;
  }

  /**
   * Draws the in-page approval card on the requesting tab (specs/006 D4). False when the extension
   * cannot: an older extension, a page it cannot script, or a refusal; the private page opens instead.
   */
  protected async showCard(pending: InternalPending): Promise<boolean> {
    const { request } = pending;
    if (request.tabId === undefined || !request.origin || !request.documentId) return false;
    let context: VaultBrowserContext;
    try { context = await this.transport.getBrowserContext(request.sessionId); }
    catch { return false; }
    if (!context.supportsSiteApproval || context.connectionId !== pending.connectionId) return false;
    const store = this.storeFor(pending.browserId);
    let account: string | undefined;
    if (request.credentialId && store.isUnlocked) {
      try { account = (await store.get(request.credentialId))?.label; } catch { account = undefined; }
    }
    const result = await this.transport.callVaultAction('prompt', {
      tabId: request.tabId,
      requestId: request.requestId,
      documentId: request.documentId,
      origin: request.origin,
      purpose: request.purpose === 'fill' ? 'fill' : 'list',
      browserLabel: pending.browserLabel.slice(0, 120),
      agentName: pending.agentName.slice(0, 120),
      unlock: !store.isUnlocked,
      ...(account ? { account: account.slice(0, 120) } : {}),
      expiresAt: request.expiresAt,
    }, request.sessionId, undefined, pending.agentName);
    return isRecord(result) && result.success === true && result.shown === true;
  }

  /** Takes down a card whose request ended without the card's own decision. */
  protected closeCard(pending: InternalPending): void {
    const { request } = pending;
    if (request.tabId === undefined) return;
    void Promise.resolve()
      .then(() => this.transport.closeCard(pending.connectionId, { tabId: request.tabId!, requestId: request.requestId }, request.sessionId))
      .catch(() => {});
  }

  protected async inspect(tabId: number, sessionId: string, signal?: AbortSignal): Promise<VaultInspection> {
    let withIdentifier: boolean;
    try { withIdentifier = (await this.transport.getBrowserContext(sessionId)).supportsSiteApproval === true; }
    catch { withIdentifier = false; }
    const result = await this.transport.callVaultAction('inspect', withIdentifier ? { tabId, withIdentifier: true } : { tabId }, sessionId, signal, this.sessionAgentNames.get(sessionId));
    if (!isRecord(result) || result.success === false || result.tabId !== tabId
      || typeof result.origin !== 'string' || typeof result.documentId !== 'string'
      || typeof result.targetDocumentId !== 'string' || typeof result.nonce !== 'string' || !result.nonce
      || !Number.isInteger(result.frameId) || (result.frameId as number) < 0) {
      // The extension names its own vault failure; a code the registry does not know falls back to the safe one.
      const reported = isRecord(result) && typeof result.code === 'string' ? result.code : '';
      const code = isKnownErrorCode(reported) ? reported : ERROR_CODES.VAULT_TARGET_UNSAFE;
      throw new VaultServiceError(code, 'the page could not be inspected safely');
    }
    const origin = canonicalizeOrigin(result.origin);
    return {
      tabId,
      origin,
      documentId: result.documentId,
      targetDocumentId: result.targetDocumentId,
      frameId: result.frameId as number,
      nonce: result.nonce,
      suitable: result.suitable === true,
      ...(withIdentifier && result.mode === 'identifier' ? { mode: 'identifier' as const } : {}),
      ...(withIdentifier && result.identifierField === true ? { identifierField: true } : {}),
      ...(typeof result.reasonCode === 'string' ? { reasonCode: result.reasonCode } : {}),
    };
  }

  protected assertOrigin(origin: string): void {
    try { canonicalizeOrigin(origin); }
    catch { throw new VaultServiceError(ERROR_CODES.VAULT_ORIGIN_MISMATCH, 'the current site is unsupported'); }
  }

  protected requestRequired(pending: InternalPending, origin?: string): Record<string, unknown> {
    return {
      success: true,
      status: pending.request.state === 'pending' ? 'user_action_required' : pending.request.state,
      code: ERROR_CODES.VAULT_USER_ACTION_REQUIRED,
      requestId: pending.request.requestId,
      purpose: pending.request.purpose,
      ...(origin ? { origin } : {}),
      message: pending.surface === 'card'
        ? 'The owner was asked on an approval card on this tab and has not decided yet. Call browser_vault again with the same action to keep waiting.'
        : safeMessage(ERROR_CODES.VAULT_USER_ACTION_REQUIRED),
    };
  }

  protected markProtected(scope: string, document: ProtectedDocument): void {
    let docs = this.protectedDocuments.get(scope);
    if (!docs) {
      docs = new Map();
      this.protectedDocuments.set(scope, docs);
    }
    docs.set(document.documentId, document);
  }

  protected async cancelScopeOperations(scope: string): Promise<void> {
    this.requests.cancelMatching((pending) => pending.request.browserScope === scope);
    const inScope = (operation: PendingOperation) => operation.scope === scope;
    this.operations.abortMatching(inScope);
    await this.operations.waitForMatching(inScope);
  }

  protected async cancelCredentialOperations(scope: string, credentialId: string): Promise<void> {
    const matching = (operation: PendingOperation) => operation.scope === scope && operation.credentialId === credentialId;
    this.operations.abortMatching(matching);
    await this.operations.waitForMatching(matching);
  }

  protected async cancelGrantOperations(grantId: string): Promise<void> {
    const matching = (operation: PendingOperation) => operation.grantId === grantId;
    this.operations.abortMatching(matching);
    await this.operations.waitForMatching(matching);
  }

  protected async revalidateDocument(pending: InternalPending, connection: PrivateConnection): Promise<void> {
    if (pending.request.tabId === undefined || !pending.request.documentId || !pending.request.origin) return;
    const current = await this.transport.getBrowserContext(pending.request.sessionId);
    if (current.browserId !== connection.browserId || current.connectionId !== connection.connectionId || !current.supportsVault || current.ambiguous) {
      throw new VaultServiceError(ERROR_CODES.VAULT_PERMISSION_DENIED, 'the initiating browser identity changed');
    }
    const inspection = await this.inspect(pending.request.tabId, pending.request.sessionId);
    if (inspection.origin !== pending.request.origin || inspection.documentId !== pending.request.documentId) {
      throw new VaultServiceError(ERROR_CODES.VAULT_DOCUMENT_CHANGED, 'the page changed while the private request was open');
    }
  }

  protected requestState(pending: InternalPending): Record<string, unknown> {
    return { success: true, status: pending.request.state, requestId: pending.request.requestId };
  }

  protected async ensureUiUnlocked(store: CredentialVaultStore): Promise<void> {
    const state = await store.status();
    if (state === 'empty') await store.initialize();
    else if (state === 'incomplete') throw new VaultServiceError(ERROR_CODES.VAULT_RECOVERY_REQUIRED, 'the vault files are incomplete');
    else if (!store.isUnlocked) await store.unlock();
  }

  protected auditEvent(action: Parameters<CredentialVaultStore['audit']>[0]['action'], browserScope: string, sessionId?: string, origin?: string, result: 'success' | 'denied' | 'cancelled' | 'failed' = 'success', credentialId?: string) {
    return {
      id: randomId('audit'), action, browserScope,
      ...(sessionId ? { sessionRef: crypto.createHmac('sha256', this.auditPseudonymKey).update(sessionId).digest('hex').slice(0, 24) } : {}),
      ...(origin ? { origin } : {}),
      at: this.now(), result, ...(credentialId ? { credentialId } : {}),
    } as Parameters<CredentialVaultStore['audit']>[0];
  }

  protected async writeAudit(
    store: CredentialVaultStore,
    action: Parameters<CredentialVaultStore['audit']>[0]['action'],
    credentialId?: string,
    sessionId?: string,
    origin?: string,
    result: 'success' | 'denied' | 'cancelled' | 'failed' = 'success',
  ): Promise<void> {
    if (!store.isUnlocked) return;
    await store.audit(this.auditEvent(action, store.namespace, sessionId, origin, result, credentialId));
  }
}
