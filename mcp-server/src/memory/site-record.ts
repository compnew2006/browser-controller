/** The stored shape of a site record and its validation. Used by the store and, through it, by the queue. */
import {
  ALLOWLIST,
  matchControlName,
  matchPath,
  matchSearchName,
  primaryLanguage,
  shapePath,
  type FactKind,
  type FactValue,
} from './allowlist.js';
import { canonicalOrigin } from './policy.js';
import { isRecord } from './guards.js';

export const SITE_SCHEMA_VERSION = 1;
export const MAX_FACTS = 64;
export const MAX_PROFILES = 16;
export const MAX_VERIFICATIONS = 64;
export const MAX_SITE_BYTES = 64 * 1024;
export const MAX_ORIGINS = 5_000;
export const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_FACT_ID = 120;
const MAX_PATH = 120;
const FACT_ID = /^(?:site\.language|ui\.search|ui\.login|ui\.control:[a-z]+:.+|ui\.form\.shape:.+)$/u;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;
const FACT_KINDS: readonly string[] = ['site.language', 'ui.search', 'ui.login', 'ui.control', 'ui.form.shape'];
const TOOLS: readonly string[] = ['browser_snapshot', 'browser_navigate'];
const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

export type MemoryStoreErrorCode = 'MEMORY_CORRUPT' | 'MEMORY_FULL' | 'MEMORY_UNAVAILABLE' | 'INVALID_ARGUMENT';

export class MemoryStoreError extends Error {
  readonly code: MemoryStoreErrorCode;

  constructor(code: MemoryStoreErrorCode, message: string) {
    super(message);
    this.name = 'MemoryStoreError';
    this.code = code;
  }
}

export interface SiteFact {
  factId: string;
  kind: FactKind;
  value: FactValue;
  firstObserved: string;
  lastObserved: string;
  status: 'current';
}

export interface ProfileVisit {
  firstAt: string;
  lastAt: string;
  count: number;
}

export interface ProfileVerification {
  at: string;
  tool: 'browser_snapshot' | 'browser_navigate';
  /** Only a path whose every segment is on the reviewed path allowlist; absent otherwise. */
  path?: string;
}

export interface ProfileSiteState {
  visit?: ProfileVisit | null;
  verifications?: Record<string, ProfileVerification>;
  /** How many actions this profile saw fail on a control it could not reach (007). It holds no part of the failure. */
  hidden?: ProfileHidden;
}

/** The hidden-control counter of one profile on one origin. */
export interface ProfileHidden {
  count: number;
}

/** `memory/sites/<sha256(origin)>.json`. */
export interface SiteRecord {
  schemaVersion: 1;
  origin: string;
  facts: SiteFact[];
  profiles: Record<string, ProfileSiteState>;
  commitSeq: number;
  updatedAt: string;
}

type Mode = 'read' | 'write';

function bad(mode: Mode, message: string): MemoryStoreError {
  return new MemoryStoreError(mode === 'read' ? 'MEMORY_CORRUPT' : 'INVALID_ARGUMENT', message);
}

function full(mode: Mode, message: string): MemoryStoreError {
  return new MemoryStoreError(mode === 'read' ? 'MEMORY_CORRUPT' : 'MEMORY_FULL', message);
}

function isTime(value: unknown): value is string {
  return typeof value === 'string' && ISO_UTC.test(value) && Number.isFinite(Date.parse(value));
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], mode: Mode, label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw bad(mode, `${label} has an unknown field`);
  }
}

function validateFactValue(fact: SiteFact, mode: Mode): void {
  const value = fact.value as unknown;
  if (!isRecord(value) || Object.keys(value).length > 2) throw bad(mode, 'fact.value is not a small object');
  // A stored string must equal an allowlist entry, on write and again on read (a file edited on disk, a restored backup).
  const strict = (ok: boolean): void => {
    if (!ok) throw bad(mode, `fact ${fact.kind} holds a value outside the allowlist`);
  };
  switch (fact.kind) {
    case 'site.language':
      onlyKeys(value, ['lang', 'dir'], mode, 'site.language');
      strict(fact.factId === 'site.language' && typeof value.lang === 'string' && primaryLanguage(value.lang) === value.lang);
      strict(value.dir === 'ltr' || value.dir === 'rtl' || value.dir === null);
      return;
    case 'ui.search':
      onlyKeys(value, ['role', 'name'], mode, 'ui.search');
      strict(fact.factId === 'ui.search' && (ALLOWLIST.searchRoles as readonly string[]).includes(value.role as string));
      strict(typeof value.name === 'string' && matchSearchName(value.name) === value.name);
      return;
    case 'ui.login':
      onlyKeys(value, ['path'], mode, 'ui.login');
      strict(fact.factId === 'ui.login');
      strict(value.path === null || (typeof value.path === 'string' && matchPath(value.path) === value.path));
      return;
    case 'ui.control':
      onlyKeys(value, ['role', 'name'], mode, 'ui.control');
      strict((ALLOWLIST.controlRoles as readonly string[]).includes(value.role as string));
      strict(typeof value.name === 'string' && matchControlName(value.name) === value.name);
      strict(fact.factId === `ui.control:${String(value.role)}:${String(value.name)}`);
      return;
    case 'ui.form.shape': {
      onlyKeys(value, ['shape', 'commit'], mode, 'ui.form.shape');
      const identity = fact.factId.slice('ui.form.shape:'.length);
      strict(shapePath(identity) === identity);
      const shape = value.shape;
      if (!isRecord(shape)) throw bad(mode, 'ui.form.shape holds no shape');
      onlyKeys(shape, ['fields', 'required', 'types', 'hidden'], mode, 'ui.form.shape.shape');
      strict(typeof shape.fields === 'number' && Number.isInteger(shape.fields) && shape.fields >= 0 && shape.fields <= 64);
      strict(typeof shape.required === 'number' && Number.isInteger(shape.required) && shape.required >= 0 && shape.required <= Number(shape.fields));
      const types = shape.types;
      if (!Array.isArray(types)) throw bad(mode, 'ui.form.shape holds no field types');
      strict(types.length <= ALLOWLIST.formShapeLimits.typesPerShape);
      strict(types.every((type: unknown) => (ALLOWLIST.fieldTypes as readonly string[]).includes(type as string)));
      strict(new Set(types).size === types.length);
      strict(shape.hidden === true || shape.hidden === false);
      strict((ALLOWLIST.commitModes as readonly string[]).includes(value.commit as string));
      return;
    }
    default:
      throw bad(mode, 'unknown fact kind');
  }
}

function validateFact(raw: unknown, mode: Mode): SiteFact {
  if (!isRecord(raw)) throw bad(mode, 'fact is not an object');
  onlyKeys(raw, ['factId', 'kind', 'value', 'firstObserved', 'lastObserved', 'status'], mode, 'fact');
  const { factId, kind } = raw;
  if (typeof factId !== 'string' || factId.length > MAX_FACT_ID || !FACT_ID.test(factId)) throw bad(mode, 'fact.factId is invalid');
  if (typeof kind !== 'string' || !FACT_KINDS.includes(kind)) throw bad(mode, 'fact.kind is invalid');
  if (factId !== kind && !factId.startsWith(`${kind}:`)) throw bad(mode, 'fact.factId does not match fact.kind');
  if (!isTime(raw.firstObserved) || !isTime(raw.lastObserved)) throw bad(mode, 'fact times are not UTC times');
  if (raw.status !== 'current') throw bad(mode, 'fact.status is not current');
  const fact: SiteFact = {
    factId,
    kind: kind as FactKind,
    value: raw.value as FactValue,
    firstObserved: raw.firstObserved,
    lastObserved: raw.lastObserved,
    status: 'current',
  };
  validateFactValue(fact, mode);
  return fact;
}

function validateProfile(raw: unknown, mode: Mode): ProfileSiteState {
  if (!isRecord(raw)) throw bad(mode, 'profile state is not an object');
  onlyKeys(raw, ['visit', 'verifications', 'hidden'], mode, 'profile state');
  const state: ProfileSiteState = {};
  if (raw.visit !== undefined) {
    if (raw.visit === null) {
      state.visit = null;
    } else {
      const visit = raw.visit;
      if (!isRecord(visit)) throw bad(mode, 'profile.visit is not an object');
      onlyKeys(visit, ['firstAt', 'lastAt', 'count'], mode, 'profile.visit');
      if (!isTime(visit.firstAt) || !isTime(visit.lastAt)) throw bad(mode, 'profile.visit times are not UTC times');
      if (!Number.isInteger(visit.count) || (visit.count as number) < 1) throw bad(mode, 'profile.visit.count is invalid');
      state.visit = { firstAt: visit.firstAt, lastAt: visit.lastAt, count: visit.count as number };
    }
  }
  if (raw.verifications !== undefined) {
    if (!isRecord(raw.verifications)) throw bad(mode, 'profile.verifications is not an object');
    const entries = Object.entries(raw.verifications);
    if (entries.length > MAX_VERIFICATIONS) throw full(mode, `a profile holds at most ${MAX_VERIFICATIONS} verifications`);
    const verifications: Record<string, ProfileVerification> = {};
    for (const [key, entry] of entries) {
      if (UNSAFE_KEYS.has(key) || key.length > MAX_FACT_ID || !FACT_ID.test(key)) throw bad(mode, 'verification key is not a fact id');
      if (!isRecord(entry)) throw bad(mode, 'verification is not an object');
      onlyKeys(entry, ['at', 'tool', 'path'], mode, 'verification');
      if (!isTime(entry.at)) throw bad(mode, 'verification.at is not a UTC time');
      if (typeof entry.tool !== 'string' || !TOOLS.includes(entry.tool)) throw bad(mode, 'verification.tool is invalid');
      const verification: ProfileVerification = { at: entry.at, tool: entry.tool as ProfileVerification['tool'] };
      if (entry.path !== undefined) {
        if (typeof entry.path !== 'string' || entry.path.length > MAX_PATH || matchPath(entry.path) !== entry.path) {
          throw bad(mode, 'verification.path is outside the allowlist');
        }
        verification.path = entry.path;
      }
      verifications[key] = verification;
    }
    state.verifications = verifications;
  }
  if (raw.hidden !== undefined) {
    const hidden = raw.hidden;
    if (!isRecord(hidden)) throw bad(mode, 'profile.hidden is not an object');
    onlyKeys(hidden, ['count'], mode, 'profile.hidden');
    if (!Number.isInteger(hidden.count) || (hidden.count as number) < 1 || (hidden.count as number) > ALLOWLIST.formShapeLimits.occurrenceCountMax) {
      throw bad(mode, 'profile.hidden.count is invalid');
    }
    state.hidden = { count: hidden.count as number };
  }
  return state;
}

/** Validate and copy a record. `read` failures are MEMORY_CORRUPT; `write` failures are INVALID_ARGUMENT or MEMORY_FULL. */
export function validateSiteRecord(raw: unknown, mode: Mode): SiteRecord {
  if (!isRecord(raw)) throw bad(mode, 'site record is not an object');
  if (raw.schemaVersion !== SITE_SCHEMA_VERSION) throw bad(mode, 'unknown site schemaVersion');
  onlyKeys(raw, ['schemaVersion', 'origin', 'facts', 'profiles', 'commitSeq', 'updatedAt'], mode, 'site record');
  if (typeof raw.origin !== 'string' || raw.origin.length > 300 || canonicalOrigin(raw.origin) !== raw.origin) {
    throw bad(mode, 'site.origin is not a canonical http(s) origin');
  }
  if (!Number.isInteger(raw.commitSeq) || (raw.commitSeq as number) < 1) throw bad(mode, 'site.commitSeq is invalid');
  if (!isTime(raw.updatedAt)) throw bad(mode, 'site.updatedAt is not a UTC time');
  if (!Array.isArray(raw.facts)) throw bad(mode, 'site.facts is not an array');
  if (!isRecord(raw.profiles)) throw bad(mode, 'site.profiles is not an object');
  if (raw.facts.length > MAX_FACTS) throw full(mode, `a site holds at most ${MAX_FACTS} facts`);
  // At most 8 shape facts per site (007, FR-004): the site's own bound for the new kind.
  const shapeFacts = raw.facts.filter((fact) => isRecord(fact) && fact.kind === 'ui.form.shape').length;
  if (shapeFacts > ALLOWLIST.formShapeLimits.shapeFactsPerSite) {
    throw full(mode, `a site holds at most ${ALLOWLIST.formShapeLimits.shapeFactsPerSite} shape facts`);
  }
  const profileEntries = Object.entries(raw.profiles);
  if (profileEntries.length > MAX_PROFILES) throw full(mode, `a site holds at most ${MAX_PROFILES} profiles`);

  const facts = raw.facts.map((fact) => validateFact(fact, mode));
  if (new Set(facts.map((fact) => fact.factId)).size !== facts.length) throw bad(mode, 'site.facts holds a duplicate factId');
  const profiles: Record<string, ProfileSiteState> = {};
  for (const [id, state] of profileEntries) {
    if (UNSAFE_KEYS.has(id) || id === '' || id.length > 200) throw bad(mode, 'profile id is invalid');
    profiles[id] = validateProfile(state, mode);
  }
  return { schemaVersion: SITE_SCHEMA_VERSION, origin: raw.origin, facts, profiles, commitSeq: raw.commitSeq as number, updatedAt: raw.updatedAt };
}
