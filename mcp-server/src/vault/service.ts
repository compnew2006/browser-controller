import { scopeForBrowser } from './store.js';
import { randomId, type VaultPrivateRequest } from './types.js';
import { VAULT_FILL_OPERATION_TIMEOUT_MS, VaultServiceError, containsCredentialSecret, isRecord, metadataMarker, publicError, safePublicMetadataOf, type VaultBrowserContext, type VaultInspection } from './service-common.js';
import { VaultServiceProtection } from './service-protection.js';

export * from './service-common.js';

export class VaultService extends VaultServiceProtection {
  async handlePublic(sessionId: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    this.expireRequests();
    const action = params.action;
    if (action === 'status') return this.publicStatus(sessionId, params);
    const requestedTab = params.tabId;
    if (!Number.isInteger(requestedTab) || (requestedTab as number) < 0) throw new VaultServiceError('INVALID_ARGUMENT', 'tabId is required');
    const tabId = requestedTab as number;
    const context = await this.contextForSession(sessionId);
    if (action === 'save_login') {
      const inspection = await this.inspectSupportedSite(tabId, sessionId, signal);
      return this.requestForInspection(context, sessionId, tabId, inspection, 'save',
        typeof params.label === 'string' ? { label: params.label } : {});
    }
    if (action === 'unlock') {
      const inspection = await this.inspectSupportedSite(tabId, sessionId, signal);
      return this.requestForInspection(context, sessionId, tabId, inspection, 'unlock');
    }
    if (action === 'list') {
      const inspection = await this.inspectSupportedSite(tabId, sessionId, signal);
      const store = this.storeFor(context.browserId);
      const grant = this.findGrant(context, sessionId, inspection.origin, 'list');
      if (!grant) return this.requestForInspection(context, sessionId, tabId, inspection, 'approve');
      if (!store.isUnlocked) return this.requestForInspection(context, sessionId, tabId, inspection, 'unlock');
      const entries = await store.list();
      const scoped = entries.filter((entry) => entry.origin === inspection.origin
        && (!grant.credentialId || grant.credentialId === entry.id));
      const marker = metadataMarker(scoped);
      return {
        success: true,
        ...(containsCredentialSecret('ready', scoped) ? {} : { status: 'ready' }),
        ...(containsCredentialSecret(inspection.origin, scoped) ? {} : { origin: inspection.origin }),
        accounts: scoped.map((entry) => safePublicMetadataOf(entry, marker)),
      };
    }
    if (action === 'fill') {
      if (typeof params.handle !== 'string') throw new VaultServiceError('INVALID_ARGUMENT', 'account handle is required');
      const inspection = await this.inspectSupportedSite(tabId, sessionId, signal);
      const grant = this.findGrant(context, sessionId, inspection.origin, 'fill', params.handle);
      if (!grant) return this.requestForInspection(context, sessionId, tabId, inspection, 'fill', { credentialId: params.handle });
      return this.fillGranted(context, sessionId, tabId, inspection, params.handle, signal, grant.grantId);
    }
    throw new VaultServiceError('INVALID_ARGUMENT', 'unsupported vault action');
  }

  /** The current page, refused here when its origin is not a supported site. */
  private async inspectSupportedSite(tabId: number, sessionId: string, signal?: AbortSignal): Promise<VaultInspection> {
    const inspection = await this.inspect(tabId, sessionId, signal);
    this.assertOrigin(inspection.origin);
    return inspection;
  }

  /** Opens the private-page request this inspection needs and reports it to the caller. */
  private async requestForInspection(
    context: VaultBrowserContext,
    sessionId: string,
    tabId: number,
    inspection: VaultInspection,
    purpose: VaultPrivateRequest['purpose'],
    extra: { credentialId?: string; label?: string } = {},
  ): Promise<Record<string, unknown>> {
    const request = await this.beginRequest(context, {
      purpose,
      sessionId,
      tabId,
      documentId: inspection.documentId,
      origin: inspection.origin,
      ...extra,
    });
    return this.requestRequired(request, inspection.origin);
  }

  protected async fillGranted(
    context: VaultBrowserContext,
    sessionId: string,
    tabId: number,
    initial: VaultInspection,
    handle: string,
    signal?: AbortSignal,
    grantId?: string,
  ): Promise<Record<string, unknown>> {
    const scope = scopeForBrowser(context.browserId);
    const store = this.storeFor(context.browserId);
    const operationId = randomId('fillop');
    const oneShotGrant = grantId ? this.grants.get(grantId) : undefined;
    if (oneShotGrant?.oneShot) {
      if (oneShotGrant.consumed || oneShotGrant.claimedBy) return publicError('VAULT_PERMISSION_DENIED');
      oneShotGrant.claimedBy = operationId;
    }
    const operation = this.trackOperation(operationId, {
      scope,
      sessionId,
      connectionId: context.connectionId,
      ...(grantId ? { grantId } : {}),
      credentialId: handle,
    }, signal);
    const operationTimeout = setTimeout(() => operation.controller.abort(), VAULT_FILL_OPERATION_TIMEOUT_MS);
    const fillSignal = operation.controller.signal;
    try {
      if (grantId && !await this.grantStillUsable(grantId, context, sessionId, initial.origin, handle, fillSignal, operationId)) return publicError('VAULT_PERMISSION_DENIED');
      if (!store.isUnlocked) return publicError('VAULT_LOCKED', { origin: initial.origin });
      if (!initial.suitable) return publicError('VAULT_TARGET_UNSAFE', { origin: initial.origin });
      // Recheck before decrypting. The extension performs the final origin,
      // document, nonce and element-identity checks immediately before writing.
      const inspection = await this.inspect(tabId, sessionId, fillSignal);
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
      this.redaction.register(scope, entry.password, inspection.documentId);
      this.markProtected(scope, { tabId, documentId: inspection.documentId, origin: inspection.origin, state: 'active', current: true });
      const result = await this.transport.callVaultAction('fill', {
        tabId,
        origin: inspection.origin,
        documentId: inspection.documentId,
        targetDocumentId: inspection.targetDocumentId,
        frameId: inspection.frameId,
        nonce: inspection.nonce,
        password: entry.password,
      }, sessionId, fillSignal, context.agentName);
      if (fillSignal.aborted || !isRecord(result) || result.success !== true || result.filled_fields !== 1) {
        this.markProtected(scope, { tabId, documentId: inspection.documentId, origin: inspection.origin, state: 'recovery_required', current: true });
        return publicError('VAULT_OUTCOME_UNKNOWN', { origin: inspection.origin });
      }
      await this.writeAudit(store, 'fill', handle, sessionId, inspection.origin, 'success');
      if (fillSignal.aborted) {
        this.markProtected(scope, { tabId, documentId: inspection.documentId, origin: inspection.origin, state: 'recovery_required', current: true });
        return publicError('VAULT_OUTCOME_UNKNOWN', { origin: inspection.origin });
      }
      return { success: true, status: 'filled', filled_fields: 1, origin: inspection.origin };
    } catch {
      this.markProtected(scope, { tabId, documentId: initial.documentId, origin: initial.origin, state: 'recovery_required', current: true });
      await this.writeAudit(store, 'fill', handle, sessionId, initial.origin, 'failed').catch(() => {});
      return publicError('VAULT_OUTCOME_UNKNOWN', { origin: initial.origin });
    } finally {
      clearTimeout(operationTimeout);
      if (oneShotGrant?.oneShot) {
        oneShotGrant.consumed = true;
        oneShotGrant.claimedBy = undefined;
        this.grants.delete(oneShotGrant.grantId);
      }
      this.completeOperation(operationId);
    }
  }

  private async grantStillUsable(
    grantId: string,
    context: VaultBrowserContext,
    sessionId: string,
    origin: string,
    handle: string,
    signal?: AbortSignal,
    operationId?: string,
  ): Promise<boolean> {
    if (signal?.aborted || !this.isSessionLive(sessionId)) return false;
    const grant = this.grants.get(grantId);
    if (!grant || grant.revoked || grant.expiresAt <= this.now() || grant.sessionId !== sessionId
      || grant.browserScope !== scopeForBrowser(context.browserId) || grant.connectionId !== context.connectionId
      || grant.origin !== origin || (grant.credentialId && grant.credentialId !== handle)) return false;
    if (grant.oneShot && (grant.consumed || grant.claimedBy !== operationId)) return false;
    try {
      const current = await this.transport.getBrowserContext(sessionId);
      return current.supportsVault && !current.ambiguous && current.browserId === context.browserId
        && current.connectionId === context.connectionId;
    } catch {
      return false;
    }
  }
}
