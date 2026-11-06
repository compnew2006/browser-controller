import { parseMemoryAdminRequest, type MemoryAdminRequest, type MemoryAdminResult } from '../daemon-config.js';
import { adminFromWire, type AdminContext } from './admin.js';
import { runKnowledgeAwareAdmin } from './knowledge-legacy-deletion.js';
import { coordinateLegacyPolicy } from './knowledge-coordinator.js';

/**
 * The owner-facing admin path, with the site-knowledge gates around it.
 *
 * `MemoryService` owns the store, the queue and the policy writer; this module owns
 * the one thing the service should not have to remember: that a memory action the
 * owner runs can also have to wait for, or carry, a site-knowledge deletion. The
 * wiring stays here so the service keeps the pieces it actually owns.
 */

/**
 * The context the admin commands run on. A legacy policy change is serialized behind
 * the site-knowledge deletion state, so a delete and a policy flip cannot interleave.
 *
 * `parts` is the context as the service builds it; only `mutatePolicy` is wrapped.
 */
export function knowledgeAdminContext(memoryDir: string, parts: AdminContext): AdminContext {
  return {
    ...parts,
    mutatePolicy: (change, options) => coordinateLegacyPolicy(memoryDir, () => parts.mutatePolicy(change, options)),
  };
}

/** A validated owner request, run through the knowledge deletion path when the site has one. */
export function runKnowledgeAdminRequest(
  memoryDir: string,
  context: AdminContext,
  request: MemoryAdminRequest,
): Promise<MemoryAdminResult> {
  return runKnowledgeAwareAdmin(memoryDir, context, request);
}

/**
 * Validates an untrusted `memory-admin` line, then runs it. Always answers; never throws.
 *
 * A line that parses as a request takes the knowledge-aware path. A line that does not is
 * handed to the plain admin reader, which is the one that reports the parse failure.
 */
export function runKnowledgeAdminLine(memoryDir: string, context: AdminContext, raw: unknown): Promise<MemoryAdminResult> {
  const parsed = parseMemoryAdminRequest(raw);
  return parsed.ok
    ? runKnowledgeAwareAdmin(memoryDir, context, parsed.request)
    : adminFromWire(context, raw);
}
