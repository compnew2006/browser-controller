import { SITE_CONTEXT_CAPABILITY } from '../protocol.js';
import { canonicalOrigin, type MemoryPolicy } from './policy.js';

export const MEMORY_SCOPE_UNKNOWN = 'MEMORY_SCOPE_UNKNOWN';

export type ScopeUnknownReason =
  | 'default_browser_id'
  | 'duplicate_identity'
  | 'connection_changed'
  | 'no_site_context_capability'
  | 'no_site_context'
  | 'incognito'
  | 'vault_protected'
  | 'vault_unknown'
  | 'unstable'
  | 'not_top_level'
  | 'non_http_origin'
  | 'sanitized_changed';

/** The fields of the extension's `siteContext` block that the scope decision reads. */
export interface ScopeSiteContext {
  url: string;
  incognito: boolean;
  topLevel: boolean;
  stable: boolean;
  anonymous: boolean | null;
  anonymityReason?: string;
}

export interface ScopeInput {
  /** `capture` records visits and facts; `reminder` only reads, so a sanitized-result change does not matter. */
  purpose: 'capture' | 'reminder';
  policy: MemoryPolicy;
  /** The authenticated extension connection's id (R-04). Never an agent parameter. */
  browserId: string;
  /** Live connections that carry `browserId` (vault `hasUniqueIdentity`); exactly 1 is required. */
  liveConnectionsForBrowserId: number;
  connectionIdBefore: string | undefined;
  connectionIdAfter: string | undefined;
  extensionCapabilities: readonly string[];
  /** `memoryEligibility(browserId, tabId)` (R-06). */
  vault: 'clear' | 'protected' | 'unknown';
  siteContext: ScopeSiteContext | null;
  /** `observation.sanitizedUnchanged` from vault/daemon-routing.ts. */
  sanitizedUnchanged: boolean;
}

export interface Scope {
  browserId: string;
  /** `URL.origin` of an http(s) page: scheme, host and effective port. */
  origin: string;
  /** Path only. Userinfo, query and fragment are dropped here and never stored. */
  path: string;
  /** The extension's anonymity verdict; facts need `true`, a visit does not. */
  anonymous: boolean | null;
}

export type ScopeDecision =
  | { in: true; scope: Scope }
  | { in: false; outcome: 'disabled' | 'excluded'; reason: 'disabled' | 'excluded' }
  | { in: false; outcome: 'unknown'; code: typeof MEMORY_SCOPE_UNKNOWN; reason: ScopeUnknownReason };

function unknown(reason: ScopeUnknownReason): ScopeDecision {
  return { in: false, outcome: 'unknown', code: MEMORY_SCOPE_UNKNOWN, reason };
}

/**
 * Per-call scope decision (data-model.md "Scope decision", R-04..R-06). Pure: the caller supplies every fact.
 * Every missing or doubtful input fails closed to MEMORY_SCOPE_UNKNOWN; nothing here reads agent parameters.
 */
export function decideScope(input: ScopeInput): ScopeDecision {
  if (!input.policy.enabled) return { in: false, outcome: 'disabled', reason: 'disabled' };

  const { browserId } = input;
  if (!browserId || browserId === 'default') return unknown('default_browser_id');
  if (input.liveConnectionsForBrowserId !== 1) return unknown('duplicate_identity');
  if (!input.connectionIdBefore || input.connectionIdBefore !== input.connectionIdAfter) return unknown('connection_changed');
  if (!input.extensionCapabilities.includes(SITE_CONTEXT_CAPABILITY)) return unknown('no_site_context_capability');

  if (input.vault === 'protected') return unknown('vault_protected');
  if (input.vault !== 'clear') return unknown('vault_unknown');

  const context = input.siteContext;
  if (!context) return unknown('no_site_context');
  if (context.incognito) return unknown('incognito');
  if (!context.stable) return unknown('unstable');
  if (!context.topLevel) return unknown('not_top_level');

  const origin = canonicalOrigin(context.url);
  if (origin === null) return unknown('non_http_origin');
  if (input.purpose === 'capture' && !input.sanitizedUnchanged) return unknown('sanitized_changed');

  if (input.policy.excluded.includes(origin)) return { in: false, outcome: 'excluded', reason: 'excluded' };

  return { in: true, scope: { browserId, origin, path: new URL(context.url).pathname, anonymous: context.anonymous } };
}
