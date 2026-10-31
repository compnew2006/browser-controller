/**
 * The one registry of the error codes this product speaks.
 *
 * Every failure the agent reads is a `CODE: message` line. The code is the
 * part a program branches on, so it has to be a fixed vocabulary: a typo in a
 * code (TAB_OWNED instead of TAB_NOT_OWNED) used to pass every check that only
 * looked at the shape of the line, and the agent then acted on a code that
 * nothing had ever produced. Here a code can only come from this registry, so
 * a mistyped code is a compile error instead of a silent failure.
 *
 * The registry holds both the codes the server produces and the codes the
 * Chrome extension produces. The extension's codes are here because the server
 * forwards an extension failure to the agent unchanged: a code the server does
 * not know would be rewritten as INTERNAL_ERROR and the agent would lose the
 * diagnosis the extension gave it.
 *
 * Codes are written as `KEY: 'KEY'` so the key and the value can never drift:
 * the value is the code that goes on the wire.
 */

/** The codes the MCP server produces. */
const SERVER_CODES = {
  ACTION_BLOCKED: 'ACTION_BLOCKED',
  ACTION_NOT_CONFIRMED: 'ACTION_NOT_CONFIRMED',
  BROWSER_BUSY: 'BROWSER_BUSY',
  CLIENT_CONFIRMATION_UNAVAILABLE: 'CLIENT_CONFIRMATION_UNAVAILABLE',
  EXPECTATION_FAILED: 'EXPECTATION_FAILED',
  EXPECTATION_UNAVAILABLE: 'EXPECTATION_UNAVAILABLE',
  FILE_NOT_ALLOWED: 'FILE_NOT_ALLOWED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  MAP_UNAVAILABLE: 'MAP_UNAVAILABLE',
  MAP_DISABLED: 'MAP_DISABLED',
  MEMORY_CORRUPT: 'MEMORY_CORRUPT',
  MEMORY_DISABLED: 'MEMORY_DISABLED',
  MEMORY_EXCLUDED: 'MEMORY_EXCLUDED',
  MEMORY_FULL: 'MEMORY_FULL',
  MEMORY_NOT_SUPPORTED: 'MEMORY_NOT_SUPPORTED',
  MEMORY_QUEUE_FULL: 'MEMORY_QUEUE_FULL',
  MEMORY_SCOPE_UNKNOWN: 'MEMORY_SCOPE_UNKNOWN',
  MEMORY_UNAVAILABLE: 'MEMORY_UNAVAILABLE',
  NOT_CONNECTED: 'NOT_CONNECTED',
  OBSERVATION_FAILED: 'OBSERVATION_FAILED',
  RATE_LIMITED: 'RATE_LIMITED',
  READ_ONLY: 'READ_ONLY',
  RESPONSE_TOO_LARGE: 'RESPONSE_TOO_LARGE',
  SAFETY_CHECK_FAILED: 'SAFETY_CHECK_FAILED',
  SAFETY_TARGET_CHANGED: 'SAFETY_TARGET_CHANGED',
  STEP_FAILED: 'STEP_FAILED',
  TAB_NOT_OWNED: 'TAB_NOT_OWNED',
  TIMEOUT: 'TIMEOUT',
  UNKNOWN_TOOL: 'UNKNOWN_TOOL',
  VAULT_APPROVAL_PENDING: 'VAULT_APPROVAL_PENDING',
  VAULT_BUSY: 'VAULT_BUSY',
  VAULT_CONTEXT_PROTECTED: 'VAULT_CONTEXT_PROTECTED',
  VAULT_DECLINED: 'VAULT_DECLINED',
  VAULT_DOCUMENT_CHANGED: 'VAULT_DOCUMENT_CHANGED',
  VAULT_EXTENSION_REQUIRED: 'VAULT_EXTENSION_REQUIRED',
  VAULT_KEY_MISSING: 'VAULT_KEY_MISSING',
  VAULT_LOCKED: 'VAULT_LOCKED',
  VAULT_ORIGIN_MISMATCH: 'VAULT_ORIGIN_MISMATCH',
  VAULT_ORIGIN_UNSUPPORTED: 'VAULT_ORIGIN_UNSUPPORTED',
  VAULT_OUTCOME_UNKNOWN: 'VAULT_OUTCOME_UNKNOWN',
  VAULT_PAGE_UNRESPONSIVE: 'VAULT_PAGE_UNRESPONSIVE',
  VAULT_PERMISSION_DENIED: 'VAULT_PERMISSION_DENIED',
  VAULT_RECOVERY_REQUIRED: 'VAULT_RECOVERY_REQUIRED',
  VAULT_REQUEST_EXPIRED: 'VAULT_REQUEST_EXPIRED',
  VAULT_STORAGE_INVALID: 'VAULT_STORAGE_INVALID',
  VAULT_TARGET_UNSAFE: 'VAULT_TARGET_UNSAFE',
  VAULT_USER_ACTION_REQUIRED: 'VAULT_USER_ACTION_REQUIRED',
} as const;

/** The codes the Chrome extension sends, which the server passes through unchanged. */
const EXTENSION_CODES = {
  AMBIGUOUS: 'AMBIGUOUS',
  CLICK_MISSED: 'CLICK_MISSED',
  DEBUGGER_UNAVAILABLE: 'DEBUGGER_UNAVAILABLE',
  DIALOG_OPEN: 'DIALOG_OPEN',
  ELEMENT_COVERED: 'ELEMENT_COVERED',
  ELEMENT_DISABLED: 'ELEMENT_DISABLED',
  ELEMENT_HIDDEN: 'ELEMENT_HIDDEN',
  ELEMENT_READONLY: 'ELEMENT_READONLY',
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  FILL_FAILED: 'FILL_FAILED',
  INCOGNITO_NOT_ALLOWED: 'INCOGNITO_NOT_ALLOWED',
  INPUT_BLOCKED: 'INPUT_BLOCKED',
  INVALID_SELECTOR: 'INVALID_SELECTOR',
  MISMATCH: 'MISMATCH',
  NAVIGATION_FAILED: 'NAVIGATION_FAILED',
  NOT_FOUND: 'NOT_FOUND',
  NOT_SCROLLABLE: 'NOT_SCROLLABLE',
  NO_DIALOG: 'NO_DIALOG',
  NO_FOCUS: 'NO_FOCUS',
  NO_HISTORY_ENTRY: 'NO_HISTORY_ENTRY',
  NO_WINDOW: 'NO_WINDOW',
  OPTION_NOT_FOUND: 'OPTION_NOT_FOUND',
  REF_GONE: 'REF_GONE',
  REF_NOT_FOUND: 'REF_NOT_FOUND',
  SCRIPT_ERROR: 'SCRIPT_ERROR',
  STATE_UNAVAILABLE: 'STATE_UNAVAILABLE',
  TAB_LOCKED: 'TAB_LOCKED',
  TAB_NOT_FOUND: 'TAB_NOT_FOUND',
  TAB_REPLACED: 'TAB_REPLACED',
  TAB_WEDGED: 'TAB_WEDGED',
  TARGET_OFFSCREEN: 'TARGET_OFFSCREEN',
  UNKNOWN_KEY: 'UNKNOWN_KEY',
  VALUE_NOT_SET: 'VALUE_NOT_SET',
} as const;

/**
 * Every error code this product speaks, keyed by itself. Frozen so no module
 * can add a code at runtime: the vocabulary is fixed at build time.
 */
export const ERROR_CODES = Object.freeze({ ...SERVER_CODES, ...EXTENSION_CODES });

/** One registered error code. */
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

const KNOWN_CODES: ReadonlySet<string> = new Set(Object.values(ERROR_CODES));

/**
 * The `CODE: message` line of a failure.
 *
 * The text is byte for byte what the wire carried before: the code, one
 * space, the message. Nothing else changes.
 */
export function formatError(code: ErrorCode, message: string): string {
  return `${code}: ${message}`;
}

/** Is this a code the product knows? A code that is not registered is a typo. */
export function isKnownErrorCode(value: string): value is ErrorCode {
  return KNOWN_CODES.has(value);
}

/**
 * Does this text start with a registered code?
 *
 * The old check only looked at the shape of the line, so `TAB_OWNED: x` was
 * accepted like any other failure. Now a failure that names a code nobody
 * registered is not a coded message at all.
 */
export function isCodedMessage(text: string): boolean {
  const separator = text.indexOf(': ');
  if (separator <= 0) return false;
  return KNOWN_CODES.has(text.slice(0, separator));
}
