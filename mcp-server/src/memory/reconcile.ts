import { matchPath } from './allowlist.js';
import type { CaptureOp } from './queue.js';
import {
  MAX_FACTS,
  MAX_PROFILES,
  MemoryStoreError,
  SITE_SCHEMA_VERSION,
  type ProfileSiteState,
  type ProfileVerification,
  type SiteFact,
  type SiteRecord,
} from './store.js';

const MAX_PATH = 120;
const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** A verification keeps a path only when every segment is on the reviewed path allowlist; the stored form is the normalized one. */
function storablePath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_PATH) return null;
  return matchPath(value);
}

/** A fact value as a string with sorted keys, so equal values compare equal. */
export function canonicalValue(value: unknown): string {
  return JSON.stringify(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
}

function sameValue(a: unknown, b: unknown): boolean {
  return canonicalValue(a) === canonicalValue(b);
}

export function later(a: string, b: string): string {
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

export function earlier(a: string, b: string): string {
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

/**
 * Reconcile one operation into a site record (R-10). Pure: the input record is
 * not changed. Throws MEMORY_FULL when the result would exceed the fact or
 * profile cap, so a rejected operation leaves no partial state.
 *
 * - Same identity and value: refresh `lastObserved`, keep `firstObserved`.
 * - Same identity, new value: the new value replaces the old one with fresh
 *   provenance, unless it is strictly older than the current observation.
 *   Equal times resolve by commit order.
 * - A verification keeps its path only when every segment is on the path
 *   allowlist (F-02); otherwise it records the time and tool alone.
 * - A folded operation (`firstAt`, `count`) gives the same result as applying
 *   the operations it stands for one by one, except when its earliest
 *   observation predates the value it replaces: then the new value's
 *   `firstObserved` is the replaced value's `lastObserved`.
 */
export function applyOp(record: SiteRecord | null, op: CaptureOp, now: string): SiteRecord {
  if (record && record.origin !== op.origin) throw new MemoryStoreError('INVALID_ARGUMENT', 'operation origin does not match the record');
  if (UNSAFE_KEYS.has(op.profileId) || op.profileId === '') throw new MemoryStoreError('INVALID_ARGUMENT', 'profile id is invalid');
  const next: SiteRecord = record
    ? structuredClone(record)
    : { schemaVersion: SITE_SCHEMA_VERSION, origin: op.origin, facts: [], profiles: {}, commitSeq: 0, updatedAt: now };

  const profile = (): ProfileSiteState => {
    if (!Object.hasOwn(next.profiles, op.profileId)) {
      if (Object.keys(next.profiles).length >= MAX_PROFILES) throw new MemoryStoreError('MEMORY_FULL', `a site holds at most ${MAX_PROFILES} profiles`);
      next.profiles[op.profileId] = {};
    }
    return next.profiles[op.profileId];
  };

  if (op.type === 'visit') {
    const state = profile();
    const firstAt = op.firstAt ?? op.at;
    const visits = op.count ?? 1;
    state.visit = state.visit
      ? { firstAt: earlier(state.visit.firstAt, firstAt), lastAt: later(state.visit.lastAt, op.at), count: state.visit.count + visits }
      : { firstAt, lastAt: op.at, count: visits };
  } else {
    const verify = op.tool !== undefined;
    const safePath = storablePath(op.path);
    const firstAt = op.firstAt ?? op.at;
    for (const candidate of op.facts) {
      const current = next.facts.find((entry) => entry.factId === candidate.factId);
      let applied = true;
      if (!current) {
        if (next.facts.length >= MAX_FACTS) throw new MemoryStoreError('MEMORY_FULL', `a site holds at most ${MAX_FACTS} facts`);
        const created: SiteFact = {
          factId: candidate.factId,
          kind: candidate.kind,
          value: candidate.value,
          firstObserved: firstAt,
          lastObserved: op.at,
          status: 'current',
        };
        next.facts.push(created);
      } else if (sameValue(current.value, candidate.value)) {
        current.firstObserved = earlier(current.firstObserved, firstAt);
        current.lastObserved = later(current.lastObserved, op.at);
      } else if (Date.parse(op.at) >= Date.parse(current.lastObserved)) {
        // For a folded operation the new value starts no earlier than the observation it replaces.
        current.firstObserved = later(firstAt, current.lastObserved);
        current.value = candidate.value;
        current.lastObserved = op.at;
      } else {
        applied = false;
      }
      if (applied && verify) {
        const verifications = (profile().verifications ??= {});
        const existing = Object.hasOwn(verifications, candidate.factId) ? verifications[candidate.factId] : undefined;
        if (!existing || Date.parse(existing.at) <= Date.parse(op.at)) {
          verifications[candidate.factId] = { at: op.at, tool: op.tool as ProfileVerification['tool'], ...(safePath ? { path: safePath } : {}) };
        }
      }
    }
  }

  next.commitSeq = (record?.commitSeq ?? 0) + (op.count ?? 1);
  next.updatedAt = now;
  return next;
}
