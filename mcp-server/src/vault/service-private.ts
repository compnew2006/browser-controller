import { CredentialVaultStore, scopeForBrowser } from './store.js';
import { canonicalizeOrigin, metadataOf, VaultCredentialSchema, type VaultCredential } from './types.js';
import {
  VaultServiceError, randomId, isRecord, publicError, requireStrictKeys, safeCode,
  type PrivateConnection, type InternalPending, type VaultBrowserContext, type VaultPrivateRequest,
} from './service-common.js';
import { VaultServiceCore } from './service-core.js';

export abstract class VaultServicePrivate extends VaultServiceCore {
  async handlePrivateUi(connection: PrivateConnection, payload: unknown): Promise<Record<string, unknown>> {
    this.expireRequests();
    if (!isRecord(payload) || typeof payload.operation !== 'string') return publicError('INVALID_ARGUMENT');
    const operation = payload.operation;
    const requestId = typeof payload.requestId === 'string' ? payload.requestId : undefined;
    const operationBefore = requestId ? this.operations.get(requestId) : undefined;
    try {
      switch (operation) {
        case 'getState':
          requireStrictKeys(payload, ['operation', 'requestId']);
          return await this.privateState(connection, payload.requestId);
        case 'unlock':
          requireStrictKeys(payload, ['operation', 'requestId']);
          return await this.privateUnlock(connection, payload.requestId);
        case 'lock':
          requireStrictKeys(payload, ['operation']);
          return await this.privateLock(connection);
        case 'save':
          requireStrictKeys(payload, ['operation', 'requestId', 'origin', 'handle', 'label', 'identifier', 'password', 'allowSession', 'saveAndFill']);
          return await this.privateSave(connection, payload);
        case 'approve':
          requireStrictKeys(payload, ['operation', 'requestId', 'credentialId', 'purpose']);
          return await this.privateApprove(connection, payload);
        case 'decline':
        case 'cancel':
          requireStrictKeys(payload, ['operation', 'requestId']);
          return this.finishRequest(connection, payload.requestId, operation === 'decline' ? 'declined' : 'cancelled');
        case 'remove':
          requireStrictKeys(payload, ['operation', 'handle']);
          return await this.privateRemove(connection, payload.handle);
        case 'revoke':
          requireStrictKeys(payload, ['operation', 'grantId']);
          return await this.privateRevoke(connection, payload.grantId);
        case 'backup':
          requireStrictKeys(payload, ['operation']);
          return await this.privateBackup(connection);
        case 'listBackups':
          requireStrictKeys(payload, ['operation']);
          return await this.privateListBackups(connection);
        case 'restore':
          requireStrictKeys(payload, ['operation', 'backupId']);
          return await this.privateRestore(connection, payload.backupId);
        default:
          return publicError('INVALID_ARGUMENT');
      }
    } catch (error) {
      const pending = requestId ? this.pendingForConnection(connection, requestId) : undefined;
      if (pending?.request.state === 'processing') {
        pending.request = { ...pending.request, state: 'failed' };
        pending.terminalAt = this.now();
      }
      const code = safeCode(error);
      return publicError(code);
    } finally {
      if (requestId && this.operations.get(requestId) !== operationBefore) this.completeOperation(requestId);
    }
  }

  /** Re-reads the live browser identity and refuses a request that crossed connections. */
  private async assertInitiator(connection: PrivateConnection, sessionId: string): Promise<VaultBrowserContext> {
    const current = await this.contextForSession(sessionId);
    if (current.browserId !== connection.browserId || current.connectionId !== connection.connectionId) {
      throw new VaultServiceError('VAULT_PERMISSION_DENIED', 'the initiating browser identity changed');
    }
    return current;
  }

  private async privateState(connection: PrivateConnection, requestId: unknown): Promise<Record<string, unknown>> {
    const scope = scopeForBrowser(connection.browserId);
    const store = this.storeFor(connection.browserId);
    const storeState = await store.status();
    const unlocked = store.isUnlocked;
    const entries = unlocked ? await store.list() : [];
    const requests = [...this.requests.values()]
      .filter((item) => item.request.browserScope === scope && item.connectionId === connection.connectionId
        && ['pending', 'processing'].includes(item.request.state))
      .sort((left, right) => left.request.createdAt - right.request.createdAt)
      .map((item) => this.safeRequestView(item, entries));
    const request = typeof requestId === 'string' ? this.requests.get(requestId) : undefined;
    if (request && (request.request.browserScope !== scope || request.connectionId !== connection.connectionId)) return publicError('VAULT_PERMISSION_DENIED');
    return {
      success: true,
      status: storeState === 'ready' ? (unlocked ? 'ready' : 'locked') : storeState,
      browserLabel: connection.browserLabel,
      entries: entries.map(metadataOf),
      requests,
      grants: [...this.grants.values()].filter((grant) => grant.browserScope === scope && grant.connectionId === connection.connectionId && !grant.revoked).map((grant) => ({
        grantId: grant.grantId,
        sessionLabel: `${this.sessionAgentNames.get(grant.sessionId) ?? 'Connected session'} · session ${grant.sessionId.slice(-7)}`,
        origin: grant.origin,
        purpose: grant.purpose,
        ...(grant.oneShot ? { oneShot: true } : {}),
        ...(grant.credentialId ? { handle: grant.credentialId } : {}),
      })),
      ...(request ? { request: this.safeRequestView(request, entries) } : {}),
      autoSubmitWarning: 'A site can submit a form in response to input events. The vault does not click Submit.',
    };
  }

  private safeRequestView(pending: InternalPending, entries: VaultCredential[]): Record<string, unknown> {
    const request = pending.request;
    const matching = request.credentialId ? entries.find((entry) => entry.id === request.credentialId) : undefined;
    return {
      requestId: request.requestId,
      purpose: request.purpose,
      state: request.state,
      browserLabel: pending.browserLabel,
      sessionLabel: `${pending.agentName} · session ${request.sessionId.slice(-7)}`,
      ...(request.origin ? { origin: request.origin } : {}),
      ...(request.tabId !== undefined ? { tabId: request.tabId } : {}),
      ...(request.credentialId ? { handle: request.credentialId } : {}),
      ...(matching ? { account: metadataOf(matching) } : {}),
      expiresAt: request.expiresAt,
      requiresDocumentRecheck: request.tabId !== undefined,
    };
  }

  private async privateUnlock(connection: PrivateConnection, requestId: unknown): Promise<Record<string, unknown>> {
    const scope = scopeForBrowser(connection.browserId);
    const pending = requestId === undefined ? undefined : this.pendingForConnection(connection, requestId);
    if (requestId !== undefined && !pending) return publicError('VAULT_PERMISSION_DENIED');
    if (pending && !['unlock', 'fill', 'save', 'approve'].includes(pending.request.purpose)) return publicError('VAULT_PERMISSION_DENIED');
    if (pending?.request.purpose === 'unlock' && !this.claimPending(pending)) return this.requestState(pending);
    if (pending && pending.request.purpose !== 'unlock' && !this.revalidatePending(pending)) {
      pending.request = { ...pending.request, state: 'cancelled' };
      pending.terminalAt = this.now();
      return this.requestState(pending);
    }
    if (pending && pending.request.purpose !== 'unlock' && pending.request.state !== 'pending') return this.requestState(pending);
    const store = this.storeFor(connection.browserId);
    const state = await store.status();
    if (state === 'incomplete') throw new VaultServiceError('VAULT_RECOVERY_REQUIRED', 'the vault files are incomplete');
    if (state === 'empty') await store.initialize();
    else if (!store.isUnlocked) await store.unlock();
    const audit = this.auditEvent('unlock', scope, pending?.request.sessionId, pending?.request.origin, 'success');
    await store.audit(audit);
    if (pending?.request.purpose === 'unlock') {
      pending.request = { ...pending.request, state: 'accepted' };
      pending.terminalAt = this.now();
      return this.requestState(pending);
    }
    if (pending && !this.revalidatePending(pending)) {
      pending.request = { ...pending.request, state: 'cancelled' };
      pending.terminalAt = this.now();
      return this.requestState(pending);
    }
    if (pending) return { success: true, status: 'unlocked', requestId: pending.request.requestId };
    return { success: true, status: 'unlocked' };
  }

  private async privateLock(connection: PrivateConnection): Promise<Record<string, unknown>> {
    const scope = scopeForBrowser(connection.browserId);
    for (const [id, grant] of this.grants) if (grant.browserScope === scope) this.grants.delete(id);
    await this.cancelScopeOperations(scope);
    const store = this.storeFor(connection.browserId);
    if (store.isUnlocked) void this.writeAudit(store, 'lock', undefined, undefined, undefined, 'success').catch(() => {});
    store.lock();
    return { success: true, status: 'locked' };
  }

  private async privateSave(connection: PrivateConnection, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const pending = payload.requestId === undefined ? undefined : this.pendingForConnection(connection, payload.requestId);
    if (payload.requestId !== undefined && !pending) return publicError('VAULT_PERMISSION_DENIED');
    if (pending && pending.request.purpose !== 'save') return publicError('VAULT_PERMISSION_DENIED');
    if (pending && !this.claimPending(pending)) return this.requestState(pending);
    const store = this.storeFor(connection.browserId);
    await this.ensureUiUnlocked(store);
    if (pending && pending.request.state !== 'processing') return this.requestState(pending);
    const existingId = typeof payload.handle === 'string' ? payload.handle : undefined;
    const existing = existingId ? await store.get(existingId) : null;
    if (existingId && !existing) throw new VaultServiceError('INVALID_ARGUMENT', 'account handle was not found');
    const origin = pending?.request.origin ?? canonicalizeOrigin(typeof payload.origin === 'string' ? payload.origin : '');
    if (existing && existing.origin !== origin) throw new VaultServiceError('VAULT_ORIGIN_MISMATCH', 'an account cannot be moved to a different origin');
    if (pending && pending.request.origin !== origin) throw new VaultServiceError('VAULT_ORIGIN_MISMATCH', 'the save request is bound to a different origin');
    const identifier = typeof payload.identifier === 'string' ? payload.identifier : '';
    const password = typeof payload.password === 'string' ? payload.password : '';
    const label = typeof payload.label === 'string' && payload.label.trim() ? payload.label.trim() : identifier;
    const entry = VaultCredentialSchema.safeParse({
      id: existing?.id ?? randomId('cred'),
      kind: 'login',
      label,
      identifier,
      password,
      origin,
      createdAt: existing?.createdAt ?? this.now(),
      updatedAt: this.now(),
    });
    if (!entry.success) throw new VaultServiceError('INVALID_ARGUMENT', 'account fields are invalid');
    const sessionId = pending?.request.sessionId;
    const allowSession = payload.allowSession === true;
    const saveAndFill = payload.saveAndFill === true;
    if (saveAndFill && !allowSession) throw new VaultServiceError('VAULT_PERMISSION_DENIED', 'Save and fill requires explicit session access consent');
    if ((allowSession || saveAndFill) && (!pending || !sessionId)) throw new VaultServiceError('VAULT_PERMISSION_DENIED', 'session grants require a live private request');
    if (pending && !this.revalidatePending(pending)) throw new VaultServiceError('VAULT_REQUEST_EXPIRED', 'the initiating browser session ended');
    if (pending) await this.revalidateDocument(pending, connection);
    if (pending && pending.request.state !== 'processing') return this.requestState(pending);
    if (pending && !this.revalidatePending(pending)) throw new VaultServiceError('VAULT_REQUEST_EXPIRED', 'the initiating browser session ended');
    await store.upsert(entry.data);
    if (pending && pending.request.state !== 'processing') return this.requestState(pending);
    await this.writeAudit(store, existing ? 'update' : 'create', entry.data.id, sessionId, origin, 'success');
    if (pending && pending.request.state !== 'processing') return this.requestState(pending);
    if (allowSession || saveAndFill) {
      const grant = this.createGrant(connection, sessionId!, origin, 'fill', entry.data.id);
      await store.audit(this.auditEvent('grant', scopeForBrowser(connection.browserId), sessionId, origin, 'success', entry.data.id));
      if (pending) pending.metadata = { label: entry.data.label, identifier: entry.data.identifier };
      if (saveAndFill && pending) {
        if (pending.request.state !== 'processing' || !this.isSessionLive(sessionId!)) return this.requestState(pending);
        const current = await this.assertInitiator(connection, sessionId!);
        const initial = await this.inspect(pending.request.tabId!, sessionId!);
        if (initial.origin !== origin || initial.documentId !== pending.request.documentId) throw new VaultServiceError('VAULT_DOCUMENT_CHANGED', 'the page changed while the private form was open');
        const result = await this.fillGranted(current, sessionId!, pending.request.tabId!, initial, entry.data.id, this.operationSignal(pending), grant.grantId);
        if (pending.request.state === 'processing') pending.request = { ...pending.request, state: isRecord(result) && result.status === 'filled' ? 'accepted' : 'failed' };
        pending.terminalAt = this.now();
        return { success: pending.request.state === 'accepted', status: pending.request.state, requestId: pending.request.requestId, grantId: grant.grantId };
      }
    }
    if (pending && pending.request.state === 'processing') {
      pending.request = { ...pending.request, state: 'accepted' };
      pending.terminalAt = this.now();
    }
    if (pending && pending.request.state !== 'accepted') return this.requestState(pending);
    return { success: true, status: 'saved', handle: entry.data.id, origin };
  }

  private async privateApprove(connection: PrivateConnection, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const pending = this.pendingForConnection(connection, payload.requestId);
    if (!pending || pending.request.purpose !== 'approve' && pending.request.purpose !== 'fill') return publicError('VAULT_PERMISSION_DENIED');
    if (!this.claimPending(pending)) return this.requestState(pending);
    if (!this.revalidatePending(pending)) throw new VaultServiceError('VAULT_REQUEST_EXPIRED', 'the initiating browser session ended');
    await this.revalidateDocument(pending, connection);
    const store = this.storeFor(connection.browserId);
    await this.ensureUiUnlocked(store);
    const handle = pending.request.credentialId ?? (typeof payload.credentialId === 'string' ? payload.credentialId : undefined);
    if (pending.request.credentialId && handle !== pending.request.credentialId) throw new VaultServiceError('VAULT_PERMISSION_DENIED', 'the requested account cannot be changed');
    const purpose = payload.purpose === 'list' ? 'list' : 'fill';
    if (pending.request.purpose === 'approve' && purpose !== 'list') {
      throw new VaultServiceError('VAULT_PERMISSION_DENIED', 'an account-list request only accepts account-list consent');
    }
    if (purpose === 'fill' && !handle) throw new VaultServiceError('INVALID_ARGUMENT', 'choose a saved account before granting fill access');
    if (pending.request.purpose === 'fill' && (purpose !== 'fill' || handle !== pending.request.credentialId)) {
      throw new VaultServiceError('VAULT_PERMISSION_DENIED', 'this request only permits the selected account');
    }
    const entry = handle ? await store.get(handle) : null;
    if (handle && (!entry || entry.origin !== pending.request.origin)) throw new VaultServiceError('VAULT_ORIGIN_MISMATCH', 'the selected account does not match this site');
    if (pending.request.state !== 'processing' || !this.revalidatePending(pending)) return this.requestState(pending);
    if (pending.request.purpose === 'fill') {
      const initial = await this.inspect(pending.request.tabId!, pending.request.sessionId);
      if (initial.origin !== pending.request.origin || initial.documentId !== pending.request.documentId) throw new VaultServiceError('VAULT_DOCUMENT_CHANGED', 'the page changed while the private request was open');
      const current = await this.assertInitiator(connection, pending.request.sessionId);
      if (pending.request.state !== 'processing' || !this.revalidatePending(pending)) return this.requestState(pending);
      const grant = this.createGrant(connection, pending.request.sessionId, pending.request.origin!, purpose, handle, purpose === 'fill');
      await store.audit(this.auditEvent('grant', pending.request.browserScope, pending.request.sessionId, pending.request.origin, 'success', handle));
      const result = await this.fillGranted(current, pending.request.sessionId, pending.request.tabId!, initial, handle!, this.operationSignal(pending), grant.grantId);
      if (pending.request.state === 'processing') pending.request = { ...pending.request, state: isRecord(result) && result.status === 'filled' ? 'accepted' : 'failed' };
      pending.terminalAt = this.now();
      return { ...result, requestId: pending.request.requestId, grantId: grant.grantId };
    }
    if (pending.request.state !== 'processing' || !this.revalidatePending(pending)) return this.requestState(pending);
    const current = await this.assertInitiator(connection, pending.request.sessionId);
    const grant = this.createGrant(connection, pending.request.sessionId, pending.request.origin!, purpose, handle, purpose === 'fill');
    await store.audit(this.auditEvent('grant', pending.request.browserScope, pending.request.sessionId, pending.request.origin, 'success', handle));
    if (pending.request.state !== 'processing') return this.requestState(pending);
    pending.request = { ...pending.request, state: 'accepted' };
    pending.terminalAt = this.now();
    return { success: true, status: 'approved', requestId: pending.request.requestId, grantId: grant.grantId };
  }

  private finishRequest(connection: PrivateConnection, requestId: unknown, state: 'declined' | 'cancelled'): Record<string, unknown> {
    const pending = this.pendingForConnection(connection, requestId);
    if (!pending) return publicError('VAULT_PERMISSION_DENIED');
    if (pending.request.state === 'processing') this.operations.get(pending.request.requestId)?.controller.abort();
    if (!['pending', 'processing'].includes(pending.request.state)) return this.requestState(pending);
    pending.request = { ...pending.request, state };
    pending.terminalAt = this.now();
    return this.requestState(pending);
  }

  private async privateRemove(connection: PrivateConnection, handle: unknown): Promise<Record<string, unknown>> {
    if (typeof handle !== 'string') return publicError('INVALID_ARGUMENT');
    await this.cancelCredentialOperations(scopeForBrowser(connection.browserId), handle);
    const store = this.storeFor(connection.browserId);
    if (!store.isUnlocked) return publicError('VAULT_LOCKED');
    const removed = await store.remove(handle);
    for (const [id, grant] of this.grants) if (grant.browserScope === scopeForBrowser(connection.browserId) && grant.credentialId === handle) this.grants.delete(id);
    if (removed) await this.writeAudit(store, 'delete', handle, undefined, undefined, 'success');
    return { success: true, status: removed ? 'deleted' : 'not_found' };
  }

  private async privateRevoke(connection: PrivateConnection, grantId: unknown): Promise<Record<string, unknown>> {
    if (typeof grantId !== 'string') return publicError('INVALID_ARGUMENT');
    const grant = this.grants.get(grantId);
    if (!grant || grant.browserScope !== scopeForBrowser(connection.browserId) || grant.connectionId !== connection.connectionId) return publicError('VAULT_PERMISSION_DENIED');
    this.grants.delete(grantId);
    await this.cancelGrantOperations(grantId);
    for (const pending of this.requests.values()) {
      if (pending.request.sessionId === grant.sessionId && pending.request.credentialId === grant.credentialId
        && pending.request.browserScope === grant.browserScope && pending.request.state === 'processing') {
        this.operations.get(pending.request.requestId)?.controller.abort();
      }
    }
    const store = this.storeFor(connection.browserId);
    if (store.isUnlocked) await store.audit(this.auditEvent('revoke', grant.browserScope, grant.sessionId, grant.origin, 'success', grant.credentialId));
    return { success: true, status: 'revoked' };
  }

  private async privateBackup(connection: PrivateConnection): Promise<Record<string, unknown>> {
    const store = this.storeFor(connection.browserId);
    if (!store.isUnlocked) return publicError('VAULT_LOCKED');
    const backup = await store.createBackup(this.now());
    await this.writeAudit(store, 'backup', undefined, undefined, undefined, 'success');
    return { success: true, status: 'backed_up', backupId: backup.id, createdAt: backup.createdAt };
  }

  private async privateListBackups(connection: PrivateConnection): Promise<Record<string, unknown>> {
    return { success: true, backups: await this.storeFor(connection.browserId).listBackups() };
  }

  private async privateRestore(connection: PrivateConnection, backupId: unknown): Promise<Record<string, unknown>> {
    if (typeof backupId !== 'string') return publicError('INVALID_ARGUMENT');
    const scope = scopeForBrowser(connection.browserId);
    await this.cancelScopeOperations(scope);
    for (const [id, grant] of this.grants) if (grant.browserScope === scope) this.grants.delete(id);
    const store = this.storeFor(connection.browserId);
    await store.restoreBackup(backupId, this.now());
    return { success: true, status: 'restored' };
  }
}
