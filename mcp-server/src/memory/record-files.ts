/**
 * The file helpers the memory stores share now live in the JSON-store engine
 * (`core/json-store.ts`); this module keeps the old import path working and
 * holds the memory store's own permission rule.
 */
import type fs from 'node:fs';
import { assertOwnerOnly, type OwnerModePolicy } from '../core/json-store.js';
import { MemoryStoreError } from './site-record.js';
import { ERROR_CODES } from '../core/error-codes.js';

export { errorCode, quarantineName, removeTemps } from '../core/json-store.js';

/** The memory store's rule: a plain file or directory of this user, with no access for others. */
function privateRule(platform: NodeJS.Platform): OwnerModePolicy {
  return {
    fail: (message) => new MemoryStoreError(ERROR_CODES.MEMORY_UNAVAILABLE, message),
    notRegular: (kind) => `memory ${kind} is not a regular ${kind}`,
    foreignOwner: (kind) => `memory ${kind} is owned by another user`,
    openPermissions: (kind) => `memory ${kind} permissions allow other users`,
    // win32 has no comparable mode bits, so the rule cannot be checked there.
    checkOwner: platform !== 'win32',
  };
}

/** The POSIX owner and mode-bit check; win32 has no comparable mode bits, so it is skipped there. */
export function assertPrivate(st: fs.Stats, kind: 'directory' | 'file', platform: NodeJS.Platform): void {
  assertOwnerOnly(st, kind, privateRule(platform));
}
