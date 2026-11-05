/** Scope for site knowledge, derived from the trusted session and site context. */
import { decideScope, MEMORY_SCOPE_UNKNOWN, type ScopeInput } from './scope.js';

export interface KnowledgeScopeInput extends ScopeInput {
  sessionIdBefore: string | undefined;
  sessionIdAfter: string | undefined;
  /** Canonical origin captured before the operation from the trusted context. */
  originBefore: string | undefined;
}

export type KnowledgeScopeDecision =
  | { in: true; scope: { browserId: string; origin: string; connectionId: string; sessionId: string } }
  | Exclude<ReturnType<typeof decideScope>, { in: true }>
  | { in: false; outcome: 'unknown'; code: typeof MEMORY_SCOPE_UNKNOWN; reason: 'session_changed' | 'origin_changed' };

export function decideKnowledgeScope(input: KnowledgeScopeInput): KnowledgeScopeDecision {
  if (!input.sessionIdBefore || input.sessionIdBefore !== input.sessionIdAfter) {
    return { in: false, outcome: 'unknown', code: MEMORY_SCOPE_UNKNOWN, reason: 'session_changed' };
  }
  const decision = decideScope(input);
  if (!decision.in) return decision;
  if (!input.originBefore || input.originBefore !== decision.scope.origin) {
    return { in: false, outcome: 'unknown', code: MEMORY_SCOPE_UNKNOWN, reason: 'origin_changed' };
  }
  return {
    in: true,
    scope: {
      browserId: decision.scope.browserId,
      origin: decision.scope.origin,
      connectionId: input.connectionIdBefore!,
      sessionId: input.sessionIdBefore,
    },
  };
}
