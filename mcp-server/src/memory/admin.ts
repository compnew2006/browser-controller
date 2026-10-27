import { parseMemoryAdminRequest, type MemoryAdminRequest, type MemoryAdminResult, type MemoryAdminStatus } from '../daemon-config.js';
import {
  MemoryPolicyError,
  canonicalOrigin,
  disablePolicy,
  enablePolicy,
  excludeOrigin,
  includeOrigin,
  recordDeletion,
  type MemoryPolicy,
} from './policy.js';
import type { MemoryQueue } from './queue.js';
import { MemoryStoreError, type MemoryStore } from './store.js';

/** What the owner commands need from the service: the one policy writer, the store, the queue and a clock. */
export interface AdminContext {
  iso(): string;
  store: MemoryStore;
  queue: MemoryQueue;
  mutatePolicy(change: (policy: MemoryPolicy) => MemoryPolicy): Promise<MemoryPolicy>;
  status(): Promise<MemoryAdminStatus>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export function errorCode(error: unknown): string {
  return error instanceof MemoryPolicyError || error instanceof MemoryStoreError ? error.code : 'MEMORY_UNAVAILABLE';
}

/** Validates an untrusted `memory-admin` line, then runs it. Always answers; never throws. */
export async function adminFromWire(context: AdminContext, raw: unknown): Promise<MemoryAdminResult> {
  const parsed = parseMemoryAdminRequest(raw);
  if (!parsed.ok) {
    const id = isRecord(raw) && typeof raw.id === 'string' ? raw.id.slice(0, 64) : '';
    return { kind: 'memory-admin-result', id, success: false, error: parsed.error };
  }
  return runAdminCommand(context, parsed.request);
}

/**
 * The owner commands (contracts/memory-admin-ipc.schema.json). A command answers only after the policy change
 * is on disk and the write that was in flight has finished, so no capture for an affected origin lands after
 * the answer. `delete` writes its tombstone first (R-17); `delete --all` uses the key `"*"`.
 */
export async function runAdminCommand(context: AdminContext, request: MemoryAdminRequest): Promise<MemoryAdminResult> {
  const { id } = request;
  const done = (extra: Partial<MemoryAdminResult> = {}): MemoryAdminResult => ({ kind: 'memory-admin-result', id, success: true, ...extra });
  try {
    const origin = request.origin === undefined ? null : canonicalOrigin(request.origin);
    if (request.origin !== undefined && origin === null) throw new MemoryPolicyError('INVALID_ARGUMENT', 'origin must be an http or https origin');
    const at = context.iso();
    switch (request.command) {
      case 'status':
        return done({ status: await context.status() });
      case 'enable':
        await context.mutatePolicy((policy) => enablePolicy(policy, at));
        return done({ status: await context.status() });
      case 'disable':
        await context.mutatePolicy((policy) => disablePolicy(policy, at));
        context.queue.dropPending('disabled');
        await context.queue.drain();
        return done({ status: await context.status() });
      case 'exclude':
        await context.mutatePolicy((policy) => excludeOrigin(policy, origin as string, at));
        context.queue.dropPending('excluded', (op) => op.origin === origin);
        await context.queue.drain();
        return done({ status: await context.status() });
      case 'include':
        await context.mutatePolicy((policy) => includeOrigin(policy, origin as string, at));
        return done({ status: await context.status() });
      case 'inspect': {
        const site = await context.store.getSite(origin as string);
        return done({ records: site ? [site] : [] });
      }
      case 'export':
        return done({ records: await context.store.listSites() });
      case 'delete': {
        const key = request.all === true ? '*' : (origin as string);
        await context.mutatePolicy((policy) => recordDeletion(policy, key, at));
        context.queue.dropPending('deleted', (op) => key === '*' || op.origin === key);
        await context.queue.drain();
        if (key === '*') await context.store.deleteAll();
        else await context.store.deleteSite(key);
        return done({ status: await context.status() });
      }
    }
  } catch (error) {
    const code = errorCode(error);
    const message = error instanceof MemoryPolicyError || error instanceof MemoryStoreError ? error.message : 'memory operation failed';
    return { kind: 'memory-admin-result', id, success: false, error: `${code}: ${message}` };
  }
}
