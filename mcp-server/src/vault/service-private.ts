import { CredentialVaultStore, scopeForBrowser } from './store.js';
import { canonicalizeOrigin, metadataOf, randomId, VaultCredentialSchema, type VaultCredential } from './types.js';
import {
  VaultServiceError, isRecord, publicError, requireStrictKeys, safeCode,
  type PrivateConnection, type InternalPending, type VaultBrowserContext, type VaultPrivateRequest,
} from './service-common.js';
import { VaultServiceCore } from './service-core.js';

/** What the owner chose on an approval card. */
type CardChoice = 'allow' | 'deny' | 'page' | 'cancel';

/** The request state read fresh: `settle` and `claim` change it behind TypeScript's narrowing. */
function stateOf(pending: InternalPending): VaultPrivateRequest['state'] {
  return pending.request.state;
}

export abstract class VaultServicePrivate extends VaultServiceCore {
  async handlePrivateUi(connection: PrivateConnection, payload: unknown): Promise<Record<string, unknown>> {
    this.requests.expire();
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
        case 'cardDecision':
          requireStrictKeys(payload, ['operation', 'requestId', 'decision', 'always']);
          return await this.cardDecision(connection, payload);
        case 'allowlistAdd':
          requireStrictKeys(payload, ['operation', 'origin']);
          return await this.privateAllowlistAdd(connection, payload.origin);
        case 'allowlistRemove':
          requireStrictKeys(payload, ['operation', 'origin']);
          return await this.privateAllowlistRemove(connection, payload.origin);
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
      const pending = requestId ? this.requests.forConnection(connection, requestId) : undefined;
      if (pending?.request.state === 'processing') this.requests.settle(pending, 'failed');
      const code = safeCode(error);
      return publicError(code);
    } finally {
      if (requestId && this.operations.get(requestId) !== operationBefore) this.operations.complete(requestId);
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
    const requests = this.requests.activeFor(scope, connection.connectionId)
      .map((item) => this.safeRequestView(item, entries));
    const request = typeof requestId === 'string' ? this.requests.get(requestId) : undefined;
    if (request && (request.request.browserScope !== scope || request.connectionId !== connection.connectionId)) return publicError('VAULT_PERMISSION_DENIED');
    const allowlist = unlocked ? await store.allowlist() : [];
    return {
      success: true,
      status: storeState === 'ready' ? (unlocked ? 'ready' : 'locked') : storeState,
      browserLabel: connection.browserLabel,
      entries: entries.map(metadataOf),
      requests,
      grants: [
        ...this.grants.activeSitesFor(scope).map((grant) => ({
          grantId: grant.grantId,
          sessionLabel: 'Every agent session',
          origin: grant.origin,
          purpose: 'site',
          via: grant.via,
        })),
        ...this.grants.activeFor(scope, connection.connectionId).map((grant) => ({
          grantId: grant.grantId,
          sessionLabel: `${this.sessionAgentNames.get(grant.sessionId) ?? 'Connected session'} · session ${grant.sessionId.slice(-7)}`,
          origin: grant.origin,
          purpose: grant.purpose,
          ...(grant.oneShot ? { oneShot: true } : {}),
          ...(grant.credentialId ? { handle: grant.credentialId } : {}),
        })),
      ],
      allowlist,
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
      ...(pending.surface === 'card' ? { onCard: true } : {}),
    };
  }

  private async privateUnlock(connection: PrivateConnection, requestId: unknown): Promise<Record<string, unknown>> {
    const scope = scopeForBrowser(connection.browserId);
    const pending = requestId === undefined ? undefined : this.requests.forConnection(connection, requestId);
    if (requestId !== undefined && !pending) return publicError('VAULT_PERMISSION_DENIED');
    if (pending && !['unlock', 'fill', 'save', 'approve'].includes(pending.request.purpose)) return publicError('VAULT_PERMISSION_DENIED');
    if (pending?.request.purpose === 'unlock' && !this.requests.claim(pending)) return this.requestState(pending);
    if (pending && pending.request.purpose !== 'unlock' && !this.requests.revalidate(pending)) {
      this.requests.settle(pending, 'cancelled');
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
      this.requests.settle(pending, 'accepted');
      return this.requestState(pending);
    }
    if (pending && !this.requests.revalidate(pending)) {
      this.requests.settle(pending, 'cancelled');
      return this.requestState(pending);
    }
    if (pending) return { success: true, status: 'unlocked', requestId: pending.request.requestId };
    return { success: true, status: 'unlocked' };
  }

  private async privateLock(connection: PrivateConnection): Promise<Record<string, unknown>> {
    const scope = scopeForBrowser(connection.browserId);
    this.grants.revokeScope(scope);
    await this.cancelScopeOperations(scope);
    const store = this.storeFor(connection.browserId);
    if (store.isUnlocked) void this.writeAudit(store, 'lock', undefined, undefined, undefined, 'success').catch(() => {});
    store.lock();
    return { success: true, status: 'locked' };
  }

  private async privateSave(connection: PrivateConnection, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const pending = payload.requestId === undefined ? undefined : this.requests.forConnection(connection, payload.requestId);
    if (payload.requestId !== undefined && !pending) return publicError('VAULT_PERMISSION_DENIED');
    if (pending && pending.request.purpose !== 'save') return publicError('VAULT_PERMISSION_DENIED');
    if (pending && !this.requests.claim(pending)) return this.requestState(pending);
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
    if (pending && !this.requests.revalidate(pending)) throw new VaultServiceError('VAULT_REQUEST_EXPIRED', 'the initiating browser session ended');
    if (pending) await this.revalidateDocument(pending, connection);
    if (pending && pending.request.state !== 'processing') return this.requestState(pending);
    if (pending && !this.requests.revalidate(pending)) throw new VaultServiceError('VAULT_REQUEST_EXPIRED', 'the initiating browser session ended');
    await store.upsert(entry.data);
    if (pending && pending.request.state !== 'processing') return this.requestState(pending);
    await this.writeAudit(store, existing ? 'update' : 'create', entry.data.id, sessionId, origin, 'success');
    if (pending && pending.request.state !== 'processing') return this.requestState(pending);
    if (allowSession || saveAndFill) {
      // "Allow" approves the site for this browser profile, as every approval does (specs/006 D3).
      const grant = this.grants.createSite(scopeForBrowser(connection.browserId), origin, 'page');
      await store.audit(this.auditEvent('grant', scopeForBrowser(connection.browserId), sessionId, origin, 'success', entry.data.id));
      this.settleSite(scopeForBrowser(connection.browserId), origin, 'accepted');
      if (pending) pending.metadata = { label: entry.data.label, identifier: entry.data.identifier };
      if (saveAndFill && pending) {
        if (pending.request.state !== 'processing' || !this.isSessionLive(sessionId!)) return this.requestState(pending);
        const current = await this.assertInitiator(connection, sessionId!);
        const initial = await this.inspect(pending.request.tabId!, sessionId!);
        if (initial.origin !== origin || initial.documentId !== pending.request.documentId) throw new VaultServiceError('VAULT_DOCUMENT_CHANGED', 'the page changed while the private form was open');
        const result = await this.fill.run(current, sessionId!, pending.request.tabId!, initial, entry.data.id, this.operations.signalFor(pending.request.requestId), grant.grantId);
        if (pending.request.state === 'processing') this.requests.settle(pending, isRecord(result) && result.status === 'filled' ? 'accepted' : 'failed');
        else pending.terminalAt = this.now();
        return { success: stateOf(pending) === 'accepted', status: stateOf(pending), requestId: pending.request.requestId, grantId: grant.grantId };
      }
    }
    if (pending && pending.request.state === 'processing') {
      this.requests.settle(pending, 'accepted');
    }
    if (pending && pending.request.state !== 'accepted') return this.requestState(pending);
    return { success: true, status: 'saved', handle: entry.data.id, origin };
  }

  private async privateApprove(connection: PrivateConnection, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const pending = this.requests.forConnection(connection, payload.requestId);
    if (!pending || pending.request.purpose !== 'approve' && pending.request.purpose !== 'fill') return publicError('VAULT_PERMISSION_DENIED');
    if (!this.requests.claim(pending)) return this.requestState(pending);
    if (!this.requests.revalidate(pending)) throw new VaultServiceError('VAULT_REQUEST_EXPIRED', 'the initiating browser session ended');
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
    if (pending.request.state !== 'processing' || !this.requests.revalidate(pending)) return this.requestState(pending);
    // Every approval approves the site for this browser profile (specs/006 D3): listing and filling
    // its accounts for any session, until the vault locks or the owner revokes it.
    if (pending.request.purpose === 'fill') {
      const initial = await this.inspect(pending.request.tabId!, pending.request.sessionId);
      if (initial.origin !== pending.request.origin || initial.documentId !== pending.request.documentId) throw new VaultServiceError('VAULT_DOCUMENT_CHANGED', 'the page changed while the private request was open');
      const current = await this.assertInitiator(connection, pending.request.sessionId);
      if (pending.request.state !== 'processing' || !this.requests.revalidate(pending)) return this.requestState(pending);
      const grant = this.grants.createSite(pending.request.browserScope, pending.request.origin!, 'page');
      await store.audit(this.auditEvent('grant', pending.request.browserScope, pending.request.sessionId, pending.request.origin, 'success', handle));
      this.settleSite(pending.request.browserScope, pending.request.origin!, 'accepted', pending);
      const result = await this.fill.run(current, pending.request.sessionId, pending.request.tabId!, initial, handle!, this.operations.signalFor(pending.request.requestId), grant.grantId);
      // A call still waiting on this request returns this fill instead of filling a second time.
      pending.outcome = { ...result, requestId: pending.request.requestId };
      if (pending.request.state === 'processing') this.requests.settle(pending, isRecord(result) && result.status === 'filled' ? 'accepted' : 'failed');
      else pending.terminalAt = this.now();
      return { ...result, requestId: pending.request.requestId, grantId: grant.grantId };
    }
    if (pending.request.state !== 'processing' || !this.requests.revalidate(pending)) return this.requestState(pending);
    await this.assertInitiator(connection, pending.request.sessionId);
    const grant = this.grants.createSite(pending.request.browserScope, pending.request.origin!, 'page');
    await store.audit(this.auditEvent('grant', pending.request.browserScope, pending.request.sessionId, pending.request.origin, 'success', handle));
    if (pending.request.state !== 'processing') return this.requestState(pending);
    this.requests.settle(pending, 'accepted');
    this.settleSite(pending.request.browserScope, pending.request.origin!, 'accepted', pending);
    return { success: true, status: 'approved', requestId: pending.request.requestId, grantId: grant.grantId };
  }

  /** One site decision settles every other waiting approval or fill request for that profile and site (specs/006 FR-007). */
  private settleSite(scope: string, origin: string, state: 'accepted' | 'declined', except?: InternalPending): void {
    for (const item of this.requests.liveForSite(scope, origin)) {
      if (item === except || item.request.state !== 'pending') continue;
      this.requests.settle(item, state);
    }
  }

  /**
   * The owner's decision on an in-page card (specs/006 D6). The background accepted it only from the
   * card's own content script on the card's tab and document; here it must match a live card
   * request on this connection. `page` moves the request to the private page, `cancel` ends the
   * card's requests, `deny` declines the site, and `allow` unlocks the vault when needed and
   * approves the site, and with `always` also allowlists it. A card held after its session ended,
   * also during this decision, takes the same decisions for the site and the requests that joined it.
   */
  private async cardDecision(connection: PrivateConnection, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const pending = this.requests.forConnection(connection, payload.requestId);
    if (!pending || pending.surface !== 'card' || !pending.request.origin) return publicError('VAULT_PERMISSION_DENIED');
    const lead = (pending.cardOf ? this.requests.get(pending.cardOf) : undefined) ?? pending;
    if (!['allow', 'deny', 'page', 'cancel'].includes(String(payload.decision)) || typeof payload.always !== 'boolean'
      || (payload.always && payload.decision !== 'allow')) {
      return publicError('INVALID_ARGUMENT');
    }
    const decision = payload.decision as CardChoice;
    const always = payload.always;
    if (this.requests.takeHeld(lead)) return await this.finishHeld(connection, lead, decision, always);
    if (stateOf(lead) === 'processing') return this.requestState(lead);
    // The card's request ended another way and its close may still be on the way: Allow and Deny are
    // refused, so the card does not go away as if they worked, and the extension opens the vault page itself.
    if (stateOf(lead) !== 'pending') return decision === 'cancel' ? this.requestState(lead) : publicError('VAULT_REQUEST_EXPIRED');
    const scope = lead.request.browserScope;
    const origin = lead.request.origin!;
    if (decision === 'page') {
      await this.requests.moveToPage(lead);
      return { success: true, status: 'moved', requestId: lead.request.requestId };
    }
    if (decision === 'cancel') {
      for (const item of this.requests.cardGroup(lead)) this.requests.settle(item, 'cancelled');
      return this.requestState(lead);
    }
    const store = this.storeFor(connection.browserId);
    if (decision === 'deny') {
      this.requests.settle(lead, 'declined');
      this.settleSite(scope, origin, 'declined', lead);
      if (store.isUnlocked) await store.audit(this.auditEvent('grant', scope, lead.request.sessionId, origin, 'denied'));
      return this.requestState(lead);
    }
    if (!this.requests.claim(lead)) return this.requestState(lead);
    try {
      if (!this.requests.revalidate(lead)) throw new VaultServiceError('VAULT_REQUEST_EXPIRED', 'the initiating browser session ended');
      await this.revalidateDocument(lead, connection);
    } catch (error) {
      // The asking session ended during the page check: its card is held, and the decision goes on for the site.
      if (this.requests.takeHeld(lead)) return await this.finishHeld(connection, lead, 'allow', always);
      throw error;
    }
    const wasLocked = !store.isUnlocked;
    await this.ensureUiUnlocked(store);
    if (wasLocked) await store.audit(this.auditEvent('unlock', scope, lead.request.sessionId, origin, 'success'));
    if (stateOf(lead) !== 'processing') {
      return this.requests.takeHeld(lead) ? await this.finishHeld(connection, lead, 'allow', always) : this.requestState(lead);
    }
    const grant = await this.approveSiteFromCard(store, scope, origin, lead.request.sessionId, always);
    if (stateOf(lead) === 'processing') this.requests.settle(lead, 'accepted');
    else if (this.requests.takeHeld(lead)) this.requests.endCard(lead);
    else return this.requestState(lead);
    this.settleSite(scope, origin, 'accepted', lead);
    return { success: true, status: 'approved', requestId: lead.request.requestId, grantId: grant.grantId };
  }

  /** A held card's decision, after which the card comes down. */
  private async finishHeld(connection: PrivateConnection, lead: InternalPending, decision: CardChoice, always: boolean): Promise<Record<string, unknown>> {
    try {
      return await this.heldCardDecision(connection, lead, decision, always);
    } finally {
      this.requests.endCard(lead);
    }
  }

  /**
   * A decision on a card held after its session ended (specs/006 edge cases). Its own request stays
   * cancelled; `allow` still approves the site and settles the requests that joined the card. No page
   * check runs through the ended session: the extension ends the card when its document goes away.
   */
  private async heldCardDecision(connection: PrivateConnection, lead: InternalPending, decision: CardChoice, always: boolean): Promise<Record<string, unknown>> {
    const scope = lead.request.browserScope;
    const origin = lead.request.origin!;
    const joined = this.requests.cardGroup(lead);
    if (decision === 'page') {
      // Nothing left to move: the extension opens the vault page itself.
      if (joined.length === 0) return publicError('VAULT_REQUEST_EXPIRED');
      await this.requests.moveToPage(joined[0]);
      return { success: true, status: 'moved', requestId: joined[0].request.requestId };
    }
    if (decision === 'cancel') {
      for (const item of joined) this.requests.settle(item, 'cancelled');
      return this.requestState(lead);
    }
    const store = this.storeFor(connection.browserId);
    if (decision === 'deny') {
      this.settleSite(scope, origin, 'declined', lead);
      if (store.isUnlocked) await store.audit(this.auditEvent('grant', scope, lead.request.sessionId, origin, 'denied'));
      return this.requestState(lead);
    }
    const wasLocked = !store.isUnlocked;
    await this.ensureUiUnlocked(store);
    if (wasLocked) await store.audit(this.auditEvent('unlock', scope, lead.request.sessionId, origin, 'success'));
    const grant = await this.approveSiteFromCard(store, scope, origin, lead.request.sessionId, always);
    this.settleSite(scope, origin, 'accepted', lead);
    return { success: true, status: 'approved', requestId: lead.request.requestId, grantId: grant.grantId };
  }

  /**
   * The site approval a card's Allow gives, audited. "Always" is listed before the approval exists, so a
   * full list fails the decision with nothing granted. An approval given with it comes from the list:
   * removing the site from the list ends it.
   */
  private async approveSiteFromCard(store: CredentialVaultStore, scope: string, origin: string, sessionId: string, always: boolean) {
    const listed = always && await store.allowlistAdd(origin, this.now());
    if (always) this.grants.unblockSite(scope, origin);
    const existing = this.grants.findSite(scope, origin);
    const grant = this.grants.createSite(scope, origin, always ? 'allowlist' : 'card');
    try {
      // One row for the decision: a second one for the list entry would carry the same fields.
      await store.audit(this.auditEvent('grant', scope, sessionId, origin, 'success'));
    } catch (error) {
      // An approval the owner is told failed must not stay live.
      if (!existing) this.grants.revoke(grant.grantId);
      if (listed) await store.allowlistRemove(origin).catch(() => false);
      throw error;
    }
    return grant;
  }

  /**
   * The site origin of an address typed by the owner (a bare host means HTTPS, or HTTP for a
   * loopback host, and a path is dropped), or null when it names no supported site or carries
   * credentials. Only `scheme://` counts as a scheme, so `localhost:3000` is a host and a port.
   */
  private allowlistOrigin(raw: unknown): string | null {
    if (typeof raw !== 'string' || !raw.trim() || raw.length > 2_048) return null;
    const typed = raw.trim();
    try {
      const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(typed);
      const url = new URL(withScheme ? typed : `https://${typed}`);
      if (!withScheme && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) url.protocol = 'http:';
      if (url.username || url.password) return null;
      return canonicalizeOrigin(url.origin);
    } catch { return null; }
  }

  private async privateAllowlistAdd(connection: PrivateConnection, raw: unknown): Promise<Record<string, unknown>> {
    const origin = this.allowlistOrigin(raw);
    if (!origin) return publicError('INVALID_ARGUMENT');
    const store = this.storeFor(connection.browserId);
    if (!store.isUnlocked) return publicError('VAULT_LOCKED');
    const added = await store.allowlistAdd(origin, this.now());
    this.grants.unblockSite(scopeForBrowser(connection.browserId), origin);
    if (added) await this.writeAudit(store, 'grant', undefined, undefined, origin, 'success');
    return { success: true, status: added ? 'added' : 'unchanged', origin };
  }

  private async privateAllowlistRemove(connection: PrivateConnection, raw: unknown): Promise<Record<string, unknown>> {
    const origin = this.allowlistOrigin(raw);
    if (!origin) return publicError('INVALID_ARGUMENT');
    const store = this.storeFor(connection.browserId);
    if (!store.isUnlocked) return publicError('VAULT_LOCKED');
    const { removed, revoked } = await this.endSite(store, scopeForBrowser(connection.browserId), origin);
    if (removed || revoked > 0) await this.writeAudit(store, 'revoke', undefined, undefined, origin, 'success');
    return { success: true, status: removed ? 'removed' : 'not_found', revoked, origin };
  }

  /**
   * The owner stops allowing a site in one profile: every approval of it ends, then it leaves the always-allowed
   * list. The approvals end in memory first and the list may not approve the site meanwhile, so a vault write that
   * fails leaves the site refused, not allowed; the error still reaches the owner.
   */
  private async endSite(store: CredentialVaultStore, scope: string, origin: string): Promise<{ removed: boolean; revoked: number }> {
    this.grants.blockSite(scope, origin);
    const revoked = this.grants.revokeSite(scope, origin);
    for (const grant of revoked) await this.cancelGrantOperations(grant.grantId);
    const removed = store.isUnlocked && await store.allowlistRemove(origin);
    this.grants.unblockSite(scope, origin);
    return { removed, revoked: revoked.length };
  }

  private finishRequest(connection: PrivateConnection, requestId: unknown, state: 'declined' | 'cancelled'): Record<string, unknown> {
    const pending = this.requests.forConnection(connection, requestId);
    if (!pending) return publicError('VAULT_PERMISSION_DENIED');
    if (pending.request.state === 'processing') this.operations.abort(pending.request.requestId);
    if (!['pending', 'processing'].includes(pending.request.state)) return this.requestState(pending);
    this.requests.settle(pending, state);
    return this.requestState(pending);
  }

  private async privateRemove(connection: PrivateConnection, handle: unknown): Promise<Record<string, unknown>> {
    if (typeof handle !== 'string') return publicError('INVALID_ARGUMENT');
    await this.cancelCredentialOperations(scopeForBrowser(connection.browserId), handle);
    const store = this.storeFor(connection.browserId);
    if (!store.isUnlocked) return publicError('VAULT_LOCKED');
    const removed = await store.remove(handle);
    this.grants.revokeCredential(scopeForBrowser(connection.browserId), handle);
    if (removed) await this.writeAudit(store, 'delete', handle, undefined, undefined, 'success');
    return { success: true, status: removed ? 'deleted' : 'not_found' };
  }

  private async privateRevoke(connection: PrivateConnection, grantId: unknown): Promise<Record<string, unknown>> {
    if (typeof grantId !== 'string') return publicError('INVALID_ARGUMENT');
    const site = this.grants.getSite(grantId);
    if (site) {
      if (site.browserScope !== scopeForBrowser(connection.browserId)) return publicError('VAULT_PERMISSION_DENIED');
      const store = this.storeFor(connection.browserId);
      // A site still on the always-allowed list would be approved again by the next list or fill: it leaves the list too.
      const { removed } = await this.endSite(store, site.browserScope, site.origin);
      if (store.isUnlocked) await store.audit(this.auditEvent('revoke', site.browserScope, undefined, site.origin, 'success'));
      return { success: true, status: 'revoked', unlisted: removed };
    }
    const grant = this.grants.get(grantId);
    if (!grant || grant.browserScope !== scopeForBrowser(connection.browserId) || grant.connectionId !== connection.connectionId) return publicError('VAULT_PERMISSION_DENIED');
    this.grants.revoke(grantId);
    await this.cancelGrantOperations(grantId);
    this.requests.abortWorkMatching((pending) => pending.request.sessionId === grant.sessionId
      && pending.request.credentialId === grant.credentialId
      && pending.request.browserScope === grant.browserScope && pending.request.state === 'processing');
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
    this.grants.revokeScope(scope);
    const store = this.storeFor(connection.browserId);
    await store.restoreBackup(backupId, this.now());
    return { success: true, status: 'restored' };
  }
}
