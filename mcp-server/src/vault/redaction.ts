import crypto from 'node:crypto';

/** Every shape a secret may take in page text: normalization forms and both line endings. */
export function secretVariants(value: string): string[] {
  const variants = new Set<string>([
    value,
    value.normalize('NFC'),
    value.normalize('NFD'),
    value.normalize('NFKC'),
    value.normalize('NFKD'),
    value.replace(/\r\n?/g, '\n'),
    value.replace(/\n/g, '\r\n'),
  ]);
  return [...variants].filter(Boolean);
}

/** The characters a marker must avoid: every character of every value in scope. */
export function charactersOf(variants: Iterable<string>): Set<string> {
  const characters = new Set<string>();
  for (const variant of variants) for (const character of variant) characters.add(character);
  return characters;
}

const PRIVATE_USE_RANGES: ReadonlyArray<readonly [number, number]> = [[0xe000, 0xf8ff], [0xf0000, 0xffffd], [0x100000, 0x10fffd]];

/** First private-use code point no value in scope contains; '' when every one is taken. */
export function unusedPrivateUseCharacter(forbidden: ReadonlySet<string>): string {
  for (const [start, end] of PRIVATE_USE_RANGES) {
    for (let codePoint = start; codePoint <= end; codePoint++) {
      const candidate = String.fromCodePoint(codePoint);
      if (!forbidden.has(candidate)) return candidate;
    }
  }
  return '';
}

interface SecretRecord {
  value: string;
  variants: string[];
  documents: Set<string>;
}

export interface RedactionContext {
  /** The daemon-authenticated public tool name; never taken from page data. */
  toolName?: string;
}

const COMMON_TOOL_RESULT_FIELDS = ['success', 'text', 'error'] as const;
export const TRUSTED_TOOL_RESULT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  browser_navigate: ['tabId', 'url', 'title', 'status', 'download', 'noContent', 'filename', 'replacedTabId'],
  browser_tabs: ['tabs', 'selected', 'browserId', 'label', 'pinnedAuto', 'browsers'],
  browser_snapshot: ['url', 'title', 'truncated', 'refs', '__fallbacks', 'rebound'],
  browser_text: ['url', 'title', 'total', 'length', 'truncated', 'rebound'],
  browser_screenshot: ['image', 'width', 'height', 'via', 'scale', 'origin', 'viewport', 'cdpFallback'],
  browser_click: ['tabId', 'clicked', 'receipt'],
  browser_type: ['tabId', 'typed', 'receipt'],
  browser_fill: ['tabId', 'filled', 'receipt'],
  browser_scroll: ['tabId', 'x', 'y', 'room', 'container', 'rebound'],
  browser_wait: ['tabId', 'waited', 'ms'],
  browser_evaluate: ['result', 'via', 'truncated', 'dialog'],
  browser_handle_dialog: ['tabId', 'handled', 'dialog'],
  browser_batch: ['content', 'structuredContent', 'isError'],
  browser_emulate: ['active', 'cleared', 'lost', 'lostReport'],
  browser_logs: ['request', 'tabId', 'sections', 'entries'],
  browser_mock: ['tabId', 'active', 'rules'],
  browser_inspect_element: ['tabId', 'element', 'details'],
  browser_safety: ['content', 'structuredContent', 'settings', 'isError'],
  browser_vault: [
    'status', 'code', 'message', 'requestId', 'purpose', 'origin', 'handle', 'accounts',
    'browserLabel', 'grantId', 'backups', 'backupId', 'createdAt', 'filled_fields', 'success', 'error',
  ],
};

const VAULT_STATUS_VALUES = new Set([
  'ready', 'locked', 'empty', 'incomplete', 'unlocked', 'saved', 'filled', 'approved',
  'accepted', 'pending', 'processing', 'declined', 'cancelled', 'expired', 'failed',
  'deleted', 'not_found', 'restored', 'backed_up', 'user_action_required', 'recovery_required',
]);
const VAULT_PURPOSE_VALUES = new Set(['list', 'fill', 'save', 'unlock', 'approve']);
const VAULT_CODE_VALUES = new Set([
  'VAULT_EXTENSION_REQUIRED', 'VAULT_PERMISSION_DENIED', 'VAULT_ORIGIN_MISMATCH',
  'VAULT_DOCUMENT_CHANGED', 'VAULT_TARGET_UNSAFE', 'VAULT_CONTEXT_PROTECTED',
  'VAULT_RECOVERY_REQUIRED', 'VAULT_KEY_MISSING', 'VAULT_STORAGE_INVALID', 'VAULT_LOCKED',
  'VAULT_BUSY', 'VAULT_USER_ACTION_REQUIRED', 'VAULT_REQUEST_EXPIRED', 'VAULT_DECLINED',
  'VAULT_OUTCOME_UNKNOWN', 'INVALID_ARGUMENT', 'NOT_CONNECTED',
]);

/**
 * Per-daemon, per-browser output scrubber. Raw values live only in this
 * in-memory registry; callers register a value before the extension receives
 * it and keep the registration until every protected document is discarded.
 */
export class VaultRedactionRegistry {
  private readonly byScope = new Map<string, Map<string, SecretRecord>>();

  register(scope: string, value: string, documentId: string): void {
    if (!scope || !value || !documentId) throw new Error('VAULT_STORAGE_INVALID: redaction context is incomplete');
    let records = this.byScope.get(scope);
    if (!records) {
      records = new Map();
      this.byScope.set(scope, records);
    }
    const key = crypto.createHash('sha256').update(value, 'utf8').digest('hex');
    const current = records.get(key);
    if (current) {
      current.documents.add(documentId);
      return;
    }
    records.set(key, {
      value,
      variants: secretVariants(value),
      documents: new Set([documentId]),
    });
  }

  hasSecrets(scope: string): boolean {
    return (this.byScope.get(scope)?.size ?? 0) > 0;
  }

  hasSecretForDocument(scope: string, documentId: string): boolean {
    for (const record of this.byScope.get(scope)?.values() ?? []) {
      if (record.documents.has(documentId)) return true;
    }
    return false;
  }

  removeDocument(scope: string, documentId: string): void {
    const records = this.byScope.get(scope);
    if (!records) return;
    for (const [key, record] of records) {
      record.documents.delete(documentId);
      if (record.documents.size === 0) {
        record.value = '';
        record.variants.fill('');
        records.delete(key);
      }
    }
    if (records.size === 0) this.byScope.delete(scope);
  }

  sanitize(scope: string, value: unknown, context: RedactionContext = {}): unknown {
    const records = [...(this.byScope.get(scope)?.values() ?? [])]
      .sort((a, b) => Math.max(...b.variants.map((v) => v.length)) - Math.max(...a.variants.map((v) => v.length)));
    if (records.length === 0) return value;
    const replacement = this.replacementFor(records);
    return this.sanitizeValue(value, records, replacement, new WeakSet<object>(), 0, context, []);
  }

  private replacementFor(records: SecretRecord[]): string {
    // The marker must avoid every value currently in scope: a marker for a
    // later short secret must not reintroduce an earlier one. Private-use
    // code points are selected only when no registered secret contains them.
    const marker = unusedPrivateUseCharacter(charactersOf(records.flatMap((record) => record.variants)));
    // A no-marker replacement is still safe when a pathological set uses all
    // private-use characters; dropping the text is preferable to echoing data.
    return marker ? marker.repeat(3) : '';
  }

  private sanitizeValue(
    value: unknown,
    records: SecretRecord[],
    replacement: string,
    seen: WeakSet<object>,
    depth: number,
    context: RedactionContext,
    path: Array<string | number>,
  ): unknown {
    if (typeof value === 'string') return this.sanitizeString(value, records, replacement);
    if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'bigint') return this.sanitizeString(value.toString(), records, replacement);
    if (value instanceof Error) {
      return {
        name: this.sanitizeString(value.name, records, replacement),
        message: this.sanitizeString(value.message, records, replacement),
        ...('code' in value ? { code: this.sanitizeValue((value as Error & { code?: unknown }).code, records, replacement, seen, depth + 1, context, [...path, 'code']) } : {}),
      };
    }
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) return '[protected binary result omitted]';
    if (typeof value !== 'object' || depth > 32) return '[protected result omitted]';
    if (seen.has(value)) return '[circular result omitted]';
    seen.add(value);
    if (Array.isArray(value)) {
      return value.map((item, index) => this.sanitizeValue(item, records, replacement, seen, depth + 1, context, [...path, index]));
    }

    const source = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    const trustedImage = this.isTrustedScreenshotImage(context, path, source);
    for (const [key, item] of Object.entries(source)) {
      const preserveRootKey = path.length === 0 && this.isTrustedRootField(context, key);
      const safeKey = (trustedImage && ['mimeType', 'data'].includes(key)) || preserveRootKey
        ? key
        : this.sanitizeString(key, records, replacement);
      const childPath = [...path, key];
      if (trustedImage && ['mimeType', 'data'].includes(key)) {
        output[safeKey] = item;
      } else if (path.length === 0 && context.toolName === 'browser_vault' && this.isVaultEnumField(key, item)) {
        if (typeof item !== 'string' || this.containsSecret(item, records)) continue;
        output[safeKey] = item;
      } else if (path.length === 0 && context.toolName === 'browser_vault' && key === 'error' && typeof item === 'string') {
        output[safeKey] = this.sanitizeVaultError(item, records, replacement);
      } else {
        output[safeKey] = this.sanitizeValue(item, records, replacement, seen, depth + 1, context, childPath);
      }
    }
    return output;
  }

  private isTrustedRootField(context: RedactionContext, key: string): boolean {
    const fields = context.toolName ? TRUSTED_TOOL_RESULT_FIELDS[context.toolName] : undefined;
    return fields !== undefined && (COMMON_TOOL_RESULT_FIELDS.includes(key as typeof COMMON_TOOL_RESULT_FIELDS[number]) || fields.includes(key));
  }

  private isVaultEnumField(key: string, value: unknown): boolean {
    if (typeof value !== 'string') return false;
    if (key === 'status') return VAULT_STATUS_VALUES.has(value);
    if (key === 'purpose') return VAULT_PURPOSE_VALUES.has(value);
    if (key === 'code') return VAULT_CODE_VALUES.has(value);
    return false;
  }

  private sanitizeVaultError(value: string, records: SecretRecord[], replacement: string): string {
    const match = /^(VAULT_[A-Z0-9_]+|INVALID_ARGUMENT|NOT_CONNECTED):\s/.exec(value);
    const code = match?.[1];
    if (!code || !VAULT_CODE_VALUES.has(code) || this.containsSecret(code, records)) {
      return this.sanitizeString(value, records, replacement);
    }
    return `${code}: ${this.sanitizeString(value.slice(match[0].length), records, replacement)}`;
  }

  private containsSecret(value: string, records: SecretRecord[]): boolean {
    return records.some((record) => record.variants.some((variant) => value.includes(variant)));
  }

  private isTrustedScreenshotImage(
    context: RedactionContext,
    path: Array<string | number>,
    image: Record<string, unknown>,
  ): boolean {
    // The daemon receives raw extension wire output here, before outcomeOf()
    // converts its root image envelope to MCP content[]. Nested/page-authored
    // image-like objects are therefore never exempted by name alone.
    if (context.toolName !== 'browser_screenshot' || path.length !== 1 || path[0] !== 'image') return false;
    const keys = Object.keys(image).sort();
    return keys.length === 2 && keys[0] === 'data' && keys[1] === 'mimeType'
      && image.mimeType === 'image/jpeg' && typeof image.data === 'string';
  }

  private sanitizeString(value: string, records: SecretRecord[], replacement: string): string {
    let output = value;
    for (const record of records) {
      for (const variant of record.variants) {
        if (variant) output = output.split(variant).join(replacement);
      }
    }
    return output;
  }
}
