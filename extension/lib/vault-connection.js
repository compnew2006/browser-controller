import {
  acknowledgeVaultProtection,
  acknowledgeVaultRemoval,
  getVaultProtectionSnapshot,
} from './vault-actions.js';

/** Owns the optional vault protocol state layered on the base WS connection. */
export class VaultConnectionChannel {
  constructor({ getSocket, isConnected }) {
    this.getSocket = getSocket;
    this.isConnected = isConnected;
    this.supported = false;
    this.pendingUiRequests = new Map();
  }

  setSupported(supported) {
    this.supported = Boolean(supported);
  }

  isReady() {
    return this.isConnected() && this.supported;
  }

  failure(code, message) {
    return { success: false, code, message };
  }

  settleUiRequest(id, result) {
    const pending = this.pendingUiRequests.get(id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingUiRequests.delete(id);
    pending.resolve(result);
  }

  sendProtectionState() {
    if (!this.isReady()) return;
    getVaultProtectionSnapshot().then((snapshot) => {
      if (!this.supported) return;
      this.sendJson(snapshot);
      for (const removal of snapshot.pendingRemovals || []) {
        if (!this.supported || this.getSocket()?.readyState !== WebSocket.OPEN) return;
        this.sendJson({ type: 'vaultProtectionTabRemoved', ...removal });
      }
    }).catch(() => {});
  }

  sendProtectionTabRemoved(removal) {
    if (!removal || !Number.isSafeInteger(removal.sequence) || !Number.isInteger(removal.tabId)) return;
    if (!this.isReady()) return;
    this.sendJson({ type: 'vaultProtectionTabRemoved', ...removal });
  }

  sendUiClosed() {
    if (this.isReady()) this.sendJson({ type: 'vaultUiClosed' });
  }

  requestUi(payload) {
    const socket = this.getSocket();
    if (!this.isReady() || socket?.readyState !== WebSocket.OPEN) {
      return Promise.resolve(this.failure('VAULT_EXTENSION_REQUIRED', 'The credential vault is not connected to the daemon.'));
    }
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    const id = `ui_${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.settleUiRequest(id, this.failure('VAULT_BUSY', 'The vault request timed out. Try again.'));
      }, 40_000);
      this.pendingUiRequests.set(id, { resolve, timeout });
      try { socket.send(JSON.stringify({ type: 'vaultUiRequest', id, payload })); }
      catch {
        this.settleUiRequest(id, this.failure('NOT_CONNECTED', 'The daemon connection was lost.'));
      }
    });
  }

  handleMessage(message) {
    if (message.type === 'vaultUiResponse') {
      this.settleUiRequest(message.id, message.result && typeof message.result === 'object'
        ? message.result
        : this.failure('VAULT_STORAGE_INVALID', 'The vault could not complete that action.'));
      return true;
    }
    if (message.type === 'vaultProtectionAck') {
      acknowledgeVaultProtection(message.sequence);
      return true;
    }
    if (message.type === 'vaultProtectionTabRemovedAck') {
      acknowledgeVaultRemoval(message.sequence);
      return true;
    }
    return false;
  }

  failUiRequests() {
    for (const id of [...this.pendingUiRequests.keys()]) {
      this.settleUiRequest(id, this.failure('NOT_CONNECTED', 'The daemon connection was lost.'));
    }
  }

  sendJson(message) {
    const socket = this.getSocket();
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }
}
