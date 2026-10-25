import type { VaultPrivateRequest } from './types.js';
import { VaultServiceError, containsCredentialSecret, metadataMarker, safePublicMetadataOf, type VaultBrowserContext, type VaultInspection } from './service-common.js';
import { VaultServiceProtection } from './service-protection.js';

export * from './service-common.js';

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
      const store = this.storeFor(context.browserId);
      const grant = this.grants.find(context, sessionId, inspection.origin, 'list');
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
      const grant = this.grants.find(context, sessionId, inspection.origin, 'fill', params.handle);
      if (!grant) return this.requestForInspection(context, sessionId, tabId, inspection, 'fill', { credentialId: params.handle });
      return this.fill.run(context, sessionId, tabId, inspection, params.handle, signal, grant.grantId);
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
