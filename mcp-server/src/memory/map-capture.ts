/**
 * Turns finished browser calls into site-map ops (specs/004-site-navigation-map research R-07, R-08, R-11) and
 * keeps the in-memory tab read cache (data-model "TabReadCache"). Synchronous and pure apart from the cache; the
 * caller has already decided the call is in scope. The cache holds parsed controls only, never page text.
 */
import { MAP_LIMITS } from './map-allowlist.js';
import type { QueuedMapOp } from './map-queue.js';
import { LOCATOR_FAILURES, type LocatorFailure, type OpenResultKind, type ReadContext } from './map-record.js';
import type { MapReadOp, ObservedControl } from './map-reconcile.js';
import { parseMapSnapshot } from './map-snapshot.js';
import { boundTitle, maskPath, normalizeForMatch } from './map-text.js';
import { canonicalOrigin } from './policy.js';

const ERROR_WINDOW_MS = MAP_LIMITS.errorAttributionSeconds * 1_000;
const LANG = /^[a-z]{2,8}$/u;

export type CachedControl = ObservedControl & { ref: string | null };

export interface TabRead {
  origin: string;
  rawPath: string;
  path: string;
  addressable: boolean;
  title: string | null;
  context: ReadContext;
  lang: string | null;
  dir: 'ltr' | 'rtl' | null;
  complete: boolean;
  readChars: number;
  controls: CachedControl[];
  refs: Map<string, { role: string; name: string }>;
  atMs: number;
  /** A click on this page that did not navigate, waiting for the read that shows what it opened. */
  pendingClick: { controlKey: string; context: ReadContext; atMs: number } | null;
  /** Dialogs and menus this read printed: their count and control keys, so a later click is credited only with new ones (RV-14). */
  openedBefore?: { containers: number; keys: Set<string> };
  /** Set after a click navigated here: no read yet, so nothing on it can be attributed. */
  stub?: true;
  /** The click that led here was attributed to a stored control, so the first read here is that click's destination. */
  attributed?: true;
}

/** At most 64 tabs, least recently used first; keyed by connection and tab. */
export class TabReadCache {
  private readonly entries = new Map<string, TabRead>();

  constructor(private readonly limit: number = MAP_LIMITS.tabCacheEntries) {}

  private key(connectionId: string, tabId: number): string {
    return `${connectionId}\n${tabId}`;
  }

  get(connectionId: string, tabId: number): TabRead | undefined {
    const key = this.key(connectionId, tabId);
    const entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    return entry;
  }

  set(connectionId: string, tabId: number, entry: TabRead): void {
    const key = this.key(connectionId, tabId);
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  delete(connectionId: string, tabId: number): void {
    this.entries.delete(this.key(connectionId, tabId));
  }

  /** Every entry not made on `keep` (a connection change). */
  dropOtherConnections(keep: string): void {
    for (const key of [...this.entries.keys()]) if (!key.startsWith(`${keep}\n`)) this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

/** The fields of the extension's siteContext that capture reads. Agents never supply them. */
export interface CaptureContext {
  url: string;
  fromUrl: string | null;
  anonymous: boolean | null;
  lang: string | null;
  dir: string | null;
  passwordField: boolean;
}

export interface CaptureInput {
  tool: string;
  params: Record<string, unknown>;
  result: Record<string, unknown>;
  /** `CODE: message` of a failed call; only the code is read. */
  error?: string;
  daemonCallId: string;
  at: string;
  nowMs: number;
  profile: string;
  connectionId: string;
  tabId: number;
  /** Null for a failed click, which carries no siteContext. */
  context: CaptureContext | null;
  /** The map's path exclusion for an origin, tested on the raw and the masked path (R-13). */
  isExcluded: (origin: string, rawPath: string, path: string) => boolean;
}

interface ParsedUrl {
  origin: string;
  rawPath: string;
  query: boolean;
}

function parseUrl(value: unknown): ParsedUrl | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    const origin = canonicalOrigin(url.href);
    if (!origin) return null;
    return { origin, rawPath: url.pathname || '/', query: url.search !== '' || url.hash !== '' };
  } catch {
    return null;
  }
}

export function readContextOf(anonymous: boolean | null): ReadContext {
  return anonymous === true ? 'public' : anonymous === false ? 'not_public' : 'unknown';
}

const langOf = (value: string | null): string | null => (value && LANG.test(value) ? value : null);
const dirOf = (value: string | null): 'ltr' | 'rtl' | null => (value === 'ltr' || value === 'rtl' ? value : null);
const strip = ({ ref: _ref, ...control }: CachedControl): ObservedControl => control;

/** The control a click target names in the cached read, or null when it cannot be told apart (R-07). */
export function resolveTarget(entry: TabRead, target: unknown): CachedControl | null {
  const same = (name: string) => (control: CachedControl): boolean => normalizeForMatch(control.name) === normalizeForMatch(name);
  if (typeof target === 'string') {
    if (/^e\d+$/u.test(target)) {
      const info = entry.refs.get(target);
      if (!info) return null;
      const candidates = entry.controls.filter((control) => control.role === info.role && same(info.name)(control));
      return candidates.length === 1 ? candidates[0] : (candidates.find((control) => control.ref === target) ?? null);
    }
    if (target.startsWith('text=')) {
      const candidates = entry.controls.filter(same(target.slice('text='.length)));
      return candidates.length === 1 ? candidates[0] : null;
    }
    return null;
  }
  if (typeof target === 'object' && target !== null && !Array.isArray(target)) {
    const { role, name, nth } = target as Record<string, unknown>;
    if (typeof role !== 'string' || typeof name !== 'string') return null;
    const candidates = entry.controls.filter((control) => control.role === role && same(name)(control));
    if (candidates.length === 1) return candidates[0];
    return typeof nth === 'number' ? (candidates.find((control) => control.nth === nth) ?? null) : null;
  }
  return null;
}

function openResult(context: CaptureContext, landed: ParsedUrl, landedPath: string, requested: ParsedUrl, requestedPath: string, status: number | undefined): { result: OpenResultKind; landingPath?: string; landingOrigin?: string; statusClass?: '4xx' | '5xx' } {
  if (landed.origin !== requested.origin) return { result: 'other_origin', landingOrigin: landed.origin };
  const moved = landedPath !== requestedPath ? { landingPath: landedPath } : {};
  if (context.passwordField || status === 401 || status === 403) return { result: 'sign_in', ...moved };
  if (status === 404 || status === 410) return { result: 'not_found' };
  if (status !== undefined && status >= 400) return { result: 'error', statusClass: status >= 500 ? '5xx' : '4xx' };
  return landedPath === requestedPath ? { result: 'same' } : { result: 'elsewhere', landingPath: landedPath };
}

/** A navigate or snapshot that is in scope: one read op (and, for a navigate, one open op); the cache takes the read. */
function captureRead(cache: TabReadCache, input: CaptureInput, context: CaptureContext): QueuedMapOp[] {
  const page = parseUrl(context.url);
  const masked = page ? maskPath(page.rawPath) : null;
  if (!page || !masked || input.isExcluded(page.origin, page.rawPath, masked.path)) {
    cache.delete(input.connectionId, input.tabId);
    return [];
  }
  const navigated = input.tool === 'browser_navigate';
  const text = typeof input.result.text === 'string' ? input.result.text : '';
  const withSnapshot = input.tool === 'browser_snapshot' || input.params.snapshot === true;
  const scoped = input.tool === 'browser_snapshot' && (input.params.query !== undefined || input.params.target !== undefined);
  const parsed = parseMapSnapshot(text, { scoped, truncated: input.result.truncated === true });
  const readContext = readContextOf(context.anonymous);
  const lang = langOf(context.lang);
  const previous = cache.get(input.connectionId, input.tabId);
  const pending = !navigated && previous?.pendingClick && previous.origin === page.origin && previous.path === masked.path && input.nowMs - previous.pendingClick.atMs <= ERROR_WINDOW_MS ? previous.pendingClick : null;

  // Opened menus and dialogs are recorded only under the click that opened them (R-10). One already printed in the
  // read before the click, such as a cookie dialog, was not opened by it (RV-14).
  const before = pending ? previous?.openedBefore : undefined;
  const fresh = (control: { key: string; opened: 'dialog' | 'menu' | null }): boolean => control.opened !== null && !before?.keys.has(control.key);
  const controls: CachedControl[] = withSnapshot
    ? parsed.controls.filter((control) => !control.opened || (pending !== null && fresh(control))).map((control) => ({ key: control.key, area: control.area, role: control.role, name: control.name, nth: control.nth, parent: control.opened && pending ? pending.controlKey : null, ref: control.ref }))
    : [];
  const opened = pending && withSnapshot && (parsed.openedContainers > (before?.containers ?? 0) || parsed.controls.some(fresh) || parsed.controls.some((control) => control.key === pending.controlKey && control.expanded));
  const addressable = !masked.masked && !page.query;
  const title = masked.masked ? null : boundTitle(parsed.title);

  const ops: QueuedMapOp[] = [];
  // Only a same-origin click makes a destination page; another origin is recorded by its origin alone (Edge Cases).
  const arrived = !!previous?.stub && previous.attributed === true && previous.origin === page.origin && previous.path === masked.path;
  let reason: MapReadOp['reason'] = masked.path === '/' ? 'root' : arrived ? 'destination' : 'refresh';
  let landingOf: string | undefined;
  const requested = navigated ? parseUrl(input.params.url) : null;
  const requestedMasked = requested ? maskPath(requested.rawPath) : null;
  const status = navigated && typeof input.result.status === 'number' ? input.result.status : undefined;
  if (requested && requestedMasked) {
    const outcome = openResult(context, page, masked.path, requested, requestedMasked.path, status);
    ops.push({ type: 'open', opId: `${input.daemonCallId}#open`, profile: input.profile, origin: requested.origin, at: input.at, requestedPath: requestedMasked.path, ...outcome, rawPaths: [requested.rawPath] });
    if (reason === 'refresh' && requested.origin === page.origin && requestedMasked.path !== masked.path) {
      reason = 'landing';
      landingOf = requestedMasked.path;
    }
  }
  // An error page says nothing about the page's structure: the open result is kept, the read is not (AC-29).
  if (status !== undefined && status >= 400) {
    cache.delete(input.connectionId, input.tabId);
    return ops;
  }
  const read: QueuedMapOp = {
    type: 'read',
    opId: navigated ? `${input.daemonCallId}#read` : input.daemonCallId,
    profile: input.profile,
    origin: page.origin,
    at: input.at,
    path: masked.path,
    addressable,
    title,
    lang,
    dir: dirOf(context.dir),
    context: readContext,
    complete: withSnapshot && parsed.complete,
    readChars: withSnapshot ? parsed.chars : 0,
    controls: controls.map(strip),
    reason,
    ...(landingOf !== undefined ? { landingOf } : {}),
    ...(opened && pending ? { openedBy: { controlKey: pending.controlKey, opens: parsed.controls.some((control) => fresh(control) && control.opened === 'dialog') ? ('dialog' as const) : ('menu' as const), context: pending.context } } : {}),
    rawPaths: [page.rawPath],
  };
  ops.push(read);
  cache.set(input.connectionId, input.tabId, {
    origin: page.origin,
    rawPath: page.rawPath,
    path: masked.path,
    addressable,
    title,
    context: readContext,
    lang,
    dir: dirOf(context.dir),
    complete: read.complete,
    readChars: read.readChars,
    controls,
    refs: withSnapshot ? parsed.refs : new Map(),
    atMs: input.nowMs,
    pendingClick: null,
    ...(withSnapshot ? { openedBefore: { containers: parsed.openedContainers, keys: new Set(parsed.controls.filter((control) => control.opened).map((control) => control.key)) } } : {}),
  });
  return ops;
}

/** A successful click: a hub read from the cache and the click op, when the target and the source page are known (R-07). */
function captureClick(cache: TabReadCache, input: CaptureInput, context: CaptureContext): QueuedMapOp[] {
  const entry = cache.get(input.connectionId, input.tabId);
  const from = parseUrl(context.fromUrl);
  const after = parseUrl(context.url);
  const afterMasked = after ? maskPath(after.rawPath) : null;
  const navigated = !!after && !!from && (after.origin !== from.origin || after.rawPath !== from.rawPath);
  const leaveStub = (attributed = false): void => {
    if (!navigated || !after || !afterMasked) return;
    cache.set(input.connectionId, input.tabId, { origin: after.origin, rawPath: after.rawPath, path: afterMasked.path, addressable: false, title: null, context: entry?.context ?? 'unknown', lang: null, dir: null, complete: false, readChars: 0, controls: [], refs: new Map(), atMs: input.nowMs, pendingClick: null, stub: true, ...(attributed ? { attributed: true as const } : {}) });
  };
  if (!entry || entry.stub || !from || entry.origin !== from.origin || entry.rawPath !== from.rawPath) {
    if (entry && !navigated) cache.delete(input.connectionId, input.tabId);
    leaveStub();
    return [];
  }
  const control = resolveTarget(entry, input.params.target);
  if (!control) {
    leaveStub();
    return [];
  }
  let destination: { path?: string; origin?: string; excluded?: true } | null = null;
  if (navigated && after) {
    if (after.origin !== entry.origin) destination = { origin: after.origin };
    else if (afterMasked) destination = input.isExcluded(entry.origin, after.rawPath, afterMasked.path) ? { excluded: true } : { path: afterMasked.path };
  }
  const base = { profile: input.profile, origin: entry.origin, at: input.at };
  const hub: QueuedMapOp = {
    type: 'read',
    opId: `${input.daemonCallId}#hub`,
    ...base,
    path: entry.path,
    addressable: entry.addressable,
    title: entry.title,
    lang: entry.lang,
    dir: entry.dir,
    context: entry.context,
    complete: false,
    readChars: entry.readChars,
    controls: entry.controls.map(strip),
    reason: 'hub',
    rawPaths: [entry.rawPath],
  };
  const click: QueuedMapOp = {
    type: 'click',
    opId: input.daemonCallId,
    ...base,
    fromPath: entry.path,
    control: strip(control),
    lang: entry.lang,
    sourceContext: entry.context,
    navigated,
    destination,
    destinationAddressable: !!afterMasked && !afterMasked.masked && !after?.query,
    rawPaths: [entry.rawPath],
  };
  if (navigated) leaveStub(!!after && after.origin === entry.origin);
  else entry.pendingClick = { controlKey: control.key, context: entry.context, atMs: input.nowMs };
  return [hub, click];
}

/** A failed click names its code only; it is attributed through the cache alone (≤ 120 s, same connection; R-08). */
function captureClickError(cache: TabReadCache, input: CaptureInput): QueuedMapOp[] {
  const code = (input.error ?? '').split(':')[0].trim();
  if (!LOCATOR_FAILURES.includes(code as LocatorFailure) || code === 'MISMATCH') return [];
  const entry = cache.get(input.connectionId, input.tabId);
  if (!entry || entry.stub || input.nowMs - entry.atMs > ERROR_WINDOW_MS) return [];
  const control = resolveTarget(entry, input.params.target);
  if (!control) return [];
  return [{ type: 'clickFailed', opId: input.daemonCallId, profile: input.profile, origin: entry.origin, at: input.at, path: entry.path, controlKey: control.key, code: code as LocatorFailure, rawPaths: [entry.rawPath] }];
}

/** The ops one finished call yields. Never throws for malformed results: they yield nothing. */
export function captureMapOps(cache: TabReadCache, input: CaptureInput): QueuedMapOp[] {
  if (input.tool === 'browser_click') {
    if (input.error !== undefined) return captureClickError(cache, input);
    return input.context ? captureClick(cache, input, input.context) : [];
  }
  if ((input.tool === 'browser_navigate' || input.tool === 'browser_snapshot') && input.context && input.result.success !== false) {
    if (input.result.download === true || input.result.noContent === true) return [];
    return captureRead(cache, input, input.context);
  }
  return [];
}
