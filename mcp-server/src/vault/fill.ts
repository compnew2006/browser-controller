import { scopeForBrowser } from './store.js';
import type { CredentialVaultStore } from './store.js';
import { randomId } from './types.js';
import { VAULT_FILL_OPERATION_TIMEOUT_MS, publicError, isRecord } from './service-common.js';
import type { ProtectedDocument, VaultBrowserContext, VaultInspection } from './service-common.js';
import type { GrantRegistry } from './grants.js';
import type { OperationRegistry } from './operations.js';

export interface FillWorkflowOptions {
  grants: GrantRegistry;
  operations: OperationRegistry;
  storeFor: (browserId: string) => CredentialVaultStore;
  /** The extension's isolated-world inspection of a tab. */
  inspectPage: (tabId: number, sessionId: string, signal?: AbortSignal) => Promise<VaultInspection>;
  /** The live browser identity, re-read to prove the connection did not change under the fill. */
  browserContext: (sessionId: string) => Promise<VaultBrowserContext>;
  fillPage: (params: Record<string, unknown>, sessionId: string, signal: AbortSignal, agentName?: string) => Promise<unknown>;
  registerSecret: (scope: string, secret: string, documentId: string) => void;
  markProtected: (scope: string, document: ProtectedDocument) => void;
  auditFill: (store: CredentialVaultStore, credentialId: string, sessionId: string, origin: string, result: 'success' | 'failed') => Promise<void>;
  now: () => number;
  isSessionLive: (sessionId: string) => boolean;
}

/**
 * One credential fill, from the grant check to the audit line.
 *
 * Every branch here is fail-closed: an aborted signal, a page that changed, a
 * grant that was revoked mid-fill and a fill whose outcome is unknown all end
 * with the document marked `recovery_required`. It knows the vault only through
 * the options above, so each of those branches can be exercised without a
 * browser (ADR-02).
 */
export class FillWorkflow {
  constructor(private readonly options: FillWorkflowOptions) {}

  async run(
    context: VaultBrowserContext,
    sessionId: string,
    tabId: number,
    initial: VaultInspection,
    handle: string,
    signal?: AbortSignal,
    grantId?: string,
  ): Promise<Record<string, unknown>> {
    const scope = scopeForBrowser(context.browserId);
    const store = this.options.storeFor(context.browserId);
    const operationId = randomId('fillop');
    const oneShotGrant = grantId ? this.options.grants.get(grantId) : undefined;
    if (!this.options.grants.claimOneShot(oneShotGrant, operationId)) return publicError('VAULT_PERMISSION_DENIED');
    const operation = this.options.operations.track(operationId, {
      scope,
      sessionId,
      connectionId: context.connectionId,
      ...(grantId ? { grantId } : {}),
      credentialId: handle,
    }, signal);
    const operationTimeout = setTimeout(() => operation.controller.abort(), VAULT_FILL_OPERATION_TIMEOUT_MS);
    const fillSignal = operation.controller.signal;
    // Whether the page gets secret text, and so redaction and protection; settled once the account is read.
    let protects = initial.mode !== 'identifier';
    try {
      if (grantId && !await this.grantStillUsable(grantId, context, sessionId, initial.origin, handle, fillSignal, operationId)) return publicError('VAULT_PERMISSION_DENIED');
      if (!store.isUnlocked) return publicError('VAULT_LOCKED', { origin: initial.origin });
      if (!initial.suitable) return publicError('VAULT_TARGET_UNSAFE', { origin: initial.origin });
      // Recheck before decrypting. The extension performs the final origin,
      // document, nonce and element-identity checks immediately before writing.
      const inspection = await this.options.inspectPage(tabId, sessionId, fillSignal);
      if (inspection.origin !== initial.origin) return publicError('VAULT_ORIGIN_MISMATCH');
      if (inspection.documentId !== initial.documentId) return publicError('VAULT_DOCUMENT_CHANGED');
      if (!inspection.suitable) return publicError('VAULT_TARGET_UNSAFE', { origin: inspection.origin });
      if (grantId && !await this.grantStillUsable(grantId, context, sessionId, initial.origin, handle, fillSignal, operationId)) return publicError('VAULT_PERMISSION_DENIED');
      const entry = await store.get(handle);
      if (fillSignal.aborted) return publicError('VAULT_PERMISSION_DENIED');
      if (!entry) return publicError('VAULT_PERMISSION_DENIED');
      if (entry.origin !== inspection.origin) return publicError('VAULT_ORIGIN_MISMATCH');
      if (grantId && !await this.grantStillUsable(grantId, context, sessionId, initial.origin, handle, fillSignal, operationId)) return publicError('VAULT_PERMISSION_DENIED');
      if (fillSignal.aborted) return publicError('VAULT_PERMISSION_DENIED');
      // A first sign-in step asks for the username only: no password reaches the page, so the
      // page is neither registered for redaction nor protected (specs/006 FR-012) — unless the
      // username itself carries the password.
      const identifierOnly = inspection.mode === 'identifier';
      const withIdentifier = identifierOnly || inspection.identifierField === true;
      protects = !identifierOnly || (entry.password.length > 0 && entry.identifier.includes(entry.password));
      if (protects) {
        this.options.registerSecret(scope, entry.password, inspection.documentId);
        this.options.markProtected(scope, { tabId, documentId: inspection.documentId, origin: inspection.origin, state: 'active', current: true });
      }
      const result = await this.options.fillPage({
        tabId,
        origin: inspection.origin,
        documentId: inspection.documentId,
        targetDocumentId: inspection.targetDocumentId,
        frameId: inspection.frameId,
        nonce: inspection.nonce,
        ...(identifierOnly ? {} : { password: entry.password }),
        ...(withIdentifier ? { identifier: entry.identifier } : {}),
      }, sessionId, fillSignal, context.agentName);
      const identifierFilled = withIdentifier && isRecord(result) && result.identifier_filled === true;
      const expectedFields = identifierOnly ? 1 : identifierFilled ? 2 : 1;
      if (fillSignal.aborted || !isRecord(result) || result.success !== true || result.filled_fields !== expectedFields
        || (identifierOnly && !identifierFilled)) {
        if (!protects) return publicError(fillSignal.aborted ? 'VAULT_OUTCOME_UNKNOWN' : 'VAULT_TARGET_UNSAFE', { origin: inspection.origin });
        this.options.markProtected(scope, { tabId, documentId: inspection.documentId, origin: inspection.origin, state: 'recovery_required', current: true });
        return publicError('VAULT_OUTCOME_UNKNOWN', { origin: inspection.origin });
      }
      await this.options.auditFill(store, handle, sessionId, inspection.origin, 'success');
      if (fillSignal.aborted) {
        if (protects) this.options.markProtected(scope, { tabId, documentId: inspection.documentId, origin: inspection.origin, state: 'recovery_required', current: true });
        return publicError('VAULT_OUTCOME_UNKNOWN', { origin: inspection.origin });
      }
      return {
        success: true,
        status: 'filled',
        filled_fields: expectedFields,
        origin: inspection.origin,
        ...(withIdentifier ? { identifier_filled: identifierFilled, password_filled: !identifierOnly } : {}),
      };
    } catch {
      if (!protects) {
        await this.options.auditFill(store, handle, sessionId, initial.origin, 'failed').catch(() => {});
        return publicError('VAULT_OUTCOME_UNKNOWN', { origin: initial.origin });
      }
      this.options.markProtected(scope, { tabId, documentId: initial.documentId, origin: initial.origin, state: 'recovery_required', current: true });
      await this.options.auditFill(store, handle, sessionId, initial.origin, 'failed').catch(() => {});
      return publicError('VAULT_OUTCOME_UNKNOWN', { origin: initial.origin });
    } finally {
      clearTimeout(operationTimeout);
      this.options.grants.consumeOneShot(oneShotGrant);
      this.options.operations.complete(operationId);
    }
  }

  /**
   * The grant, re-read after every await: a revoked, consumed, expired or reconnected grant stops the fill.
   * A site approval is not bound to a session or a connection, but the browser identity and the
   * connection still may not change during this one fill (specs/006 D2).
   */
  private async grantStillUsable(
    grantId: string,
    context: VaultBrowserContext,
    sessionId: string,
    origin: string,
    handle: string,
    signal?: AbortSignal,
    operationId?: string,
  ): Promise<boolean> {
    if (signal?.aborted || !this.options.isSessionLive(sessionId)) return false;
    const site = this.options.grants.getSite(grantId);
    if (site) {
      if (site.revoked || site.browserScope !== scopeForBrowser(context.browserId) || site.origin !== origin) return false;
      return this.sameBrowser(context, sessionId);
    }
    const grant = this.options.grants.get(grantId);
    if (!grant || grant.revoked || grant.expiresAt <= this.options.now() || grant.sessionId !== sessionId
      || grant.browserScope !== scopeForBrowser(context.browserId) || grant.connectionId !== context.connectionId
      || grant.origin !== origin || (grant.credentialId && grant.credentialId !== handle)) return false;
    if (grant.oneShot && (grant.consumed || grant.claimedBy !== operationId)) return false;
    return this.sameBrowser(context, sessionId);
  }

  /** The session's browser is still the verified, unique one this fill started with, on the same connection. */
  private async sameBrowser(context: VaultBrowserContext, sessionId: string): Promise<boolean> {
    try {
      const current = await this.options.browserContext(sessionId);
      return current.supportsVault && !current.ambiguous && current.browserId === context.browserId
        && current.connectionId === context.connectionId;
    } catch {
      return false;
    }
  }
}
