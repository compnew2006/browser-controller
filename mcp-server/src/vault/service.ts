import type { VaultPrivateRequest } from './types.js';
import { scopeForBrowser } from './store.js';
import {
  VAULT_CARD_WAIT_MS, VaultServiceError, containsCredentialSecret, metadataMarker, publicError, safePublicMetadataOf,
  type LiveGrant, type SiteGrant, type VaultBrowserContext, type VaultInspection,
} from './service-common.js';
import { VaultServiceProtection } from './service-protection.js';

export * from './service-common.js';

type GrantRef = LiveGrant | SiteGrant;

export class VaultService extends VaultServiceProtection {
  async handlePublic(sessionId: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    this.requests.expire();
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
      const asked = await this.grantOrAsk(context, sessionId, tabId, inspection, 'list', undefined, signal);
      if ('reply' in asked) return asked.reply;
      const { grant } = asked;
      const store = this.storeFor(context.browserId);
      if (!store.isUnlocked) return this.requestForInspection(context, sessionId, tabId, inspection, 'unlock');
      const entries = await store.list();
      const scoped = entries.filter((entry) => entry.origin === inspection.origin
        && (grant.kind === 'site' || !grant.credentialId || grant.credentialId === entry.id));
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
      const handle: string = params.handle;
      const inspection = await this.inspectSupportedSite(tabId, sessionId, signal);
      const asked = await this.grantOrAsk(context, sessionId, tabId, inspection, 'fill', handle, signal);
      if ('reply' in asked) return asked.reply;
      // The page may have changed while the owner decided: inspect it again before filling.
      const current = asked.waited ? await this.inspectSupportedSite(tabId, sessionId, signal) : inspection;
      return this.fill.run(context, sessionId, tabId, current, handle, signal, asked.grant.grantId);
    }
    throw new VaultServiceError('INVALID_ARGUMENT', 'unsupported vault action');
  }

  /**
   * The grant for a list or fill, or the reply that asks the owner for one. On an allowlisted site
   * with an unlocked vault the site is approved without asking (specs/006 FR-010). A request shown
   * on an in-page card is awaited (FR-008); when the owner allows it in time, the new site approval
   * is returned with `waited`. A fill the private page already ran for this request is returned as is.
   */
  private async grantOrAsk(
    context: VaultBrowserContext,
    sessionId: string,
    tabId: number,
    inspection: VaultInspection,
    purpose: 'list' | 'fill',
    handle: string | undefined,
    signal?: AbortSignal,
  ): Promise<{ grant: GrantRef; waited: boolean } | { reply: Record<string, unknown> }> {
    const found = this.grants.find(context, sessionId, inspection.origin, purpose, handle);
    if (found) return { grant: found, waited: false };
    const allowlisted = await this.approveFromAllowlist(context, sessionId, inspection.origin);
    if (allowlisted) return { grant: allowlisted, waited: false };
    const pending = await this.requests.begin(context, {
      purpose: purpose === 'fill' ? 'fill' : 'approve',
      sessionId,
      tabId,
      documentId: inspection.documentId,
      origin: inspection.origin,
      ...(handle ? { credentialId: handle } : {}),
      card: true,
    });
    if (pending.surface !== 'card') return { reply: this.requestRequired(pending, inspection.origin) };
    await this.requests.waitForEnd(pending, VAULT_CARD_WAIT_MS, signal);
    const state = pending.request.state;
    if (state === 'declined') return { reply: publicError('VAULT_DECLINED', { requestId: pending.request.requestId, origin: inspection.origin }) };
    if (state === 'accepted' && pending.outcome) return { reply: pending.outcome };
    if (state === 'accepted') {
      const granted = this.grants.find(context, sessionId, inspection.origin, purpose, handle);
      if (granted) return { grant: granted, waited: true };
    }
    return { reply: this.requestRequired(pending, inspection.origin) };
  }

  /** A site approval from the owner's allowlist, when the vault is unlocked and the origin is on it. */
  private async approveFromAllowlist(context: VaultBrowserContext, sessionId: string, origin: string): Promise<SiteGrant | undefined> {
    const store = this.storeFor(context.browserId);
    if (!store.isUnlocked) return undefined;
    const allowlist = await store.allowlist();
    if (!allowlist.some((entry) => entry.origin === origin)) return undefined;
    const scope = scopeForBrowser(context.browserId);
    const grant = this.grants.createSite(scope, origin, 'allowlist');
    await store.audit(this.auditEvent('grant', scope, sessionId, origin, 'success'));
    return grant;
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
    const request = await this.requests.begin(context, {
      purpose,
      sessionId,
      tabId,
      documentId: inspection.documentId,
      origin: inspection.origin,
      ...extra,
    });
    return this.requestRequired(request, inspection.origin);
  }
}
