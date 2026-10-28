/**
 * Pure reconciliation of map observations into a stored map (specs/004-site-navigation-map data-model.md
 * "State transitions", research R-08, R-11, R-18). No I/O; the queue applies ops in order and writes once.
 */
import type { MapArea, MapRole } from './map-allowlist.js';
import { MAP_LIMITS } from './map-allowlist.js';
import {
  MAX_MAP_CONTROLS,
  MAX_MAP_PAGES,
  type ControlEntry,
  type Destination,
  type LocatorFailure,
  type MapRecord,
  type OpenResultKind,
  type PageEntry,
  type ReadContext,
} from './map-record.js';
import { isDataChanging, pathUnderPrefix, samePath } from './map-text.js';
import { MemoryStoreError } from './site-record.js';

export interface ObservedControl {
  key: string;
  area: MapArea;
  role: MapRole;
  name: string;
  nth: number | null;
  /** The control whose opened menu or dialog holds this one (AC-08). */
  parent: string | null;
}

interface OpBase {
  opId: string;
  profile: string;
  origin: string;
  at: string;
}

export interface MapReadOp extends OpBase {
  type: 'read';
  path: string;
  addressable: boolean;
  title: string | null;
  lang: string | null;
  dir: 'ltr' | 'rtl' | null;
  context: ReadContext;
  complete: boolean;
  readChars: number;
  controls: ObservedControl[];
  /** `refresh` never creates a page (R-11). */
  reason: 'root' | 'destination' | 'hub' | 'landing' | 'refresh';
  /** For `landing`: the requested path; the landing page is recorded only when that path has an entry (R-08). */
  landingOf?: string;
  /** A click that did not navigate and whose menu or dialog this read shows (R-11, CHK005). */
  openedBy?: { controlKey: string; opens: 'menu' | 'dialog'; context: ReadContext };
}

export interface MapClickOp extends OpBase {
  type: 'click';
  fromPath: string;
  control: ObservedControl;
  lang: string | null;
  sourceContext: ReadContext;
  navigated: boolean;
  /** Where the click led, when it navigated: a same-origin masked path, another origin, or an excluded path. */
  destination: Omit<Destination, 'at'> | null;
  destinationAddressable: boolean;
  /** INPUT_BLOCKED, a dialog, a download or a timeout: learn the destination, decide no use (R-08). */
  undecided?: boolean;
}

export interface MapClickFailedOp extends OpBase {
  type: 'clickFailed';
  path: string;
  controlKey: string;
  code: LocatorFailure;
}

export interface MapOpenOp extends OpBase {
  type: 'open';
  requestedPath: string;
  result: OpenResultKind;
  landingPath?: string;
  landingOrigin?: string;
  statusClass?: '4xx' | '5xx';
}

export type MapRecordOp = MapReadOp | MapClickOp | MapClickFailedOp | MapOpenOp;

/** Whether an op's outcome counted as a decided use, for the counters (R-19). */
export interface ApplyResult {
  changed: boolean;
  use: 'worked' | 'failed' | null;
  /** The page whose `via` chain the savings estimate walks, for a worked direct open or control use. */
  usedPath: string | null;
  usedKind: 'open' | 'control' | null;
}

const NONE: ApplyResult = { changed: false, use: null, usedPath: null, usedKind: null };
const FAILED_OPENS: ReadonlySet<OpenResultKind> = new Set(['elsewhere', 'other_origin', 'not_found']);
const time = (value: string | undefined): number => (value ? Date.parse(value) : 0);
const latest = (current: string | undefined, next: string): string => (current && time(current) > time(next) ? current : next);
const PLACEHOLDER = /\{(?:email|phone|id|n)\}/u;

function findPage(record: MapRecord, path: string): PageEntry | undefined {
  return record.pages.find((page) => page.path === path);
}

function newPage(path: string, reason: PageEntry['reason'], addressable: boolean, at: string): PageEntry {
  return {
    path,
    title: null,
    lang: null,
    dir: null,
    addressable,
    reason,
    via: null,
    lastOpen: null,
    useCount: 0,
    lastUse: null,
    readChars: 0,
    contexts: {},
    firstSeenAt: at,
    lastSeenAt: at,
    controls: [],
  };
}

function newControl(observed: ObservedControl, lang: string | null, at: string): ControlEntry {
  return {
    key: observed.key,
    area: observed.area,
    role: observed.role,
    name: observed.name,
    nth: observed.nth,
    parent: observed.parent,
    lang,
    dataChanging: isDataChanging(observed.name),
    destinations: {},
    seen: {},
    useCount: 0,
    lastUse: null,
    firstSeenAt: at,
    lastSeenAt: at,
  };
}

/** Controls inside a menu or dialog are only visible while it is open, so a read without them proves nothing. */
const markable = (control: ControlEntry): boolean => control.area !== 'menu' && control.area !== 'dialog' && control.parent === null;

function applyRead(record: MapRecord, op: MapReadOp): ApplyResult {
  let page = findPage(record, op.path);
  if (!page) {
    if (op.reason === 'refresh') return NONE;
    if (op.reason === 'landing' && (op.landingOf === undefined || !findPage(record, op.landingOf))) return NONE;
    page = newPage(op.path, op.reason, op.addressable, op.at);
    record.pages.push(page);
  } else {
    page.addressable = page.addressable || op.addressable;
  }
  // A path with a placeholder never keeps a title (FR-003).
  page.title = PLACEHOLDER.test(page.path) ? null : (op.title ?? page.title);
  page.lang = op.lang;
  page.dir = op.dir;
  if (op.complete) page.readChars = op.readChars;
  // Ops can arrive out of order (a hub read replays the cached read): times only move forward.
  page.contexts[op.context] = { lastSeenAt: latest(page.contexts[op.context]?.lastSeenAt, op.at) };
  page.lastSeenAt = latest(page.lastSeenAt, op.at);

  const observed = new Set<string>();
  for (const item of op.controls) {
    observed.add(item.key);
    let control = page.controls.find((entry) => entry.key === item.key);
    if (!control) {
      control = newControl(item, op.lang, op.at);
      page.controls.push(control);
    } else {
      control.name = item.name;
      control.dataChanging = isDataChanging(item.name);
      if (op.complete) control.nth = item.nth;
      if (item.parent !== null) control.parent = item.parent;
      control.lang = op.lang;
      control.lastSeenAt = latest(control.lastSeenAt, op.at);
    }
    if (op.complete || op.context === 'unknown') control.seen[op.context] = { lastSeenAt: op.at, atLastComplete: true };
    else if (control.seen[op.context]) control.seen[op.context] = { lastSeenAt: op.at, atLastComplete: control.seen[op.context]?.atLastComplete ?? true };
  }
  // Not-seen marking: complete reads only, never in the unknown context, same language, and only for controls already seen in this context (AC-18, AC-28).
  if (op.complete && op.context !== 'unknown') {
    for (const control of page.controls) {
      const seen = control.seen[op.context];
      if (observed.has(control.key) || !seen || control.lang !== op.lang || !markable(control)) continue;
      control.seen[op.context] = { lastSeenAt: seen.lastSeenAt, atLastComplete: false };
    }
  }
  if (op.openedBy) {
    const opener = page.controls.find((entry) => entry.key === op.openedBy?.controlKey);
    if (opener) opener.destinations[op.openedBy.context] = { opens: op.openedBy.opens, at: op.at };
  }
  return { changed: true, use: null, usedPath: null, usedKind: null };
}

function sameDestination(expected: Destination, actual: Omit<Destination, 'at'>): boolean {
  if (expected.path !== undefined) return actual.path === expected.path;
  if (expected.origin !== undefined) return actual.origin === expected.origin;
  if (expected.excluded) return actual.excluded === true;
  return false;
}

function applyClick(record: MapRecord, op: MapClickOp): ApplyResult {
  const page = findPage(record, op.fromPath);
  if (!page) return NONE;
  let control = page.controls.find((entry) => entry.key === op.control.key);
  if (!control) {
    control = newControl(op.control, op.lang, op.at);
    page.controls.push(control);
  }
  const expected = control.destinations[op.sourceContext];
  let use: 'worked' | 'failed' | null = null;
  if (!op.navigated) {
    if (!op.undecided && expected?.opens) use = 'worked';
  } else if (op.destination) {
    if (expected && !expected.opens && !op.undecided) use = sameDestination(expected, op.destination) ? 'worked' : 'failed';
    control.destinations[op.sourceContext] = { ...op.destination, at: op.at };
    if (op.destination.path !== undefined && op.destination.path !== op.fromPath) {
      let target = findPage(record, op.destination.path);
      if (!target) {
        target = newPage(op.destination.path, 'destination', op.destinationAddressable, op.at);
        record.pages.push(target);
      } else {
        target.addressable = target.addressable || op.destinationAddressable;
      }
      target.via = { path: op.fromPath, control: control.key };
    }
  }
  if (use === 'worked') {
    control.useCount += 1;
    control.lastUse = { result: 'worked', at: op.at };
  } else if (use === 'failed') {
    control.lastUse = { result: 'failed', code: 'MISMATCH', at: op.at };
  }
  return { changed: true, use, usedPath: use === 'worked' ? page.path : null, usedKind: use === 'worked' ? 'control' : null };
}

function applyClickFailed(record: MapRecord, op: MapClickFailedOp): ApplyResult {
  const control = findPage(record, op.path)?.controls.find((entry) => entry.key === op.controlKey);
  if (!control) return NONE;
  // A failed use never changes `seen` (FR-010).
  control.lastUse = { result: 'failed', code: op.code, at: op.at };
  return { changed: true, use: 'failed', usedPath: null, usedKind: null };
}

function applyOpen(record: MapRecord, op: MapOpenOp): ApplyResult {
  const page = findPage(record, op.requestedPath);
  if (!page) return NONE;
  page.lastOpen = {
    result: op.result,
    ...(op.landingPath !== undefined ? { path: op.landingPath } : {}),
    ...(op.landingOrigin !== undefined ? { origin: op.landingOrigin } : {}),
    ...(op.statusClass !== undefined ? { statusClass: op.statusClass } : {}),
    at: op.at,
  };
  // The root needs no hint: any agent can open it from the origin alone, so opening it is not a hint use (RV-16).
  if (page.path === '/') return { changed: true, use: null, usedPath: null, usedKind: null };
  if (op.result === 'same') {
    page.useCount += 1;
    page.lastUse = { result: 'worked', at: op.at };
    return { changed: true, use: 'worked', usedPath: page.path, usedKind: 'open' };
  }
  if (FAILED_OPENS.has(op.result)) {
    page.lastUse = { result: 'failed', at: op.at };
    return { changed: true, use: 'failed', usedPath: null, usedKind: null };
  }
  return { changed: true, use: null, usedPath: null, usedKind: null };
}

/** Apply one op in place. The caller passes a clone and bumps commitSeq once per commit. */
export function applyMapOp(record: MapRecord, op: MapRecordOp): ApplyResult {
  switch (op.type) {
    case 'read':
      return applyRead(record, op);
    case 'click':
      return applyClick(record, op);
    case 'clickFailed':
      return applyClickFailed(record, op);
    case 'open':
      return applyOpen(record, op);
  }
}

const recency = (entry: { lastSeenAt: string; lastUse: { at: string } | null }): number => Math.max(time(entry.lastSeenAt), time(entry.lastUse?.at));

/** Byte size of the record as the store writes it (`JSON.stringify` + newline), computed per page so eviction stays linear. */
function sizeOf(record: MapRecord, pageSizes: number[]): number {
  const shell = Buffer.byteLength(JSON.stringify({ ...record, pages: [] }));
  const commas = Math.max(0, pageSizes.length - 1);
  return shell + pageSizes.reduce((sum, size) => sum + size, 0) + commas + 1;
}

/**
 * Bound the record (R-18): controls per page, pages per file, then bytes, least recent first. Returns the
 * number of evicted pages. MEMORY_FULL only when even an empty map would not fit (a programming error).
 */
export function enforceMapLimits(record: MapRecord, byteLimit: number = MAP_LIMITS.mapFileBytes): number {
  for (const page of record.pages) {
    if (page.controls.length > MAX_MAP_CONTROLS) {
      page.controls.sort((a, b) => recency(b) - recency(a));
      page.controls.length = MAX_MAP_CONTROLS;
    }
  }
  const before = record.pages.length;
  record.pages.sort((a, b) => recency(b) - recency(a) || (a.path < b.path ? -1 : 1));
  if (record.pages.length > MAX_MAP_PAGES) record.pages.length = MAX_MAP_PAGES;
  const sizes = record.pages.map((page) => Buffer.byteLength(JSON.stringify(page)));
  while (sizeOf(record, sizes) > byteLimit) {
    if (record.pages.length === 0) throw new MemoryStoreError('MEMORY_FULL', 'the map does not fit its size limit');
    record.pages.pop();
    sizes.pop();
  }
  return before - record.pages.length;
}

/**
 * Remove every entry at or under `prefix` (a path exclusion or a page delete, R-13): pages under it, `via`
 * links into it, and destinations under it (kept as `{excluded: true}` for an exclusion, removed for a delete).
 */
export function removePathPrefix(record: MapRecord, prefix: string, mode: 'exclude' | 'delete'): boolean {
  let changed = false;
  const kept = record.pages.filter((page) => !pathUnderPrefix(page.path, prefix));
  if (kept.length !== record.pages.length) changed = true;
  record.pages = kept;
  for (const page of record.pages) {
    if (page.via && pathUnderPrefix(page.via.path, prefix)) {
      page.via = null;
      changed = true;
    }
    if (page.lastOpen?.path !== undefined && pathUnderPrefix(page.lastOpen.path, prefix)) {
      const { path: _dropped, ...rest } = page.lastOpen;
      page.lastOpen = rest;
      changed = true;
    }
    for (const control of page.controls) {
      for (const [context, destination] of Object.entries(control.destinations) as Array<[ReadContext, Destination]>) {
        if (destination.path === undefined || !pathUnderPrefix(destination.path, prefix)) continue;
        if (mode === 'exclude') control.destinations[context] = { excluded: true, at: destination.at };
        else delete control.destinations[context];
        changed = true;
      }
    }
  }
  return changed;
}

export type EntryStatus = 'working' | 'not_seen' | 'failed';

/** The seen entry of the context read most recently decides; a failed last use overrides (data-model "Working status"). */
export function controlStatus(control: ControlEntry): EntryStatus {
  if (control.lastUse?.result === 'failed') return 'failed';
  let latest: { lastSeenAt: string; atLastComplete: boolean } | undefined;
  for (const seen of Object.values(control.seen)) {
    if (seen && (!latest || time(seen.lastSeenAt) > time(latest.lastSeenAt))) latest = seen;
  }
  return latest && !latest.atLastComplete ? 'not_seen' : 'working';
}

/** A failed use or open counts until the page is seen again after it (AC-29: "current again if the page is seen again"). */
export function pageStatus(page: PageEntry): EntryStatus {
  const seen = time(page.lastSeenAt);
  if (page.lastUse?.result === 'failed' && time(page.lastUse.at) >= seen) return 'failed';
  if (page.lastOpen && FAILED_OPENS.has(page.lastOpen.result) && time(page.lastOpen.at) >= seen) return 'failed';
  return 'working';
}

/** The latest of last seen and last used, for ranking and eviction. */
export function entryRecency(entry: { lastSeenAt: string; lastUse: { at: string } | null }): number {
  return recency(entry);
}

/** The `via` chain from a page back towards the root, at most `limit` hops, never looping. */
export function viaChain(record: MapRecord, path: string, limit = 5): PageEntry[] {
  const chain: PageEntry[] = [];
  const visited = new Set<string>([path]);
  let current = findPage(record, path);
  while (current?.via && chain.length < limit && !visited.has(current.via.path)) {
    visited.add(current.via.path);
    const previous = findPage(record, current.via.path);
    if (!previous) break;
    chain.push(previous);
    current = previous;
  }
  return chain;
}

/** The policy facts sanitizing needs; a subset of MapPolicy and 003's MemoryPolicy. */
export interface SanitizePolicy {
  excludedPrefixes: readonly string[];
  /** Tombstones that match this record's profile and origin: a prefix, one page, or the whole map. */
  tombstones: ReadonlyArray<{ pathPrefix?: string; path?: string; at: string }>;
}

/**
 * Bring a record in line with the policy before it is written (R-05, R-13, AC-16): nothing under an excluded
 * prefix, and nothing a tombstone covers that was first seen at or before it. Entries learned after a deletion
 * stay. Run on every commit, so a write that read the record before an owner change cannot bring entries back.
 */
export function sanitizeRecord(record: MapRecord, policy: SanitizePolicy): boolean {
  let changed = false;
  for (const prefix of policy.excludedPrefixes) changed = removePathPrefix(record, prefix, 'exclude') || changed;
  for (const tombstone of policy.tombstones) {
    const cutoff = Date.parse(tombstone.at);
    const scoped = tombstone.pathPrefix !== undefined || tombstone.path !== undefined;
    const covered = (path: string): boolean => {
      if (tombstone.path !== undefined) return samePath(path, tombstone.path);
      return tombstone.pathPrefix === undefined || pathUnderPrefix(path, tombstone.pathPrefix);
    };
    const kept = record.pages.filter((page) => !(covered(page.path) && Date.parse(page.firstSeenAt) <= cutoff));
    if (kept.length !== record.pages.length) changed = true;
    record.pages = kept;
    for (const page of record.pages) {
      if (page.via && covered(page.via.path) && scoped) {
        page.via = null;
        changed = true;
      }
      for (const control of page.controls) {
        for (const [context, destination] of Object.entries(control.destinations) as Array<[ReadContext, Destination]>) {
          if (destination.path === undefined || !scoped || !covered(destination.path) || Date.parse(destination.at) > cutoff) continue;
          delete control.destinations[context];
          changed = true;
        }
      }
    }
  }
  return changed;
}
