/**
 * The stored shape of one site map (one browser profile, one origin) and its validation
 * (specs/004-site-navigation-map data-model.md, contracts/map-store.schema.json).
 */
import crypto from 'node:crypto';
import { MAP_LIMITS, type MapArea, type MapRole } from './map-allowlist.js';
import { looksUnmasked } from './map-text.js';
import { canonicalOrigin } from './policy.js';
import { MemoryStoreError } from './site-record.js';
import { isRecord } from '../core/guards.js';
import { ERROR_CODES } from '../core/error-codes.js';

export const MAP_SCHEMA_VERSION = 1;
export const MAX_MAP_PAGES = MAP_LIMITS.pagesPerOrigin;
export const MAX_MAP_CONTROLS = MAP_LIMITS.controlsPerPage;
export const MAX_MAP_BYTES = MAP_LIMITS.mapFileBytes;
export const MAX_MAP_FILES_PER_PROFILE = MAP_LIMITS.mapFilesPerProfile;
export const MAX_MAP_TOTAL_BYTES = MAP_LIMITS.mapTotalBytes;
/** Entrances kept per map, newest first (specs/005-direct-site-routing FR-004). */
export const MAX_MAP_ENTRANCES = 5;

export type ReadContext = 'public' | 'not_public' | 'unknown';
export const READ_CONTEXTS: readonly ReadContext[] = ['public', 'not_public', 'unknown'];
export type LocatorFailure =
  | typeof ERROR_CODES.NOT_FOUND
  | typeof ERROR_CODES.AMBIGUOUS
  | typeof ERROR_CODES.ELEMENT_HIDDEN
  | typeof ERROR_CODES.ELEMENT_DISABLED
  | typeof ERROR_CODES.ELEMENT_COVERED
  | typeof ERROR_CODES.REF_GONE
  | typeof ERROR_CODES.REF_NOT_FOUND
  | typeof ERROR_CODES.CLICK_MISSED
  | typeof ERROR_CODES.MISMATCH;
export const LOCATOR_FAILURES: readonly LocatorFailure[] = [
  ERROR_CODES.NOT_FOUND,
  ERROR_CODES.AMBIGUOUS,
  ERROR_CODES.ELEMENT_HIDDEN,
  ERROR_CODES.ELEMENT_DISABLED,
  ERROR_CODES.ELEMENT_COVERED,
  ERROR_CODES.REF_GONE,
  ERROR_CODES.REF_NOT_FOUND,
  ERROR_CODES.CLICK_MISSED,
  ERROR_CODES.MISMATCH,
];
export type OpenResultKind = 'same' | 'elsewhere' | 'other_origin' | 'sign_in' | 'not_found' | 'error';

/** Exactly one of path, origin, opens or excluded. */
export interface Destination {
  path?: string;
  origin?: string;
  opens?: 'menu' | 'dialog';
  excluded?: true;
  at: string;
}

export interface UseResult {
  result: 'worked' | 'failed';
  code?: LocatorFailure;
  at: string;
}

export interface OpenResult {
  result: OpenResultKind;
  path?: string;
  origin?: string;
  statusClass?: '4xx' | '5xx';
  at: string;
}

export interface SeenState {
  lastSeenAt: string;
  /** False means not seen at the last complete read in that context. */
  atLastComplete: boolean;
}

export interface ControlEntry {
  key: string;
  area: MapArea;
  role: MapRole;
  name: string;
  nth: number | null;
  parent: string | null;
  lang: string | null;
  dataChanging: boolean;
  destinations: Partial<Record<ReadContext, Destination>>;
  seen: Partial<Record<ReadContext, SeenState>>;
  useCount: number;
  lastUse: UseResult | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface PageEntry {
  path: string;
  title: string | null;
  lang: string | null;
  dir: 'ltr' | 'rtl' | null;
  addressable: boolean;
  /** `read`: a complete read of the page itself (specs/005-direct-site-routing FR-001). */
  reason: 'root' | 'destination' | 'hub' | 'landing' | 'read';
  via: { path: string; control: string } | null;
  lastOpen: OpenResult | null;
  useCount: number;
  lastUse: UseResult | null;
  readChars: number;
  contexts: Partial<Record<ReadContext, { lastSeenAt: string }>>;
  firstSeenAt: string;
  lastSeenAt: string;
  controls: ControlEntry[];
}

/**
 * Another site's page that an agent's click left to arrive on this site (specs/005-direct-site-routing FR-004): its
 * origin and masked path only, never the control's name or any content text.
 */
export interface Entrance {
  origin: string;
  path: string;
  addressable: boolean;
  at: string;
}

export interface MapRecord {
  schemaVersion: 1;
  profile: string;
  origin: string;
  pages: PageEntry[];
  /** Optional, so files written before 005 stay valid; absent when empty. */
  entrances?: Entrance[];
  commitSeq: number;
  updatedAt: string;
}

const sha256 = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');

/** The per-profile directory under maps/. Hides the profile id. */
export function mapProfileDir(profile: string): string {
  return sha256(profile);
}

/** `<sha256(profile)>/<sha256(profile + "\n" + origin)>.json`. Hides both. */
export function mapFileName(profile: string, origin: string): string {
  return `${mapProfileDir(profile)}/${sha256(`${profile}\n${origin}`)}.json`;
}

export function emptyMapRecord(profile: string, origin: string, at: string): MapRecord {
  return { schemaVersion: MAP_SCHEMA_VERSION, profile, origin, pages: [], commitSeq: 0, updatedAt: at };
}

type Mode = 'read' | 'write';
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;
const AREAS: readonly string[] = ['header', 'nav', 'sidebar', 'footer', 'main', 'page', 'dialog', 'menu'];
const ROLES: readonly string[] = ['link', 'button', 'tab', 'menuitem'];
const OPEN_KINDS: readonly string[] = ['same', 'elsewhere', 'other_origin', 'sign_in', 'not_found', 'error'];
const REASONS: readonly string[] = ['root', 'destination', 'hub', 'landing', 'read'];

const bad = (mode: Mode, message: string): MemoryStoreError => new MemoryStoreError(mode === 'read' ? ERROR_CODES.MEMORY_CORRUPT : ERROR_CODES.INVALID_ARGUMENT, message);
const isTime = (value: unknown): value is string => typeof value === 'string' && ISO_UTC.test(value) && Number.isFinite(Date.parse(value));
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], mode: Mode, label: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw bad(mode, `${label} has an unknown field`);
}

function check(ok: boolean, mode: Mode, message: string): void {
  if (!ok) throw bad(mode, message);
}

/** A stored string: bounded, and nothing masking would replace (defense in depth, data-model "Validation summary"). */
function storedText(value: unknown, max: number, mode: Mode, label: string, nullable = false): void {
  if (nullable && value === null) return;
  check(typeof value === 'string' && value.length > 0 && value.length <= max, mode, `${label} is not a bounded string`);
  check(!looksUnmasked(value as string), mode, `${label} holds unmasked data`);
}

function storedPath(value: unknown, mode: Mode, label: string): void {
  storedText(value, MAP_LIMITS.pathChars, mode, label);
  check((value as string).startsWith('/'), mode, `${label} is not a path`);
}

function storedOrigin(value: unknown, mode: Mode, label: string): void {
  check(typeof value === 'string' && canonicalOrigin(value) === value, mode, `${label} is not a canonical origin`);
}

function validateUse(value: unknown, mode: Mode, label: string): void {
  if (value === null) return;
  check(isRecord(value), mode, `${label} is not an object`);
  const use = value as Record<string, unknown>;
  onlyKeys(use, ['result', 'code', 'at'], mode, label);
  check(use.result === 'worked' || use.result === 'failed', mode, `${label}.result is invalid`);
  check(use.code === undefined || LOCATOR_FAILURES.includes(use.code as LocatorFailure), mode, `${label}.code is invalid`);
  check(isTime(use.at), mode, `${label}.at is not a time`);
}

function validateDestination(value: unknown, mode: Mode): void {
  check(isRecord(value), mode, 'destination is not an object');
  const dest = value as Record<string, unknown>;
  onlyKeys(dest, ['path', 'origin', 'opens', 'excluded', 'at'], mode, 'destination');
  check(isTime(dest.at), mode, 'destination.at is not a time');
  const kinds = ['path', 'origin', 'opens', 'excluded'].filter((key) => dest[key] !== undefined);
  check(kinds.length === 1, mode, 'destination must have exactly one target');
  if (dest.path !== undefined) storedPath(dest.path, mode, 'destination.path');
  if (dest.origin !== undefined) storedOrigin(dest.origin, mode, 'destination.origin');
  if (dest.opens !== undefined) check(dest.opens === 'menu' || dest.opens === 'dialog', mode, 'destination.opens is invalid');
  if (dest.excluded !== undefined) check(dest.excluded === true, mode, 'destination.excluded is invalid');
}

function validateContextMap(value: unknown, mode: Mode, label: string, item: (entry: unknown) => void): void {
  check(isRecord(value), mode, `${label} is not an object`);
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    check(READ_CONTEXTS.includes(key as ReadContext), mode, `${label} has an unknown read context`);
    item(entry);
  }
}

function validateControl(raw: unknown, mode: Mode): ControlEntry {
  check(isRecord(raw), mode, 'control is not an object');
  const control = raw as Record<string, unknown>;
  onlyKeys(control, ['key', 'area', 'role', 'name', 'nth', 'parent', 'lang', 'dataChanging', 'destinations', 'seen', 'useCount', 'lastUse', 'firstSeenAt', 'lastSeenAt'], mode, 'control');
  check(typeof control.key === 'string' && control.key.length > 0 && control.key.length <= 120, mode, 'control.key is invalid');
  check(AREAS.includes(control.area as string), mode, 'control.area is invalid');
  check(ROLES.includes(control.role as string), mode, 'control.role is invalid');
  storedText(control.name, MAP_LIMITS.nameChars, mode, 'control.name');
  check(control.nth === null || isCount(control.nth), mode, 'control.nth is invalid');
  check(control.parent === null || (typeof control.parent === 'string' && control.parent.length <= 120), mode, 'control.parent is invalid');
  check(control.lang === null || (typeof control.lang === 'string' && /^[a-z]{2,8}$/u.test(control.lang)), mode, 'control.lang is invalid');
  check(typeof control.dataChanging === 'boolean', mode, 'control.dataChanging is not a boolean');
  validateContextMap(control.destinations, mode, 'control.destinations', (entry) => validateDestination(entry, mode));
  validateContextMap(control.seen, mode, 'control.seen', (entry) => {
    check(isRecord(entry), mode, 'control.seen entry is not an object');
    onlyKeys(entry as Record<string, unknown>, ['lastSeenAt', 'atLastComplete'], mode, 'control.seen');
    check(isTime((entry as Record<string, unknown>).lastSeenAt) && typeof (entry as Record<string, unknown>).atLastComplete === 'boolean', mode, 'control.seen entry is invalid');
  });
  check(isCount(control.useCount), mode, 'control.useCount is invalid');
  validateUse(control.lastUse, mode, 'control.lastUse');
  check(isTime(control.firstSeenAt) && isTime(control.lastSeenAt), mode, 'control times are invalid');
  return control as unknown as ControlEntry;
}

function validatePage(raw: unknown, mode: Mode): PageEntry {
  check(isRecord(raw), mode, 'page is not an object');
  const page = raw as Record<string, unknown>;
  onlyKeys(page, ['path', 'title', 'lang', 'dir', 'addressable', 'reason', 'via', 'lastOpen', 'useCount', 'lastUse', 'readChars', 'contexts', 'firstSeenAt', 'lastSeenAt', 'controls'], mode, 'page');
  storedPath(page.path, mode, 'page.path');
  storedText(page.title, MAP_LIMITS.titleChars, mode, 'page.title', true);
  check(page.lang === null || (typeof page.lang === 'string' && /^[a-z]{2,8}$/u.test(page.lang)), mode, 'page.lang is invalid');
  check(page.dir === null || page.dir === 'ltr' || page.dir === 'rtl', mode, 'page.dir is invalid');
  check(typeof page.addressable === 'boolean', mode, 'page.addressable is not a boolean');
  check(REASONS.includes(page.reason as string), mode, 'page.reason is invalid');
  if (page.via !== null) {
    check(isRecord(page.via), mode, 'page.via is not an object');
    const via = page.via as Record<string, unknown>;
    onlyKeys(via, ['path', 'control'], mode, 'page.via');
    storedPath(via.path, mode, 'page.via.path');
    check(typeof via.control === 'string' && via.control.length <= 120, mode, 'page.via.control is invalid');
  }
  if (page.lastOpen !== null) {
    check(isRecord(page.lastOpen), mode, 'page.lastOpen is not an object');
    const open = page.lastOpen as Record<string, unknown>;
    onlyKeys(open, ['result', 'path', 'origin', 'statusClass', 'at'], mode, 'page.lastOpen');
    check(OPEN_KINDS.includes(open.result as string), mode, 'page.lastOpen.result is invalid');
    if (open.path !== undefined) storedPath(open.path, mode, 'page.lastOpen.path');
    if (open.origin !== undefined) storedOrigin(open.origin, mode, 'page.lastOpen.origin');
    check(open.statusClass === undefined || open.statusClass === '4xx' || open.statusClass === '5xx', mode, 'page.lastOpen.statusClass is invalid');
    check(isTime(open.at), mode, 'page.lastOpen.at is not a time');
  }
  check(isCount(page.useCount) && isCount(page.readChars), mode, 'page counts are invalid');
  validateUse(page.lastUse, mode, 'page.lastUse');
  validateContextMap(page.contexts, mode, 'page.contexts', (entry) => {
    check(isRecord(entry), mode, 'page.contexts entry is not an object');
    onlyKeys(entry as Record<string, unknown>, ['lastSeenAt'], mode, 'page.contexts');
    check(isTime((entry as Record<string, unknown>).lastSeenAt), mode, 'page.contexts entry is invalid');
  });
  check(isTime(page.firstSeenAt) && isTime(page.lastSeenAt), mode, 'page times are invalid');
  check(Array.isArray(page.controls) && page.controls.length <= MAX_MAP_CONTROLS, mode, 'page.controls is not a bounded array');
  const keys = new Set<string>();
  for (const control of page.controls as unknown[]) {
    const valid = validateControl(control, mode);
    check(!keys.has(valid.key), mode, 'page.controls holds a duplicate key');
    keys.add(valid.key);
  }
  return page as unknown as PageEntry;
}

function validateEntrances(value: unknown, own: string, mode: Mode): void {
  check(Array.isArray(value) && value.length <= MAX_MAP_ENTRANCES, mode, 'map.entrances is not a bounded array');
  const seen = new Set<string>();
  for (const raw of value as unknown[]) {
    check(isRecord(raw), mode, 'entrance is not an object');
    const entrance = raw as Record<string, unknown>;
    onlyKeys(entrance, ['origin', 'path', 'addressable', 'at'], mode, 'entrance');
    storedOrigin(entrance.origin, mode, 'entrance.origin');
    check(entrance.origin !== own, mode, 'entrance.origin is the map\'s own origin');
    storedPath(entrance.path, mode, 'entrance.path');
    check(typeof entrance.addressable === 'boolean', mode, 'entrance.addressable is not a boolean');
    check(isTime(entrance.at), mode, 'entrance.at is not a time');
    const key = `${entrance.origin as string}\n${entrance.path as string}`;
    check(!seen.has(key), mode, 'map.entrances holds a duplicate');
    seen.add(key);
  }
}

/** Strict validation of a map file: on read a failure quarantines the file (MEMORY_CORRUPT); on write it is a programming error. */
export function validateMapRecord(raw: unknown, mode: Mode): MapRecord {
  check(isRecord(raw), mode, 'map is not an object');
  const record = raw as Record<string, unknown>;
  onlyKeys(record, ['schemaVersion', 'profile', 'origin', 'pages', 'entrances', 'commitSeq', 'updatedAt'], mode, 'map');
  check(record.schemaVersion === MAP_SCHEMA_VERSION, mode, 'unknown map schemaVersion');
  check(typeof record.profile === 'string' && record.profile.length > 0 && record.profile.length <= 200, mode, 'map.profile is invalid');
  storedOrigin(record.origin, mode, 'map.origin');
  check(Array.isArray(record.pages) && record.pages.length <= MAX_MAP_PAGES, mode, 'map.pages is not a bounded array');
  const paths = new Set<string>();
  for (const page of record.pages as unknown[]) {
    const valid = validatePage(page, mode);
    check(!paths.has(valid.path), mode, 'map.pages holds a duplicate path');
    paths.add(valid.path);
  }
  if (record.entrances !== undefined) validateEntrances(record.entrances, record.origin as string, mode);
  check(isCount(record.commitSeq), mode, 'map.commitSeq is invalid');
  check(isTime(record.updatedAt), mode, 'map.updatedAt is not a time');
  return structuredClone(record) as unknown as MapRecord;
}
