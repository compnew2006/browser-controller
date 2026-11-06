import { isRecord } from '../core/guards.js';
import { SITE_CONTEXT_CAPABILITY } from '../protocol/capabilities.js';
import { decideKnowledgeScope } from './knowledge-scope.js';
import { permitsKnowledge, type KnowledgePolicy } from './knowledge-policy.js';
import { canonicalOrigin, type MemoryPolicy } from './policy.js';
import { CONTEXT_ACTION, type MemoryToolBridge } from './tool-route.js';
import type { MemoryConnection } from './service.js';
import type { TrustedKnowledgeContext } from './knowledge-service.js';

export interface KnowledgeContextDependencies {
  memoryPolicy: () => MemoryPolicy;
  knowledgePolicy: (browserId: string) => Promise<KnowledgePolicy>;
  connection: (sessionId: string) => MemoryConnection;
  vaultEligibility: (browserId: string, tabId: number) => 'clear' | 'protected' | 'unknown';
  sessionLive: (sessionId: string) => boolean;
  /** Process-local generation that changes when either memory policy changes. */
  epoch: () => number;
  bridge: MemoryToolBridge;
}

export interface KnowledgeContextProviderDependencies extends KnowledgeContextDependencies {
  /** The same policy source, read without taking the coordinator lock already held by commit. */
  knowledgePolicyForCommit: (browserId: string) => Promise<KnowledgePolicy>;
}

/** Gives the service the correct policy read path for ordinary and commit-time context checks. */
export function createKnowledgeContextProvider(
  deps: KnowledgeContextProviderDependencies, sessionId: string, agentName: string, tabId: number, signal: AbortSignal,
): (phase: 'normal' | 'commit') => Promise<TrustedKnowledgeContext> {
  return (phase) => resolveKnowledgeContext({
    ...deps,
    knowledgePolicy: phase === 'commit' ? deps.knowledgePolicyForCommit : deps.knowledgePolicy,
  }, sessionId, agentName, tabId, signal);
}

/** Called by the daemon with its own session ID; agent arguments provide only the tab ID. */
export async function resolveKnowledgeContext(
  deps: KnowledgeContextDependencies, sessionId: string, agentName: string, tabId: number, signal: AbortSignal,
): Promise<TrustedKnowledgeContext> {
  try {
    const initialEpoch = deps.epoch();
    const initialMemory = deps.memoryPolicy();
    const initialMemoryFingerprint = JSON.stringify(initialMemory);
    if (!sessionId || /[\p{Cc}\p{Cf}]/u.test(sessionId) || !Number.isInteger(tabId) || tabId < 0
        || !Number.isSafeInteger(initialEpoch) || initialEpoch < 0
        || signal.aborted || !deps.sessionLive(sessionId) || !initialMemory.enabled) throw new Error();
    // Copy fields: a live connection object may mutate while the extension answers.
    const before = { ...deps.connection(sessionId) };
    if (!before.browserId || before.browserId === 'default' || before.ambiguous || !before.supportsSiteContext
        || !before.connectionId || deps.vaultEligibility(before.browserId, tabId) !== 'clear') throw new Error();
    const initialPolicy = await deps.knowledgePolicy(before.browserId);
    const initialGeneration = initialPolicy.generation;
    if (!initialPolicy.enabled || signal.aborted) throw new Error();
    const raw = await deps.bridge.callTool(CONTEXT_ACTION, { tabId }, sessionId, signal, agentName);
    const context = isRecord(raw) ? raw.siteContext : null;
    if (!isRecord(context) || typeof context.url !== 'string' || typeof context.incognito !== 'boolean'
        || typeof context.topLevel !== 'boolean' || typeof context.stable !== 'boolean') throw new Error();
    const origin = canonicalOrigin(context.url);
    const after = { ...deps.connection(sessionId) };
    const currentPolicy = await deps.knowledgePolicy(after.browserId);
    const existing = deps.memoryPolicy();
    if (!origin || signal.aborted || !deps.sessionLive(sessionId) || before.browserId !== after.browserId
        || before.connectionId !== after.connectionId || before.ambiguous || after.ambiguous
        || !after.supportsSiteContext || currentPolicy.generation !== initialGeneration
        || deps.epoch() !== initialEpoch || JSON.stringify(existing) !== initialMemoryFingerprint
        || !permitsKnowledge(currentPolicy, existing, origin)) throw new Error();
    const decision = decideKnowledgeScope({
      purpose: 'reminder', policy: existing, browserId: after.browserId,
      liveConnectionsForBrowserId: after.ambiguous ? 2 : 1,
      connectionIdBefore: before.connectionId, connectionIdAfter: after.connectionId,
      sessionIdBefore: sessionId, sessionIdAfter: deps.sessionLive(sessionId) ? sessionId : undefined,
      originBefore: origin, extensionCapabilities: [SITE_CONTEXT_CAPABILITY],
      vault: deps.vaultEligibility(after.browserId, tabId), sanitizedUnchanged: true,
      siteContext: {
        url: context.url, incognito: context.incognito, topLevel: context.topLevel, stable: context.stable,
        anonymous: context.anonymous === true ? true : context.anonymous === false ? false : null,
      },
    });
    if (!decision.in) throw new Error();
    return decision.scope;
  } catch {
    // Do not expose raw page data, connection details, or policy contents on a failure.
    throw new Error('Site knowledge scope unavailable');
  }
}
