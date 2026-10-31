import { ALLOWLIST, matchPath } from './allowlist.js';
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
import { ERROR_CODES } from '../core/error-codes.js';

const MAX_PATH = 120;
/** The hidden-control counter never grows past the reviewed cap (007). */
const MAX_HIDDEN_COUNT = ALLOWLIST.formShapeLimits.occurrenceCountMax;
/** At most 8 shape facts per site (007, FR-004). */
const MAX_SHAPE_FACTS = ALLOWLIST.formShapeLimits.shapeFactsPerSite;
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
 * - A site's shape facts are bounded at eight (007): the freshest shape wins,
 *   and the rest of the record is still written. The bound never refuses the
 *   record, because a refused record would lose this origin's other facts too.
 */
export function applyOp(record: SiteRecord | null, op: CaptureOp, now: string): SiteRecord {
  if (record && record.origin !== op.origin) throw new MemoryStoreError(ERROR_CODES.INVALID_ARGUMENT, 'operation origin does not match the record');
  if (UNSAFE_KEYS.has(op.profileId) || op.profileId === '') throw new MemoryStoreError(ERROR_CODES.INVALID_ARGUMENT, 'profile id is invalid');
  const next: SiteRecord = record
    ? structuredClone(record)
    : { schemaVersion: SITE_SCHEMA_VERSION, origin: op.origin, facts: [], profiles: {}, commitSeq: 0, updatedAt: now };

  const profile = (): ProfileSiteState => {
    if (!Object.hasOwn(next.profiles, op.profileId)) {
      if (Object.keys(next.profiles).length >= MAX_PROFILES) throw new MemoryStoreError(ERROR_CODES.MEMORY_FULL, `a site holds at most ${MAX_PROFILES} profiles`);
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
  } else if (op.type === 'hidden') {
    // The hidden-control counter: how many actions this profile saw fail on a control it could not reach.
    // It holds no part of the failure, and it is per profile: another profile's count never moves it.
    const state = profile();
    const count = op.count ?? 1;
    const total = (state.hidden?.count ?? 0) + count;
    state.hidden = { count: Math.min(total, MAX_HIDDEN_COUNT) };
  } else {
    const verify = op.tool !== undefined;
    const safePath = storablePath(op.path);
    const firstAt = op.firstAt ?? op.at;
    for (const candidate of op.facts) {
      const current = next.facts.find((entry) => entry.factId === candidate.factId);
      let applied = true;
      if (!current) {
        if (next.facts.length >= MAX_FACTS) throw new MemoryStoreError(ERROR_CODES.MEMORY_FULL, `a site holds at most ${MAX_FACTS} facts`);
        if (candidate.kind === 'ui.form.shape') {
          // At most 8 shape facts per site (007, FR-004). The bound is applied here, on the one fact that
          // exceeds it, and not by refusing the record: refusing the record would drop this origin's visits
          // and its other facts with it, and a site with many form paths would lose every write for good.
          // The freshest shape wins; a shape strictly older than all eight is not stored. A tie goes to the
          // shape that was just read, because that is the page the agent is looking at.
          const shapes = next.facts.filter((entry) => entry.kind === 'ui.form.shape');
          if (shapes.length >= MAX_SHAPE_FACTS) {
            const oldest = shapes.reduce((a, b) => (Date.parse(a.lastObserved) <= Date.parse(b.lastObserved) ? a : b));
            if (Date.parse(op.at) < Date.parse(oldest.lastObserved)) {
              applied = false;
            } else {
              next.facts.splice(next.facts.indexOf(oldest), 1);
              // A verification belongs to a fact that exists. The evicted shape takes its verifications with
              // it: left behind, they would grow past the per-profile cap on a site whose forms churn, and
              // the cap is checked on the whole record.
              for (const state of Object.values(next.profiles)) {
                if (state.verifications && Object.hasOwn(state.verifications, oldest.factId)) {
                  delete state.verifications[oldest.factId];
                }
              }
            }
          }
        }
        if (!applied) continue;
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
