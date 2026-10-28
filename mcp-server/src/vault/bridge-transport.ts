import { WebSocket } from 'ws';
import { CREDENTIAL_VAULT_CAPABILITY, SITE_CONTEXT_CAPABILITY, SITE_MAP_CAPABILITY, VAULT_SITE_APPROVAL_CAPABILITY } from '../protocol.js';
import { ExtensionConnections, type ExtensionConnection } from '../bridge-connections.js';
import type { VaultService } from './service.js';

interface PendingVaultAction {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  action: string;
  conn: ExtensionConnection;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/** Owns the private vault wire protocol, separate from normal retried tools. */
export class VaultBridgeTransport {
  private pending = new Map<string, PendingVaultAction>();
  private requestId = 0;
  private service: VaultService | null = null;

  constructor(private readonly connections: ExtensionConnections) {}

  setService(service: VaultService): void {
    this.service = service;
  }

  private supportsVault(conn: ExtensionConnection): boolean {
    return conn.capabilities.includes(CREDENTIAL_VAULT_CAPABILITY);
  }

  private hasUniqueIdentity(conn: ExtensionConnection): boolean {
    return this.connections.live().filter((candidate) => candidate.browserId === conn.browserId).length === 1;
  }

  getBrowserContext(sessionId: string): {
    browserId: string;
    browserLabel: string;
    connectionId: string;
    supportsVault: boolean;
    supportsSiteContext: boolean;
    supportsSiteMap: boolean;
    supportsSiteApproval: boolean;
    ambiguous: boolean;
  } {
    const conn = this.connections.forSession(sessionId);
    return {
      browserId: conn.browserId,
      browserLabel: conn.label,
      connectionId: conn.connectionId,
      supportsVault: this.supportsVault(conn),
      supportsSiteContext: conn.capabilities.includes(SITE_CONTEXT_CAPABILITY),
      supportsSiteMap: conn.capabilities.includes(SITE_MAP_CAPABILITY),
      supportsSiteApproval: this.supportsVault(conn) && conn.capabilities.includes(VAULT_SITE_APPROVAL_CAPABILITY),
      ambiguous: !this.hasUniqueIdentity(conn),
    };
  }

  selectBrowser(sessionId: string, browser: unknown): Record<string, unknown> {
    return this.connections.select(sessionId, browser);
  }

  async callAction(
    action: string,
    params: Record<string, unknown>,
    sessionId: string,
    signal?: AbortSignal,
    agentName?: string,
  ): Promise<unknown> {
    if (!['inspect', 'fill', 'openUi', 'prompt', 'promptClose'].includes(action)) throw new Error('INVALID_ARGUMENT: unsupported private vault action');
    if (signal?.aborted) throw new Error('VAULT_PERMISSION_DENIED: private action was cancelled before send');

    let conn: ExtensionConnection;
    try {
      conn = this.connections.forSession(sessionId);
      if (!this.supportsVault(conn)) {
        throw new Error('VAULT_EXTENSION_REQUIRED: reload the Browser Controller extension to use the credential vault');
      }
      if (conn.browserId === 'default' || !this.hasUniqueIdentity(conn)) {
        throw new Error('VAULT_PERMISSION_DENIED: browser identity is not unique and verified');
      }
      if ((action === 'prompt' || action === 'promptClose') && !conn.capabilities.includes(VAULT_SITE_APPROVAL_CAPABILITY)) {
        throw new Error('VAULT_EXTENSION_REQUIRED: reload the Browser Controller extension to show approval cards');
      }
      if (action === 'inspect' && (!Number.isInteger(params.tabId)
        || Object.keys(params).some((key) => key !== 'tabId' && key !== 'withIdentifier')
        || (params.withIdentifier !== undefined && params.withIdentifier !== true)
        || (params.withIdentifier === true && !conn.capabilities.includes(VAULT_SITE_APPROVAL_CAPABILITY)))) {
        throw new Error('INVALID_ARGUMENT: private inspection request is invalid');
      }
      if (action === 'openUi' && (typeof params.requestId !== 'string' || Object.keys(params).some((key) => key !== 'requestId'))) {
        throw new Error('INVALID_ARGUMENT: private UI request is invalid');
      }
      if (action === 'prompt') this.validatePromptParams(params);
      if (action === 'promptClose' && (!Number.isInteger(params.tabId) || typeof params.requestId !== 'string'
        || Object.keys(params).some((key) => key !== 'tabId' && key !== 'requestId'))) {
        throw new Error('INVALID_ARGUMENT: private card request is invalid');
      }
      if (action === 'fill') this.validateFillParams(params, conn.capabilities.includes(VAULT_SITE_APPROVAL_CAPABILITY));
    } catch (error) {
      throw error instanceof Error ? error : new Error('NOT_CONNECTED: selected browser is not connected');
    }
    return this.dispatch(action, params, conn, sessionId, signal, agentName);
  }

  /**
   * Takes an approval card down through the connection that drew it. A card can outlive the session that
   * asked for it (specs/006 edge cases), and an ended session would be routed to the primary browser.
   */
  closeCard(connectionId: string, params: { tabId: number; requestId: string }, sessionId: string): Promise<unknown> {
    const conn = this.connections.live().find((candidate) => candidate.connectionId === connectionId);
    if (!conn || !this.supportsVault(conn) || !conn.capabilities.includes(VAULT_SITE_APPROVAL_CAPABILITY)) {
      return Promise.resolve({ success: true, closed: false });
    }
    return this.dispatch('promptClose', { tabId: params.tabId, requestId: params.requestId }, conn, sessionId);
  }

  private dispatch(
    action: string,
    params: Record<string, unknown>,
    conn: ExtensionConnection,
    sessionId: string,
    signal?: AbortSignal,
    agentName?: string,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = `v${++this.requestId}`;
      // The extension bounds each page script at 8s; reserve transport time
      // while keeping inspections/fill sub-actions inside the service budget.
      const timeoutMs = action === 'fill' || action === 'inspect' ? 9_000 : 5_000;
      const timeout = setTimeout(() => {
        const target = this.pending.get(id);
        if (target) this.rejectAction(id, target, new Error(action === 'fill'
          ? 'VAULT_OUTCOME_UNKNOWN: private fill timed out after dispatch'
          : 'VAULT_PAGE_UNRESPONSIVE: the extension did not answer the private action'), true);
      }, timeoutMs);
      const pending: PendingVaultAction = { resolve, reject, timeout, action, conn, signal };
      const onAbort = () => {
        const target = this.pending.get(id);
        if (target) this.rejectAction(id, target, new Error('VAULT_PERMISSION_DENIED: private vault action was cancelled'), true);
      };
      pending.onAbort = onAbort;
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, pending);
      try {
        conn.ws.send(JSON.stringify({ type: 'vaultAction', id, action, params, sessionId, ...(agentName ? { agentName } : {}) }));
      } catch {
        this.rejectAction(id, pending, new Error(action === 'fill'
          ? 'VAULT_OUTCOME_UNKNOWN: private fill result is uncertain'
          : 'NOT_CONNECTED: selected browser is not connected'), false);
      }
    });
  }

  handleMessage(message: Record<string, any>, conn: ExtensionConnection): boolean {
    switch (message.type) {
      case 'vaultActionResponse':
        this.resolveAction(message, conn);
        return true;
      case 'vaultUiRequest':
        void this.handleUiRequest(message, conn);
        return true;
      case 'vaultUiClosed':
        if (this.supportsVault(conn)) {
          this.service?.cancelPrivateUiRequests(conn.browserId, conn.connectionId);
        }
        return true;
      case 'vaultProtectionState':
        if (this.supportsVault(conn) && typeof message.sequence === 'number') {
          this.service?.noteProtectionState(
            conn.browserId, conn.connectionId, message.sequence, message.documents,
            message.protectionUnknown === true, message.unknownTabIds,
          );
          this.send(conn, { type: 'vaultProtectionAck', sequence: message.sequence });
        }
        return true;
      case 'vaultProtectionTabRemoved':
        if (this.supportsVault(conn)) {
          this.service?.discardProtectedTab(conn.browserId, conn.connectionId, message.tabId, message.documentIds);
          if (Number.isSafeInteger(message.sequence)) {
            this.send(conn, { type: 'vaultProtectionTabRemovedAck', sequence: message.sequence });
          }
        }
        return true;
      default:
        return false;
    }
  }

  connectionDropped(conn: ExtensionConnection, reason: string): void {
    this.service?.revokeConnection(conn.browserId, conn.connectionId);
    this.rejectPending(reason, conn);
  }

  rejectPending(reason: string, onlyConn?: ExtensionConnection): void {
    for (const [id, pending] of this.pending) {
      if (onlyConn && pending.conn !== onlyConn) continue;
      this.rejectAction(id, pending, new Error(pending.action === 'fill'
        ? `VAULT_OUTCOME_UNKNOWN: ${reason}; the private fill may have run`
        : `NOT_CONNECTED: ${reason}`), true);
    }
  }

  private detachAction(id: string, pending: PendingVaultAction): void {
    clearTimeout(pending.timeout);
    if (pending.onAbort && pending.signal) pending.signal.removeEventListener('abort', pending.onAbort);
    this.pending.delete(id);
  }

  private rejectAction(id: string, pending: PendingVaultAction, error: Error, notifyExtension: boolean): void {
    this.detachAction(id, pending);
    if (notifyExtension) this.send(pending.conn, { type: 'vaultActionCancel', id });
    pending.reject(error);
  }

  /**
   * A fill carries the password, the identifier, or both (specs/006 FR-012). Only an extension with
   * the site-approval capability understands the identifier; an older one gets the password alone.
   */
  private validateFillParams(params: Record<string, unknown>, identifierSupported: boolean): void {
    const required = ['tabId', 'origin', 'documentId', 'targetDocumentId', 'frameId', 'nonce'];
    const allowed = [...required, 'password', ...(identifierSupported ? ['identifier'] : [])];
    if (Object.keys(params).some((key) => !allowed.includes(key)) || required.some((key) => params[key] === undefined)
      || !Number.isInteger(params.tabId) || typeof params.origin !== 'string' || typeof params.documentId !== 'string'
      || typeof params.targetDocumentId !== 'string' || !params.targetDocumentId
      || typeof params.frameId !== 'number' || !Number.isInteger(params.frameId) || params.frameId < 0
      || typeof params.nonce !== 'string'
      || (params.password !== undefined && typeof params.password !== 'string')
      || (params.identifier !== undefined && typeof params.identifier !== 'string')
      || (params.password === undefined && params.identifier === undefined)) {
      throw new Error('INVALID_ARGUMENT: private fill request is invalid');
    }
  }

  private validatePromptParams(params: Record<string, unknown>): void {
    const allowed = ['tabId', 'requestId', 'documentId', 'origin', 'purpose', 'browserLabel', 'agentName', 'unlock', 'account', 'expiresAt'];
    const shortText = (value: unknown) => typeof value === 'string' && value.length <= 120;
    if (Object.keys(params).some((key) => !allowed.includes(key)) || !Number.isInteger(params.tabId)
      || typeof params.requestId !== 'string' || typeof params.documentId !== 'string' || !params.documentId
      || typeof params.origin !== 'string' || !['list', 'fill'].includes(String(params.purpose))
      || !shortText(params.browserLabel) || !shortText(params.agentName) || typeof params.unlock !== 'boolean'
      || (params.account !== undefined && !shortText(params.account)) || !Number.isSafeInteger(params.expiresAt)) {
      throw new Error('INVALID_ARGUMENT: private card request is invalid');
    }
  }

  private resolveAction(message: Record<string, any>, conn: ExtensionConnection): void {
    if (typeof message.id !== 'string') return;
    const pending = this.pending.get(message.id);
    if (!pending || pending.conn !== conn) return;
    this.detachAction(message.id, pending);
    if (message.success === true) pending.resolve(message.result);
    else pending.reject(new Error(typeof message.error === 'string'
      ? message.error.slice(0, 1_000)
      : 'VAULT_TARGET_UNSAFE: private vault action failed'));
  }

  private async handleUiRequest(message: Record<string, any>, conn: ExtensionConnection): Promise<void> {
    if (typeof message.id !== 'string' || !/^ui_[a-f0-9]{32}$/.test(message.id)) return;
    let result: unknown;
    if (!this.service || !this.supportsVault(conn)) {
      result = { success: false, code: 'VAULT_EXTENSION_REQUIRED', message: 'Reload the Browser Controller extension to use the credential vault.' };
    } else {
      try {
        result = await this.service.handlePrivateUi({
          browserId: conn.browserId,
          browserLabel: conn.label,
          connectionId: conn.connectionId,
        }, message.payload);
      } catch {
        result = { success: false, code: 'VAULT_STORAGE_INVALID', message: 'The local vault could not be safely read or written.' };
      }
    }
    if (!this.connections.has(conn) || conn.ws.readyState !== WebSocket.OPEN) return;
    this.send(conn, { type: 'vaultUiResponse', id: message.id, result });
  }

  private send(conn: ExtensionConnection, message: Record<string, unknown>): void {
    try { conn.ws.send(JSON.stringify(message)); } catch { /* socket closing */ }
  }
}
