import { metadataOf, type VaultCredential, type VaultGrant, type VaultPrivateRequest } from './types.js';
import { charactersOf, secretVariants, unusedPrivateUseCharacter } from './redaction.js';

export type { VaultCredential, VaultGrant, VaultPrivateRequest } from './types.js';

export const VAULT_PENDING_TTL_MS = 5 * 60_000;
/** Total active budget for both frame inspections, resolution, fill and final audit. */
export const VAULT_FILL_OPERATION_TIMEOUT_MS = 30_000;
export const TERMINAL_RETENTION_MS = 15 * 60_000;
const INTERNAL_ACTIONS = new Set(['inspect', 'fill', 'openUi']);
export const PROTECTED_ALLOWED_TOOLS = new Set([
  'browser_snapshot', 'browser_text', 'browser_wait', 'browser_scroll',
  'browser_click', 'browser_type', 'browser_tabs', 'browser_navigate',
  'browser_handle_dialog', 'browser_emulate',
]);
export const PROFILE_WIDE_DENIED_TOOLS = new Set([
  'browser_evaluate', 'browser_mock', 'browser_logs', 'browser_screenshot',
]);

export function publicMetadataOf(entry: VaultCredential): Record<string, unknown> {
  const { id, ...metadata } = metadataOf(entry);
  return { ...metadata, handle: id };
}

export function containsCredentialSecret(value: string, entries: VaultCredential[]): boolean {
  return entries.some((entry) => secretVariants(entry.password).some((variant) => value.includes(variant)));
}

export function metadataMarker(entries: VaultCredential[]): string {
  // Vault password length is bounded far below the private-use ranges, so a
  // marker exists in practice. Empty metadata strings cannot echo a credential.
  return unusedPrivateUseCharacter(charactersOf(entries.flatMap((entry) => secretVariants(entry.password))));
}

export function safePublicMetadataOf(entry: VaultCredential, marker: string): Record<string, unknown> {
  const metadata = publicMetadataOf(entry);
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === 'string' && secretVariants(entry.password).some((variant) => value.includes(variant))) {
      metadata[key] = marker;
    }
  }
  return metadata;
}

export interface VaultBrowserContext {
  browserId: string;
  browserLabel: string;
  connectionId: string;
  agentName?: string;
  supportsVault: boolean;
  ambiguous?: boolean;
}

export interface VaultInspection {
  tabId: number;
  origin: string;
  /** Top-level document used for taint/recovery protection. */
  documentId: string;
  /** Exact same-origin frame selected by the extension's isolated-world inspection. */
  targetDocumentId: string;
  frameId: number;
  nonce: string;
  suitable: boolean;
  reasonCode?: string;
}

export interface VaultTransport {
  getBrowserContext(sessionId: string): Promise<VaultBrowserContext>;
  callVaultAction(action: string, params: Record<string, unknown>, sessionId: string, signal?: AbortSignal, agentName?: string): Promise<unknown>;
}

export type ProtectedDocumentState = 'active' | 'recovery_required';

export interface ProtectedDocument {
  tabId: number;
  documentId: string;
  origin: string;
  state: ProtectedDocumentState;
  current: boolean;
}

export interface InternalPending {
  request: VaultPrivateRequest;
  browserId: string;
  browserLabel: string;
  connectionId: string;
  agentName: string;
  metadata?: { label: string; identifier: string };
  terminalAt?: number;
}

export interface PrivateConnection {
  browserId: string;
  browserLabel: string;
  connectionId: string;
}

export interface LiveGrant extends VaultGrant {
  claimedBy?: string;
  consumed?: boolean;
}

export interface PendingOperation {
  scope: string;
  controller: AbortController;
  done: Promise<void>;
  resolveDone: () => void;
  sessionId?: string;
  connectionId?: string;
  grantId?: string;
  credentialId?: string;
  parentSignal?: AbortSignal;
  parentAbortHandler?: () => void;
}

export class VaultServiceError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'VaultServiceError';
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function safeCode(error: unknown): string {
  if (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string') {
    const code = (error as { code: string }).code;
    if (/^VAULT_[A-Z_]+$/.test(code) || code === 'INVALID_ARGUMENT' || code === 'NOT_CONNECTED') return code;
  }
  const match = /^(VAULT_[A-Z_]+|INVALID_ARGUMENT|NOT_CONNECTED):/.exec(error instanceof Error ? error.message : String(error));
  return match?.[1] ?? 'VAULT_STORAGE_INVALID';
}

export function safeMessage(code: string): string {
  const messages: Record<string, string> = {
    VAULT_EXTENSION_REQUIRED: 'The connected Browser Controller daemon does not support the credential vault. Restart it, then reload the extension.',
    VAULT_PERMISSION_DENIED: 'This browser, site, account, or session does not have a current user grant.',
    VAULT_ORIGIN_MISMATCH: 'The active page does not match the exact site origin saved for this account.',
    VAULT_ORIGIN_UNSUPPORTED: 'This page is not a supported vault target: fills work only on HTTPS sites and on loopback HTTP.',
    VAULT_PAGE_UNRESPONSIVE: 'The page did not respond before the vault action timed out. Reload it, then inspect again.',
    VAULT_DOCUMENT_CHANGED: 'The page changed while the private request was waiting. Start a new request.',
    VAULT_TARGET_UNSAFE: 'The page does not have one verified, editable current-password field.',
    VAULT_CONTEXT_PROTECTED: 'This operation is blocked because the page may contain a saved password.',
    VAULT_RECOVERY_REQUIRED: 'The vault or protected page needs recovery. Review it in the private extension page.',
    VAULT_KEY_MISSING: 'The local vault key is missing. Existing encrypted data was preserved.',
    VAULT_STORAGE_INVALID: 'The local vault could not be safely read or written.',
    VAULT_LOCKED: 'Unlock the vault in its private extension page.',
    VAULT_BUSY: 'Another vault operation is still running. Try again shortly.',
    VAULT_USER_ACTION_REQUIRED: 'Continue in the private Browser Controller vault page.',
    VAULT_REQUEST_EXPIRED: 'This private request expired. Start a new request.',
    VAULT_DECLINED: 'The private request was declined.',
    VAULT_OUTCOME_UNKNOWN: 'The fill result is uncertain. Inspect the page before making another explicit attempt.',
    INVALID_ARGUMENT: 'The vault request is invalid.',
    NOT_CONNECTED: 'The selected browser is not connected.',
  };
  return messages[code] ?? 'The vault operation could not be completed safely.';
}

export function publicError(code: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const message = safeMessage(code);
  return { success: false, code, message, error: `${code}: ${message}`, ...extra };
}

export function requireStrictKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new VaultServiceError('INVALID_ARGUMENT', 'private vault request is invalid');
}

/** Daemon-owned credential storage, grants, private requests, taint and output redaction. */
