import { canonicalOrigin, MAX_EXCLUDED_ORIGINS, type MemoryPolicy } from './policy.js';

/** Pure policy state only: callers must enforce owner approval and persist it safely. */
export interface KnowledgePolicy {
  enabled: boolean;
  excluded: readonly string[];
  generation: number;
}

export type KnowledgePolicyChange =
  | { action: 'enable' | 'disable' }
  | { action: 'exclude' | 'include'; origin: string };

function requireOrigin(origin: string): void {
  if (canonicalOrigin(origin) !== origin) throw new Error('Invalid site knowledge origin');
}

export function defaultKnowledgePolicy(): KnowledgePolicy {
  return { enabled: false, excluded: [], generation: 0 };
}

/** This function does not itself authorize the action. Do not expose it to agents. */
export function transitionKnowledgePolicy(policy: KnowledgePolicy, change: KnowledgePolicyChange): KnowledgePolicy {
  if (!change || !['enable', 'disable', 'exclude', 'include'].includes(change.action)) {
    throw new Error('Invalid site knowledge policy action');
  }
  if (!Number.isSafeInteger(policy.generation) || policy.generation < 0 || policy.generation === Number.MAX_SAFE_INTEGER) {
    throw new Error('Invalid site knowledge policy generation');
  }
  if ('origin' in change) requireOrigin(change.origin);
  let excluded = [...policy.excluded];
  if (change.action === 'exclude' && !excluded.includes(change.origin)) {
    if (excluded.length >= MAX_EXCLUDED_ORIGINS) throw new Error('Site knowledge policy limit reached');
    excluded.push(change.origin);
  } else if (change.action === 'include') {
    excluded = excluded.filter((origin) => origin !== change.origin);
  }
  return {
    enabled: change.action === 'enable' ? true : change.action === 'disable' ? false : policy.enabled,
    excluded,
    generation: policy.generation + 1,
  };
}

/** Both the current website-memory policy and the knowledge policy must permit access. */
export function permitsKnowledge(policy: KnowledgePolicy, existing: MemoryPolicy, origin: string): boolean {
  if (canonicalOrigin(origin) !== origin) return false;
  return policy.enabled && existing.enabled && !policy.excluded.includes(origin) && !existing.excluded.includes(origin);
}
