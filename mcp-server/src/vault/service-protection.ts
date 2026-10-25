import { scopeForBrowser } from './store.js';
import { canonicalizeOrigin } from './types.js';
import { PROFILE_WIDE_DENIED_TOOLS, PROTECTED_ALLOWED_TOOLS, TERMINAL_RETENTION_MS, VaultServiceError, isRecord, publicError } from './service-common.js';
import { VaultServicePrivate } from './service-private.js';

/**
 * Owns when a redaction record may be removed. Removal waits for every browser
 * reply that was already in flight, so a closed protected tab cannot free a
 * secret before the output that may echo it has been sanitized.
 */
class RedactionRemovalQueue {
  private readonly inFlight = new Map<string, number>();
  private readonly deferred = new Map<string, Set<string>>();

  constructor(
    private readonly removeDocument: (scope: string, documentId: string) => void,
    private readonly isStillProtected: (scope: string, documentId: string) => boolean,
  ) {}

  /** Defers removals for `scope`; the returned release is idempotent. */
  retain(scope: string): () => void {
    this.inFlight.set(scope, (this.inFlight.get(scope) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.inFlight.get(scope) ?? 1) - 1;
      if (remaining > 0) {
        this.inFlight.set(scope, remaining);
        return;
      }
      this.inFlight.delete(scope);
      const deferred = this.deferred.get(scope);
      this.deferred.delete(scope);
      for (const documentId of deferred ?? []) {
        if (!this.isStillProtected(scope, documentId)) this.removeDocument(scope, documentId);
      }
    };
  }

  /** Removes now, or once the last retained reply for `scope` is sanitized. */
  removeWhenIdle(scope: string, documentId: string): void {
    if ((this.inFlight.get(scope) ?? 0) > 0) {
      let deferred = this.deferred.get(scope);
      if (!deferred) {
        deferred = new Set();
        this.deferred.set(scope, deferred);
      }
      deferred.add(documentId);
      return;
    }
    this.removeDocument(scope, documentId);
  }
}

export abstract class VaultServiceProtection extends VaultServicePrivate {
  private readonly redactionRemovals = new RedactionRemovalQueue(
    (scope, documentId) => this.redaction.removeDocument(scope, documentId),
    (scope, documentId) => this.protectedDocuments.get(scope)?.has(documentId) === true,
  );

  async pinBrowserId(sessionId: string, agentName?: string): Promise<string> {
    if (!sessionId || !this.isSessionLive(sessionId)) throw new VaultServiceError('VAULT_PERMISSION_DENIED', 'session is no longer active');
    if (agentName) this.sessionAgentNames.set(sessionId, agentName);
    const context = await this.transport.getBrowserContext(sessionId);
    if (!context.browserId || !context.connectionId) throw new VaultServiceError('VAULT_PERMISSION_DENIED', 'browser identity is unavailable');
    const previous = this.sessionBrowserIds.get(sessionId);
    if (previous && previous !== context.browserId) this.revokeSession(sessionId);
    this.sessionBrowserIds.set(sessionId, context.browserId);
    return context.browserId;
  }

  endSession(sessionId: string): void {
    this.revokeSession(sessionId);
    this.sessionBrowserIds.delete(sessionId);
    this.sessionAgentNames.delete(sessionId);
  }

  /** Keep output redaction available until the active browser call has been scrubbed. */
  retainRedactionForBrowser(browserId: string): () => void {
    return this.redactionRemovals.retain(scopeForBrowser(browserId));
  }

  async sanitizeForSession(sessionId: string, value: unknown, toolName?: string, pinnedBrowserId?: string): Promise<unknown> {
    let browserId = pinnedBrowserId;
    try {
      if (!browserId) browserId = (await this.contextForSession(sessionId, false)).browserId;
    } catch {
      // For a disconnected session, use the last pinned source profile only.
      // It is safe for generic transport errors and prevents an old profile's
      // redaction records from being bypassed by connection loss.
    }
    browserId ??= this.sessionBrowserIds.get(sessionId);
    if (typeof value === 'string' && value.startsWith('NOT_CONNECTED:')) {
      return 'NOT_CONNECTED: The selected browser is unavailable. Select a connected browser with browser_tabs.';
    }
    if (!browserId) {
      // Bridge-generated disconnect errors contain no browser/page payload.
      // Keep their useful ordinary browsing diagnosis while dropping selected
      // browser labels and arbitrary error detail from an unknown scope.
      return publicError('VAULT_PERMISSION_DENIED');
    }
    const scope = scopeForBrowser(browserId);
    const documents = this.protectedDocuments.get(scope);
    if (this.protectionUnknownScopes.has(scope)) {
      if (toolName === 'browser_navigate' && !isRecord(value)) return 'Navigation finished; inspect the page privately to continue.';
      if (toolName === 'browser_navigate' && isRecord(value)) {
        return {
          ...(typeof value.success === 'boolean' ? { success: value.success } : { success: false }),
          ...(Number.isInteger(value.tabId) ? { tabId: value.tabId } : {}),
        };
      }
      return publicError('VAULT_RECOVERY_REQUIRED');
    }
    if (toolName === 'browser_navigate' && [...(documents?.values() ?? [])].some((document) => document.state === 'recovery_required')) {
      if (!isRecord(value)) return 'Navigation finished; inspect the page privately to continue.';
      return {
        ...(typeof value.success === 'boolean' ? { success: value.success } : { success: false }),
        ...(Number.isInteger(value.tabId) ? { tabId: value.tabId } : {}),
      };
    }
    if (toolName && PROFILE_WIDE_DENIED_TOOLS.has(toolName) && (documents?.size ?? 0) > 0) {
      return publicError('VAULT_CONTEXT_PROTECTED');
    }
    return this.redaction.sanitize(scope, value, { toolName });
  }

  async assertToolAllowed(sessionId: string, tool: string, params: Record<string, unknown>): Promise<void> {
    let browserId: string | undefined;
    try {
      browserId = (await this.contextForSession(sessionId, false)).browserId;
    } catch {
      browserId = this.sessionBrowserIds.get(sessionId);
      if (!browserId) return; // Let the bridge return its normal NOT_CONNECTED error.
    }
    const scope = scopeForBrowser(browserId);
    const docs = this.protectedDocuments.get(scope);
    if (this.protectionUnknownScopes.has(scope)) {
      if (tool === 'browser_tabs' && (params.action === 'close' || params.action === 'focus')) return;
      if (tool === 'browser_navigate' && params.snapshot !== true) return;
      throw new VaultServiceError('VAULT_RECOVERY_REQUIRED', 'the extension protection state could not be recovered safely');
    }
    if (!docs || docs.size === 0) return;
    // Named/opener windows and active-window capture are profile-wide surfaces.
    // Keep these operations unavailable while any protected page may contain
    // a value, even when the agent selected a different tab after fill.
    if (PROFILE_WIDE_DENIED_TOOLS.has(tool)) throw new VaultServiceError('VAULT_CONTEXT_PROTECTED', 'profile outputs are blocked while a protected page is live');
    if (tool === 'browser_batch') {
      const actions = Array.isArray(params.actions) ? params.actions : [];
      for (const action of actions) {
        if (isRecord(action) && typeof action.tool === 'string'
          && (PROFILE_WIDE_DENIED_TOOLS.has(action.tool) || action.tool === 'browser_batch')) {
          throw new VaultServiceError('VAULT_CONTEXT_PROTECTED', 'this batch contains an operation blocked while a protected page is live');
        }
      }
    }
    const tabId = typeof params.tabId === 'number' ? params.tabId : null;
    const affected = tabId === null
      ? [...docs.values()]
      : [...docs.values()].filter((doc) => doc.tabId === tabId && doc.current);
    if (affected.length === 0) return;
    if (affected.some((doc) => doc.state === 'recovery_required')) {
      if (tool === 'browser_tabs') {
        if (params.action === 'close' || params.action === 'focus') return;
      }
      if (tool === 'browser_navigate' && params.snapshot !== true) return;
      throw new VaultServiceError('VAULT_RECOVERY_REQUIRED', 'protected document outputs are blocked until the page is safely recovered');
    }
    if (!PROTECTED_ALLOWED_TOOLS.has(tool)) throw new VaultServiceError('VAULT_CONTEXT_PROTECTED', 'this page may contain a saved password');
  }

  /** Full state from an authenticated extension connection; no secret values are accepted. */

  noteProtectionState(
    browserId: string,
    connectionId: string,
    sequence: number,
    documents: unknown,
    protectionUnknown = false,
    unknownTabIds: unknown = [],
  ): void {
    if (!connectionId || !Number.isSafeInteger(sequence) || sequence < 0) return;
    const scope = scopeForBrowser(browserId);
    const sequenceKey = `${scope}:${connectionId}`;
    const lastSequence = this.protectionSequences.get(sequenceKey) ?? -1;
    if (sequence <= lastSequence) return;
    this.protectionConnections.set(scope, connectionId);
    this.protectionSequences.set(sequenceKey, sequence);
    if (protectionUnknown) {
      this.protectionUnknownScopes.add(scope);
      this.protectionUnknownTabs.set(scope, new Set(Array.isArray(unknownTabIds)
        ? unknownTabIds.filter((tabId): tabId is number => Number.isInteger(tabId) && tabId >= 0)
        : []));
    } else {
      this.protectionUnknownScopes.delete(scope);
      this.protectionUnknownTabs.delete(scope);
    }
    if (!Array.isArray(documents)) return;
    let current = this.protectedDocuments.get(scope);
    if (!current) {
      current = new Map();
      this.protectedDocuments.set(scope, current);
    }
    for (const value of documents) {
      if (!isRecord(value) || !Number.isInteger(value.tabId) || typeof value.documentId !== 'string'
        || !value.documentId || typeof value.origin !== 'string' || !['active', 'recovery_required'].includes(String(value.state))) continue;
      let origin: string;
      try { origin = canonicalizeOrigin(value.origin); } catch { continue; }
      const documentId = value.documentId;
      const state = this.redaction.hasSecretForDocument(scope, documentId) ? 'active' : 'recovery_required';
      current.set(documentId, {
        tabId: value.tabId as number,
        documentId,
        origin,
        state,
        current: value.current === true,
      });
    }
  }

  /** Only an authenticated, explicit tab-destruction event may clear taint. */

  discardProtectedTab(browserId: string, connectionId: string, tabId: number, documentIds: unknown): void {
    if (!connectionId || !Number.isInteger(tabId) || !Array.isArray(documentIds)) return;
    const scope = scopeForBrowser(browserId);
    if (this.protectionConnections.get(scope) !== connectionId) return;
    const unknownTabs = this.protectionUnknownTabs.get(scope);
    if (unknownTabs?.delete(tabId) && unknownTabs.size === 0) {
      this.protectionUnknownTabs.delete(scope);
      this.protectionUnknownScopes.delete(scope);
    }
    const docs = this.protectedDocuments.get(scope);
    if (!docs) return;
    for (const documentId of documentIds) {
      if (typeof documentId !== 'string') continue;
      const document = docs.get(documentId);
      if (!document || document.tabId !== tabId) continue;
      docs.delete(documentId);
      this.redactionRemovals.removeWhenIdle(scope, documentId);
    }
    if (docs.size === 0) this.protectedDocuments.delete(scope);
  }

  revokeSession(sessionId: string): void {
    this.cancelRequests((pending) => pending.request.sessionId === sessionId);
    for (const [id, pending] of this.requests) {
      if (pending.terminalAt && this.now() - pending.terminalAt > TERMINAL_RETENTION_MS) this.requests.delete(id);
    }
    for (const [id, grant] of this.grants) if (grant.sessionId === sessionId) this.grants.delete(id);
    for (const operation of this.operations.values()) if (operation.sessionId === sessionId) operation.controller.abort();
  }

  /** A reconnect is a new authority epoch even when the copied profile ID matches. */

  revokeConnection(browserId: string, connectionId: string): void {
    const scope = scopeForBrowser(browserId);
    for (const [id, grant] of this.grants) {
      if (grant.browserScope === scope && grant.connectionId === connectionId) this.grants.delete(id);
    }
    this.cancelRequests((pending) => pending.request.browserScope === scope && pending.connectionId === connectionId);
    for (const operation of this.operations.values()) {
      if (operation.scope === scope && operation.connectionId === connectionId) operation.controller.abort();
    }
  }

  /** Closing the authenticated private vault page cancels its waiting approvals. */

  cancelPrivateUiRequests(browserId: string, connectionId: string): void {
    const scope = scopeForBrowser(browserId);
    this.cancelRequests((pending) => pending.request.browserScope === scope && pending.connectionId === connectionId);
  }

  lockAll(): void {
    for (const grantId of this.grants.keys()) this.grants.delete(grantId);
    this.cancelRequests();
    for (const operation of this.operations.values()) operation.controller.abort();
    for (const store of this.stores.values()) store.lock();
  }
}
