import crypto from 'node:crypto';
import { CredentialVaultStore, VaultStorageError, scopeForBrowser } from './store.js';
import { VaultRedactionRegistry } from './redaction.js';
import { canonicalizeOrigin, metadataOf, randomId, VaultCredentialSchema, type VaultCredential, type VaultGrant, type VaultPrivateRequest } from './types.js';
import { OperationRegistry } from './operations.js';
import {
  TERMINAL_RETENTION_MS, VAULT_FILL_OPERATION_TIMEOUT_MS, VAULT_PENDING_TTL_MS,
  VaultServiceError, isRecord, publicError, safeCode, safeMessage, type VaultBrowserContext,
  type VaultInspection, type VaultTransport, type ProtectedDocument, type InternalPending,
  type PrivateConnection, type LiveGrant, type PendingOperation,
} from './service-common.js';

export abstract class VaultServiceCore {

  readonly redaction = new VaultRedactionRegistry();
  protected readonly auditPseudonymKey = crypto.randomBytes(32);
  protected readonly stores = new Map<string, CredentialVaultStore>();
  protected readonly grants = new Map<string, LiveGrant>();
  protected readonly requests = new Map<string, InternalPending>();
  protected readonly protectedDocuments = new Map<string, Map<string, ProtectedDocument>>();
  protected readonly operations = new OperationRegistry();
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
      if (typeof params.requestId !== 'string') throw new VaultServiceError('INVALID_ARGUMENT', 'request id is invalid');
      const pending = this.requests.get(params.requestId);
      if (!pending || pending.request.sessionId !== sessionId || pending.request.browserScope !== scopeForBrowser(context.browserId)) {
        return publicError('VAULT_PERMISSION_DENIED');
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
    if (!sessionId || !this.isSessionLive(sessionId)) throw new VaultServiceError('VAULT_PERMISSION_DENIED', 'session is no longer active');
    const current = await this.transport.getBrowserContext(sessionId);
    const context = { ...current, ...(this.sessionAgentNames.get(sessionId) ? { agentName: this.sessionAgentNames.get(sessionId) } : {}) };
    if (requireVault && !context.supportsVault) throw new VaultServiceError('VAULT_EXTENSION_REQUIRED', 'the connected extension does not support the credential vault');
    if (requireVault && (context.ambiguous || !context.browserId || context.browserId === 'default')) {
      throw new VaultServiceError('VAULT_PERMISSION_DENIED', 'browser identity is not unique and verified');
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

  protected async inspect(tabId: number, sessionId: string, signal?: AbortSignal): Promise<VaultInspection> {
    const result = await this.transport.callVaultAction('inspect', { tabId }, sessionId, signal, this.sessionAgentNames.get(sessionId));
    if (!isRecord(result) || result.success === false || result.tabId !== tabId
      || typeof result.origin !== 'string' || typeof result.documentId !== 'string'
      || typeof result.targetDocumentId !== 'string' || typeof result.nonce !== 'string' || !result.nonce
      || !Number.isInteger(result.frameId) || (result.frameId as number) < 0) {
      const code = isRecord(result) && typeof result.code === 'string' ? result.code : 'VAULT_TARGET_UNSAFE';
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
      ...(typeof result.reasonCode === 'string' ? { reasonCode: result.reasonCode } : {}),
    };
  }

  protected assertOrigin(origin: string): void {
    try { canonicalizeOrigin(origin); }
    catch { throw new VaultServiceError('VAULT_ORIGIN_MISMATCH', 'the current site is unsupported'); }
  }

  protected async beginRequest(
    context: VaultBrowserContext,
    input: Pick<VaultPrivateRequest, 'purpose' | 'sessionId' | 'tabId' | 'documentId' | 'origin' | 'credentialId'> & { label?: string },
  ): Promise<InternalPending> {
    const createdAt = this.now();
    const request: VaultPrivateRequest = {
      requestId: randomId('req'),
      purpose: input.purpose,
      sessionId: input.sessionId,
      browserScope: scopeForBrowser(context.browserId),
      ...(input.tabId !== undefined ? { tabId: input.tabId } : {}),
      ...(input.documentId ? { documentId: input.documentId } : {}),
      ...(input.origin ? { origin: input.origin } : {}),
      ...(input.credentialId ? { credentialId: input.credentialId } : {}),
      createdAt,
      expiresAt: createdAt + VAULT_PENDING_TTL_MS,
      state: 'pending',
    };
    const pending: InternalPending = {
      request,
      browserId: context.browserId,
      browserLabel: context.browserLabel,
      connectionId: context.connectionId,
      agentName: context.agentName || 'Connected session',
    };
    this.requests.set(request.requestId, pending);
    try {
      await this.transport.callVaultAction('openUi', { requestId: request.requestId }, input.sessionId, undefined, context.agentName);
    } catch {
      this.settle(pending, 'failed');
    }
    return pending;
  }

  protected requestRequired(pending: InternalPending, origin?: string): Record<string, unknown> {
    return {
      success: true,
      status: pending.request.state === 'pending' ? 'user_action_required' : pending.request.state,
      code: 'VAULT_USER_ACTION_REQUIRED',
      requestId: pending.request.requestId,
      purpose: pending.request.purpose,
      ...(origin ? { origin } : {}),
      message: safeMessage('VAULT_USER_ACTION_REQUIRED'),
    };
  }

  protected expireRequests(): void {
    const now = this.now();
    for (const [id, pending] of this.requests) {
      if (pending.request.state === 'pending' && pending.request.expiresAt <= now) {
        pending.request = { ...pending.request, state: 'expired' };
        pending.terminalAt = now;
      } else if (pending.terminalAt && now - pending.terminalAt > TERMINAL_RETENTION_MS) this.requests.delete(id);
    }
  }

  protected findGrant(context: VaultBrowserContext, sessionId: string, origin: string, purpose: 'list' | 'fill', credentialId?: string): LiveGrant | undefined {
    const scope = scopeForBrowser(context.browserId);
    return [...this.grants.values()].find((grant) => !grant.revoked && !grant.consumed && grant.expiresAt > this.now()
      && grant.sessionId === sessionId && grant.browserScope === scope && grant.connectionId === context.connectionId && grant.origin === origin
      && (grant.purpose === purpose || (purpose === 'list' && grant.purpose === 'fill' && !grant.oneShot))
      && (purpose === 'list' || !grant.credentialId || grant.credentialId === credentialId));
  }

  protected markProtected(scope: string, document: ProtectedDocument): void {
    let docs = this.protectedDocuments.get(scope);
    if (!docs) {
      docs = new Map();
      this.protectedDocuments.set(scope, docs);
    }
    docs.set(document.documentId, document);
  }

  protected pendingForConnection(connection: PrivateConnection, requestId: unknown): InternalPending | undefined {
    if (typeof requestId !== 'string') return undefined;
    const pending = this.requests.get(requestId);
    if (!pending || pending.request.browserScope !== scopeForBrowser(connection.browserId) || pending.connectionId !== connection.connectionId) return undefined;
    return pending;
  }

  protected claimPending(pending: InternalPending): boolean {
    if (pending.request.state !== 'pending' || pending.request.expiresAt <= this.now()) {
      this.settle(pending, pending.request.state === 'pending' ? 'expired' : pending.request.state);
      return false;
    }
    pending.request = { ...pending.request, state: 'processing' };
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    this.operations.track(pending.request.requestId, {
      scope: pending.request.browserScope,
      sessionId: pending.request.sessionId,
    }, undefined, { done, resolveDone });
    return true;
  }

  /** Ends a private request: its final state is recorded once, with the time it ended. */
  protected settle(pending: InternalPending, state: VaultPrivateRequest['state']): void {
    pending.request = { ...pending.request, state };
    pending.terminalAt = this.now();
  }

  /** Cancels matching live private requests and aborts the work bound to them. */
  protected cancelRequests(matching: (pending: InternalPending) => boolean = () => true): void {
    for (const pending of this.requests.values()) {
      if (!matching(pending) || !['pending', 'processing'].includes(pending.request.state)) continue;
      this.settle(pending, 'cancelled');
      this.operations.abort(pending.request.requestId);
    }
  }

  protected async cancelScopeOperations(scope: string): Promise<void> {
    this.cancelRequests((pending) => pending.request.browserScope === scope);
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

  protected revalidatePending(pending: InternalPending): boolean {
    return pending.request.expiresAt > this.now() && this.isSessionLive(pending.request.sessionId);
  }

  protected async revalidateDocument(pending: InternalPending, connection: PrivateConnection): Promise<void> {
    if (pending.request.tabId === undefined || !pending.request.documentId || !pending.request.origin) return;
    const current = await this.transport.getBrowserContext(pending.request.sessionId);
    if (current.browserId !== connection.browserId || current.connectionId !== connection.connectionId || !current.supportsVault || current.ambiguous) {
      throw new VaultServiceError('VAULT_PERMISSION_DENIED', 'the initiating browser identity changed');
    }
    const inspection = await this.inspect(pending.request.tabId, pending.request.sessionId);
    if (inspection.origin !== pending.request.origin || inspection.documentId !== pending.request.documentId) {
      throw new VaultServiceError('VAULT_DOCUMENT_CHANGED', 'the page changed while the private request was open');
    }
  }

  protected createGrant(
    context: PrivateConnection,
    sessionId: string,
    origin: string,
    purpose: 'list' | 'fill',
    credentialId?: string,
    oneShot = false,
  ): LiveGrant {
    const grant: LiveGrant = {
      grantId: randomId('grant'),
      sessionId,
      browserScope: scopeForBrowser(context.browserId),
      connectionId: context.connectionId,
      origin,
      ...(credentialId ? { credentialId } : {}),
      purpose,
      ...(oneShot ? { oneShot: true } : {}),
      createdAt: this.now(),
      expiresAt: Number.MAX_SAFE_INTEGER,
      revoked: false,
    };
    this.grants.set(grant.grantId, grant);
    return grant;
  }

  protected requestState(pending: InternalPending): Record<string, unknown> {
    return { success: true, status: pending.request.state, requestId: pending.request.requestId };
  }

  protected async ensureUiUnlocked(store: CredentialVaultStore): Promise<void> {
    const state = await store.status();
    if (state === 'empty') await store.initialize();
    else if (state === 'incomplete') throw new VaultServiceError('VAULT_RECOVERY_REQUIRED', 'the vault files are incomplete');
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

  protected abstract fillGranted(context: VaultBrowserContext, sessionId: string, tabId: number, initial: VaultInspection, handle: string, signal?: AbortSignal, grantId?: string): Promise<Record<string, unknown>>;
}
