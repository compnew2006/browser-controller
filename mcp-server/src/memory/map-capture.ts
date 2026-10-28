/**
 * Turns finished browser calls into site-map ops (specs/004-site-navigation-map research R-07, R-08, R-11) and
 * keeps the in-memory tab read cache (data-model "TabReadCache"). Synchronous and pure apart from the cache; the
 * caller has already decided the call is in scope. The cache holds parsed controls only, never page text.
 */
import { MAP_LIMITS } from './map-allowlist.js';
import type { QueuedMapOp } from './map-queue.js';
import { LOCATOR_FAILURES, type LocatorFailure, type OpenResultKind, type ReadContext } from './map-record.js';
import type { MapClickOp, MapReadOp, ObservedControl } from './map-reconcile.js';
import { parseMapSnapshot } from './map-snapshot.js';
import { boundTitle, maskPath, normalizeForMatch } from './map-text.js';
import { canonicalOrigin } from './policy.js';

const ERROR_WINDOW_MS = MAP_LIMITS.errorAttributionSeconds * 1_000;
const LANG = /^[a-z]{2,8}$/u;
/** A path segment that names a sign-in page (specs/005-direct-site-routing FR-005). */
const SIGN_IN_PATH = /(?:^|\/)(?:log-?in|sign-?in|auth|sso|oauth2?|session\/new|accounts?\/login)(?:[/._-]|$)/iu;

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
  /**
   * The same click, waiting for a late address change (specs/005-direct-site-routing FR-003). Unlike `pendingClick`
   * it survives reads of the same page; another action in the tab, a navigate or the window ends it.
   */
  lateClick?: { control: ObservedControl; fromPath: string; rawFromPath: string; lang: string | null; context: ReadContext; atMs: number };
  /** Set on a stub after a click left another site: the next read here records that page as an entrance (005 FR-004). */
  entranceFrom?: NonNullable<MapReadOp['entrance']>;
  /** Dialogs and menus this read printed: their count and control keys, so a later click is credited only with new ones (RV-14). */
  openedBefore?: { containers: number; keys: Set<string> };
  /** Set after a click navigated here: no read yet, so nothing on it can be attributed. */
  stub?: true;
  /** The click that led here was attributed to a stored control, so the first read here is that click's destination. */
  attributed?: true;
  /**
   * The tab came here through a content link (a click on a page the map read whose target is no stored control; R-10,
   * RV-01), or from another site (RV-05). Reads of this page record no `read` entry (005 FR-001, SC-004) until the
   * agent opens it by address.
   */
  noReadEntry?: true;
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
  // A redirect to a page whose path names a sign-in step (005 FR-005): the page still exists, the session does not.
  if (landedPath !== requestedPath && SIGN_IN_PATH.test(landed.rawPath)) return { result: 'sign_in', ...moved };
  if (status === 404 || status === 410) return { result: 'not_found' };
  if (status !== undefined && status >= 400) return { result: 'error', statusClass: status >= 500 ? '5xx' : '4xx' };
  return landedPath === requestedPath ? { result: 'same' } : { result: 'elsewhere', landingPath: landedPath };
}

/** Another site's page a click left, as an entrance: its masked path, unless the map excludes it (005 FR-004). */
function entranceOf(input: CaptureInput, from: ParsedUrl): TabRead['entranceFrom'] {
  const masked = maskPath(from.rawPath);
  if (!masked || input.isExcluded(from.origin, from.rawPath, masked.path)) return undefined;
  return { origin: from.origin, path: masked.path, addressable: !masked.masked && !from.query, rawPath: from.rawPath };
}

/** The click op for a click whose address changed only after it returned (005 FR-003). */
function lateClickOp(input: CaptureInput, source: TabRead, late: NonNullable<TabRead['lateClick']>, destination: MapClickOp['destination'], destinationAddressable: boolean): QueuedMapOp {
  return {
    type: 'click',
    opId: `${input.daemonCallId}#late`,
    profile: input.profile,
    origin: source.origin,
    at: input.at,
    fromPath: late.fromPath,
    control: late.control,
    lang: late.lang,
    sourceContext: late.context,
    navigated: true,
    destination,
    destinationAddressable,
    rawPaths: [late.rawFromPath],
  };
}

/** A navigate or snapshot that is in scope: one read op (and, for a navigate, one open op); the cache takes the read. */
function captureRead(cache: TabReadCache, input: CaptureInput, context: CaptureContext): QueuedMapOp[] {
  const page = parseUrl(context.url);
  const masked = page ? maskPath(page.rawPath) : null;
  const navigated = input.tool === 'browser_navigate';
  const previous = cache.get(input.connectionId, input.tabId);
  // A click that did not navigate, now on another address with no other tab action since (005 FR-003). A navigate is the agent's own open.
  const waiting = !navigated && previous?.lateClick && input.nowMs - previous.lateClick.atMs <= ERROR_WINDOW_MS ? previous.lateClick : null;
  const late = waiting && previous && page && masked && (previous.origin !== page.origin || previous.path !== masked.path) ? waiting : null;
  if (!page || !masked || input.isExcluded(page.origin, page.rawPath, masked.path)) {
    cache.delete(input.connectionId, input.tabId);
    // The click still led somewhere: keep the use, not the excluded path (R-13).
    return late && previous && page && previous.origin === page.origin ? [lateClickOp(input, previous, late, { excluded: true }, false)] : [];
  }
  const text = typeof input.result.text === 'string' ? input.result.text : '';
  const withSnapshot = input.tool === 'browser_snapshot' || input.params.snapshot === true;
  const scoped = input.tool === 'browser_snapshot' && (input.params.query !== undefined || input.params.target !== undefined);
  const parsed = parseMapSnapshot(text, { scoped, truncated: input.result.truncated === true });
  const readContext = readContextOf(context.anonymous);
  const lang = langOf(context.lang);
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
  let entrance = previous?.stub && previous.entranceFrom && previous.origin === page.origin ? previous.entranceFrom : undefined;
  if (late && previous) {
    if (previous.origin === page.origin) {
      ops.push(lateClickOp(input, previous, late, { path: masked.path }, addressable));
      // As for a click that navigated at once: the first read here is the click's destination (R-11).
      if (reason === 'refresh') reason = 'destination';
    } else {
      ops.push(lateClickOp(input, previous, late, { origin: page.origin }, false));
      entrance ??= input.isExcluded(previous.origin, late.rawFromPath, late.fromPath) ? undefined : { origin: previous.origin, path: late.fromPath, addressable: previous.addressable, rawPath: late.rawFromPath };
    }
  }
  // Any complete read of a page in scope records it, so a later agent can open it directly (005 FR-001), except a page
  // the tab reached through a content link (R-10, RV-01; its address can name the content) or from another site,
  // by a click or a redirect (RV-05: a sign-in flow through another origin records that origin, never its path).
  const unrecorded =
    (!navigated && previous?.noReadEntry === true && previous.origin === page.origin && previous.path === masked.path) ||
    (requested !== null && requested.origin !== page.origin) ||
    (late !== null && previous?.origin !== page.origin);
  if (reason === 'refresh' && withSnapshot && parsed.complete && !unrecorded) reason = 'read';
  const carry = waiting && !late && previous?.origin === page.origin && previous.path === masked.path ? waiting : undefined;
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
    ...(entrance ? { entrance } : {}),
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
    ...(carry ? { lateClick: carry } : {}),
    ...(unrecorded ? { noReadEntry: true as const } : {}),
    ...(withSnapshot ? { openedBefore: { containers: parsed.openedContainers, keys: new Set(parsed.controls.filter((control) => control.opened).map((control) => control.key)) } } : {}),
  });
  return ops;
}

/** A successful click: a hub read from the cache and the click op, when the target and the source page are known (R-07). */
function captureClick(cache: TabReadCache, input: CaptureInput, context: CaptureContext): QueuedMapOp[] {
  const entry = cache.get(input.connectionId, input.tabId);
  // A new click ends the wait of an earlier one for a late address change (005 FR-003).
  if (entry) entry.lateClick = undefined;
  const from = parseUrl(context.fromUrl);
  const after = parseUrl(context.url);
  const afterMasked = after ? maskPath(after.rawPath) : null;
  const navigated = !!after && !!from && (after.origin !== from.origin || after.rawPath !== from.rawPath);
  const leaveStub = (attributed = false, viaContent = false): void => {
    if (!navigated || !after || !afterMasked) return;
    // Leaving for another site: the next read there records where the tab came from, resolved control or not (005 FR-004).
    const crossOrigin = !!from && after.origin !== from.origin;
    const entranceFrom = from && crossOrigin ? entranceOf(input, from) : undefined;
    cache.set(input.connectionId, input.tabId, { origin: after.origin, rawPath: after.rawPath, path: afterMasked.path, addressable: false, title: null, context: entry?.context ?? 'unknown', lang: null, dir: null, complete: false, readChars: 0, controls: [], refs: new Map(), atMs: input.nowMs, pendingClick: null, stub: true, ...(attributed ? { attributed: true as const } : {}), ...(viaContent || crossOrigin ? { noReadEntry: true as const } : {}), ...(entranceFrom ? { entranceFrom } : {}) });
  };
  if (!entry || entry.stub || !from || entry.origin !== from.origin || entry.rawPath !== from.rawPath) {
    if (entry && !navigated) cache.delete(input.connectionId, input.tabId);
    leaveStub();
    return [];
  }
  const control = resolveTarget(entry, input.params.target);
  if (!control) {
    // On a page the map has read, a target that is no stored control is content (or not eligible); without a read it is unknown (E3).
    leaveStub(false, entry.readChars > 0);
    return [];
  }
  let destination: { path?: string; origin?: string; excluded?: true } | null = null;
  if (navigated && after) {
    if (after.origin !== entry.origin) destination = { origin: after.origin };
    else if (afterMasked) destination = input.isExcluded(entry.origin, after.rawPath, afterMasked.path) ? { excluded: true } : { path: afterMasked.path };
  }
  const base = { profile: input.profile, origin: entry.origin, at: input.at };
  // A JavaScript dialog or a download says nothing about whether the control works: learn, decide no use (R-08).
  const undecided = Boolean(input.result.dialog) || Boolean(input.result.download);
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
    ...(undecided ? { undecided: true } : {}),
    rawPaths: [entry.rawPath],
  };
  if (navigated) {
    leaveStub(!!after && after.origin === entry.origin);
  } else {
    entry.pendingClick = { controlKey: control.key, context: entry.context, atMs: input.nowMs };
    if (!undecided) entry.lateClick = { control: strip(control), fromPath: entry.path, rawFromPath: entry.rawPath, lang: entry.lang, context: entry.context, atMs: input.nowMs };
  }
  return [hub, click];
}

/** Any other action in a tab (typing, keys, scrolling, script, …) ends a click's wait for a late address change (005 FR-003). */
export function noteTabAction(cache: TabReadCache, connectionId: string, tabId: number): void {
  const entry = cache.get(connectionId, tabId);
  if (entry) entry.lateClick = undefined;
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
