/**
 * The site-map facade that MemoryService composes (specs/004-site-navigation-map research R-01, R-16, R-17, R-21).
 * It decides whether clicks are observed, turns finished calls into queued ops, answers `browser_site_map`, adds the
 * map block to navigate reminders, and runs owner changes. Every failure is caught here: a browser result is never
 * changed or failed by the map, apart from one `map: unavailable (<CODE>)` reminder line. Local only.
 */
import { randomUUID } from 'node:crypto';
import { captureMapOps, noteTabAction, TabReadCache, type CaptureContext } from './map-capture.js';
import { buildMapLookup, buildMapOutline, buildMapReminder, MapCursorError, mapUnavailableLine, type MapLookup } from './map-output.js';
import {
  defaultMapPolicy,
  isPathExcluded,
  pruneMapTombstones,
  quarantineMapPolicy,
  readMapPolicy,
  writeMapPolicy,
  type MapPolicy,
} from './map-policy.js';
import { MapQueue, sanitizePolicyFor, type MapDropReason } from './map-queue.js';
import { sanitizeRecord } from './map-reconcile.js';
import type { MapRecord } from './map-record.js';
import { JsonMapStore } from './map-store.js';
import { maskPath, normalizeForMatch } from './map-text.js';
import { MemoryPolicyError, canonicalOrigin, readPolicy, type MemoryPolicy } from './policy.js';
import type { ScopeDecision } from './scope.js';
import { MemoryStoreError } from './site-record.js';

/**
 * Calls that leave the page as it is, or that capture already handles (navigate, snapshot, click). Any other call on
 * a tab is an action that ends a click's wait for a late address change (specs/005-direct-site-routing FR-003).
 */
const NOT_TAB_ACTIONS: ReadonlySet<string> = new Set([
  'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_text', 'browser_screenshot', 'browser_wait', 'browser_tabs',
  'browser_inspect_element', 'browser_logs', 'browser_site_map', 'browser_memory', 'browser_memory_policy', 'browser_safety',
]);
const VAULT_READS: ReadonlySet<unknown> = new Set(['status', 'list']);

const LOOKUP_TIMEOUT_MS = 200;
const REMINDER_TIMEOUT_MS = 50;
const CURSOR = /^p\d{1,4}$/u;

export interface MapConnection {
  browserId: string;
  browserLabel?: string;
  connectionId: string;
  ambiguous: boolean;
  supportsSiteContext: boolean;
  supportsSiteMap?: boolean;
}

export interface MapServiceDeps {
  memoryDir: string;
  now: () => number;
  vault: { memoryEligibility(browserId: string, tabId?: number): 'clear' | 'protected' | 'unknown' };
  connection: (sessionId: string) => MapConnection;
  store?: JsonMapStore;
  reminderTimeoutMs?: number;
  lookupTimeoutMs?: number;
}

/** What MemoryService hands over for one finished call. */
export interface MapCallInput {
  sessionId: string;
  tool: string;
  params: Record<string, unknown>;
  daemonCallId: string;
  result: unknown;
  error?: string;
  browserId?: string;
  connectionIdBefore?: string;
  /** The raw siteContext block (for `fromUrl`), and the shared scope decision for it. */
  siteContext: unknown;
  decide: () => { decision: ScopeDecision; context: { url: string; anonymous: boolean | null; lang: string | null; dir: string | null; passwordField: boolean } | null } | null;
}

export type MapLookupResult = MapLookup | { success: false; error: string };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Errors thrown by the map policy read in `readPolicies`, so a failure is reported against the file that failed. */
const MAP_POLICY_FAILURES = new WeakSet<Error>();

export function mapErrorCode(error: unknown): string {
  return error instanceof MemoryPolicyError || error instanceof MemoryStoreError ? error.code : 'MEMORY_UNAVAILABLE';
}

/** `example.com` tries https, then the www or non-www form; an http(s) origin is used as given (R-16, CHK015). */
export function originCandidates(value: string): string[] | null {
  if (/^https?:\/\//iu.test(value)) {
    try {
      const url = new URL(value);
      if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash || url.username || url.password) return null;
    } catch {
      return null;
    }
    const origin = canonicalOrigin(value);
    return origin ? [origin] : null;
  }
  if (!/^[a-z0-9.-]+(?::\d{1,5})?$/iu.test(value) || !value.includes('.')) return null;
  const host = value.toLowerCase();
  const first = canonicalOrigin(`https://${host}`);
  if (!first) return null;
  const second = canonicalOrigin(`https://${host.startsWith('www.') ? host.slice(4) : `www.${host}`}`);
  return second && second !== first ? [first, second] : [first];
}

function parseLookup(params: Record<string, unknown>): { tabId?: number; origin?: string; query?: string; cursor?: string } | string {
  for (const key of Object.keys(params)) if (!['tabId', 'origin', 'query', 'cursor'].includes(key)) return `unknown parameter ${key.slice(0, 40)}`;
  const { tabId, origin, query, cursor } = params;
  if ((tabId === undefined) === (origin === undefined)) return 'give exactly one of tabId and origin';
  if (tabId !== undefined && (typeof tabId !== 'number' || !Number.isInteger(tabId) || tabId < 0)) return 'tabId must be a non-negative integer';
  if (origin !== undefined && (typeof origin !== 'string' || origin.length === 0 || origin.length > 300)) return 'origin must be a string of at most 300 characters';
  if (query !== undefined && (typeof query !== 'string' || query.trim().length === 0 || query.length > 100)) return 'query must be 1-100 characters';
  if (cursor !== undefined && (typeof cursor !== 'string' || !CURSOR.test(cursor))) return 'cursor is not valid';
  return {
    ...(tabId !== undefined ? { tabId: tabId as number } : {}),
    ...(origin !== undefined ? { origin: origin as string } : {}),
    ...(query !== undefined ? { query: query as string } : {}),
    ...(cursor !== undefined ? { cursor: cursor as string } : {}),
  };
}

export class MapService {
  readonly cache = new TabReadCache();
  readonly store: JsonMapStore;
  readonly queue: MapQueue;
  readonly memoryDir: string;
  private readonly deps: MapServiceDeps;
  private readonly dropped = new Map<string, number>();
  private policyTail: Promise<unknown> = Promise.resolve();
  private lastConnectionId: string | null = null;
  private lastError: { code: string; at: string } | null = null;

  constructor(deps: MapServiceDeps) {
    this.deps = deps;
    this.memoryDir = deps.memoryDir;
    this.store = deps.store ?? new JsonMapStore(deps.memoryDir, { now: deps.now });
    this.queue = new MapQueue({
      store: this.store,
      memoryDir: deps.memoryDir,
      now: deps.now,
      onDrop: (op, reason) => {
        if (reason !== 'duplicate') this.dropped.set(op.profile, (this.dropped.get(op.profile) ?? 0) + 1);
        const code = ({ io_error: 'MEMORY_UNAVAILABLE', timeout: 'MEMORY_UNAVAILABLE', corrupt: 'MEMORY_CORRUPT', capacity: 'MEMORY_FULL', queue_full: 'MEMORY_QUEUE_FULL' } as Partial<Record<MapDropReason, string>>)[reason];
        if (code) this.noteError(code);
      },
      onDrained: (drainedThrough) => {
        // Pruning drops only tombstones whose work is gone; it changes no owner choice, so the tab cache stays.
        this.mutateMapPolicy((policy) => pruneMapTombstones(policy, drainedThrough, this.iso()), { skipUnchanged: true, keepCache: true }).catch((error) => this.noteError(mapErrorCode(error)));
      },
    });
  }

  iso(): string {
    return new Date(this.deps.now()).toISOString();
  }

  noteError(code: string): void {
    this.lastError = { code, at: this.iso() };
  }

  /** Observations dropped for a profile since the daemon started (any reason but a replayed opId). */
  droppedFor(profile: string): number {
    return this.dropped.get(profile) ?? 0;
  }

  get lastErrorCode(): { code: string; at: string } | null {
    return this.lastError;
  }

  readPolicies(): { memory: MemoryPolicy; map: MapPolicy } {
    const memory = readPolicy(this.memoryDir);
    try {
      return { memory, map: readMapPolicy(this.memoryDir) };
    } catch (error) {
      if (error instanceof Error) MAP_POLICY_FAILURES.add(error);
      throw error;
    }
  }

  /** The map is effective for a profile: website memory on and the map on for it (R-04). Never throws. */
  enabledFor(browserId: string): boolean {
    try {
      const { memory, map } = this.readPolicies();
      return memory.enabled && map.profiles[browserId]?.enabled === true;
    } catch (error) {
      this.noteError(mapErrorCode(error));
      return false;
    }
  }

  /** Whether `browser_click` is observed for this connection (R-06). */
  wantsObserve(connection: MapConnection): boolean {
    return connection.supportsSiteMap === true && !connection.ambiguous && connection.browserId !== 'default' && this.enabledFor(connection.browserId);
  }

  /** Any policy change or delete clears the tab cache (data-model "TabReadCache"). */
  invalidate(): void {
    this.cache.clear();
  }

  /** Every finished daemon call, observed or not. Synchronous, never throws, touches the tab cache only. */
  noteCall(sessionId: string, tool: string, params: Record<string, unknown>, result: unknown): void {
    if (this.cache.size === 0 || NOT_TAB_ACTIONS.has(tool) || (tool === 'browser_vault' && VAULT_READS.has(params.action))) return;
    try {
      const tabId = isRecord(result) && typeof result.tabId === 'number' ? result.tabId : typeof params.tabId === 'number' ? params.tabId : undefined;
      if (tabId === undefined) return;
      noteTabAction(this.cache, this.deps.connection(sessionId).connectionId, tabId);
    } catch {
      // No connection: nothing is cached for it either.
    }
  }

  /** Capture after the browser outcome is final. Synchronous, never throws, and only enqueues. */
  afterCall(input: MapCallInput): void {
    try {
      this.capture(input);
    } catch (error) {
      this.noteError(mapErrorCode(error));
    }
  }

  private capture(input: MapCallInput): void {
    const profile = input.browserId;
    if (!profile || profile === 'default') return;
    const after = this.deps.connection(input.sessionId);
    if (this.lastConnectionId !== after.connectionId) {
      this.cache.dropOtherConnections(after.connectionId);
      this.lastConnectionId = after.connectionId;
    }
    if (after.connectionId !== input.connectionIdBefore || after.browserId !== profile || after.ambiguous) return;
    if (input.tool === 'browser_click' && !after.supportsSiteMap) return;
    const { memory, map } = this.readPolicies();
    if (!memory.enabled || map.profiles[profile]?.enabled !== true) return;
    const result = isRecord(input.result) ? input.result : {};
    const tabId = typeof result.tabId === 'number' ? result.tabId : typeof input.params.tabId === 'number' ? input.params.tabId : undefined;
    if (tabId === undefined) return;

    let context: CaptureContext | null = null;
    if (input.error === undefined) {
      const scoped = input.decide();
      if (!scoped || !scoped.decision.in || !scoped.context) {
        this.cache.delete(after.connectionId, tabId);
        return;
      }
      const raw = isRecord(input.siteContext) ? input.siteContext : {};
      context = { ...scoped.context, fromUrl: typeof raw.fromUrl === 'string' ? raw.fromUrl : null };
    } else if (input.tool !== 'browser_click' || this.deps.vault.memoryEligibility(profile, tabId) !== 'clear') {
      return;
    }
    const ops = captureMapOps(this.cache, {
      tool: input.tool,
      params: input.params,
      result,
      ...(input.error !== undefined ? { error: input.error } : {}),
      daemonCallId: input.daemonCallId,
      at: this.iso(),
      nowMs: this.deps.now(),
      profile,
      connectionId: after.connectionId,
      tabId,
      context,
      isExcluded: (origin, rawPath, path) => isPathExcluded(map, origin, rawPath, path),
    });
    for (const op of ops) this.queue.enqueue(op);
  }

  /**
   * Bring a record read from the store in line with the policy now, in place; true when that removed something.
   * Every read that answers an agent or the owner goes through it, so an exclusion or delete whose file rewrite
   * failed is still never served (AC-16, AC-34). Throws when a policy cannot be read.
   */
  applyPolicy(record: MapRecord): boolean {
    const { memory, map } = this.readPolicies();
    return sanitizeRecord(record, sanitizePolicyFor(memory, map, record.profile, record.origin));
  }

  private async readMap(profile: string, origin: string, timeoutMs: number): Promise<MapRecord | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new MemoryStoreError('MEMORY_UNAVAILABLE', 'the map store did not answer in time')), timeoutMs);
      timer.unref?.();
    });
    try {
      const record = await Promise.race([this.store.getMap(profile, origin), expired]);
      if (record) this.applyPolicy(record);
      return record;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Starts the reminder's map read in parallel with 003's; `reminderLines` finishes it. Null when the map is off for this page. */
  startReminder(origin: string, profile: string, rawPath: string): Promise<MapRecord | null | { code: string }> | null {
    try {
      const { memory, map } = this.readPolicies();
      if (!memory.enabled || map.profiles[profile]?.enabled !== true || isPathExcluded(map, origin, rawPath, maskPath(rawPath)?.path)) return null;
    } catch (error) {
      this.noteError(mapErrorCode(error));
      return null;
    }
    return this.readMap(profile, origin, this.deps.reminderTimeoutMs ?? REMINDER_TIMEOUT_MS).catch((error: unknown) => {
      const code = mapErrorCode(error);
      this.noteError(code);
      return { code };
    });
  }

  /** The map block after 003's lines (R-17); controls already in 003's lines are left out. */
  reminderLines(read: MapRecord | null | { code: string }, rawPath: string, shown: readonly string[]): string[] | null {
    if (read && 'code' in read) return [mapUnavailableLine(read.code)];
    const masked = maskPath(rawPath);
    const text = normalizeForMatch(shown.join('\n'));
    return buildMapReminder(read, masked?.path ?? rawPath, (_role, name) => text.includes(normalizeForMatch(name)));
  }

  /**
   * `browser_site_map` (R-16). With `tabId` the origin and profile come from the tab's scope decision; with
   * `origin` the profile comes from the session's connection and must be verified. Never lists origins.
   */
  async lookup(params: Record<string, unknown>, sessionId: string, tabDecision: (tabId: number) => ScopeDecision): Promise<MapLookupResult> {
    const fail = (code: string, message: string): MapLookupResult => ({ success: false, error: `${code}: ${message}` });
    // Each policy failure names its policy, so the owner is sent to the reset that fixes the file that failed.
    const policyFailure = (error: unknown, subject: string, reset: string): MapLookupResult => {
      const code = mapErrorCode(error);
      this.noteError(code);
      return error instanceof MemoryPolicyError && code === 'MEMORY_CORRUPT'
        ? fail('MEMORY_CORRUPT', `${subject} could not be read; ${reset}`)
        : fail('MAP_UNAVAILABLE', `${subject} could not be read.`);
    };
    try {
      const input = parseLookup(params);
      if (typeof input === 'string') return fail('INVALID_ARGUMENT', input);
      let memory: MemoryPolicy;
      let map: MapPolicy;
      try {
        memory = readPolicy(this.memoryDir);
      } catch (error) {
        return policyFailure(error, 'the memory policy', 'the owner can reset it.');
      }
      try {
        map = readMapPolicy(this.memoryDir);
      } catch (error) {
        return policyFailure(error, 'the site map policy', 'the owner can reset it with map disable or map delete --all.');
      }
      if (!memory.enabled) return fail('MEMORY_DISABLED', 'website memory is off; the owner controls it.');
      let profile: string;
      let candidates: string[];
      if (input.tabId !== undefined) {
        const decision = tabDecision(input.tabId);
        if (!decision.in) {
          if (decision.outcome === 'disabled') return fail('MEMORY_DISABLED', 'website memory is off; the owner controls it.');
          if (decision.outcome === 'excluded') return fail('MEMORY_EXCLUDED', 'this site is excluded from website memory.');
          if (decision.reason === 'no_site_context_capability') return fail('MEMORY_NOT_SUPPORTED', 'the connected browser extension does not support website memory.');
          return fail('MEMORY_SCOPE_UNKNOWN', "this tab's profile, site or privacy state could not be verified, so no map is shown.");
        }
        profile = decision.scope.browserId;
        candidates = [decision.scope.origin];
      } else {
        const named = originCandidates(input.origin as string);
        if (!named) return fail('INVALID_ARGUMENT', 'origin must be an http(s) origin or a host name.');
        let connection: MapConnection;
        try {
          connection = this.deps.connection(sessionId);
        } catch {
          return fail('MEMORY_SCOPE_UNKNOWN', 'no browser extension is connected for this session.');
        }
        if (!connection.supportsSiteContext) return fail('MEMORY_NOT_SUPPORTED', 'the connected browser extension does not support website memory.');
        if (connection.browserId === 'default' || connection.ambiguous) return fail('MEMORY_SCOPE_UNKNOWN', "this session's browser profile could not be verified.");
        if (this.deps.vault.memoryEligibility(connection.browserId) !== 'clear') return fail('MEMORY_SCOPE_UNKNOWN', "this session's browser profile is protected by the credential vault.");
        profile = connection.browserId;
        candidates = named.filter((origin) => !memory.excluded.includes(origin));
        if (candidates.length === 0) return fail('MEMORY_EXCLUDED', 'this site is excluded from website memory.');
      }
      if (map.profiles[profile]?.enabled !== true) return fail('MAP_DISABLED', 'the site map is off for this browser profile; the owner controls it.');

      let origin = candidates[0];
      let record: MapRecord | null = null;
      for (const candidate of candidates) {
        record = await this.readMap(profile, candidate, this.deps.lookupTimeoutMs ?? LOOKUP_TIMEOUT_MS);
        if (record) {
          origin = candidate;
          break;
        }
      }
      const target = input.tabId !== undefined ? `tabId: ${input.tabId}` : `origin: ${JSON.stringify(origin)}`;
      const view = input.query === undefined
        ? buildMapOutline(origin, record)
        : buildMapLookup(origin, record, { query: input.query, ...(input.cursor !== undefined ? { cursor: input.cursor } : {}), nextArgs: (cursor) => `browser_site_map {${target}, query: ${JSON.stringify(input.query)}, cursor: "${cursor}"}` });
      this.queue.count({ opId: `lookup-${randomUUID()}`, profile, at: this.iso(), field: 'lookups', delta: 1 });
      return view;
    } catch (error) {
      if (error instanceof MapCursorError) return fail('INVALID_ARGUMENT', 'cursor is not valid.');
      // A policy read again later (the tab's scope, the re-check of a map read) failed.
      if (error instanceof MemoryPolicyError) {
        return MAP_POLICY_FAILURES.has(error)
          ? policyFailure(error, 'the site map policy', 'the owner can reset it with map disable or map delete --all.')
          : policyFailure(error, 'the memory policy', 'the owner can reset it.');
      }
      this.noteError(mapErrorCode(error));
      return fail('MAP_UNAVAILABLE', 'the site map could not be read.');
    }
  }

  /**
   * Every map policy change runs here, one at a time; the tab cache is cleared after it unless `keepCache`
   * (housekeeping only). With `resetCorrupt` (map disable and delete --all) an unreadable file is set aside and
   * the change starts from the default (R-21).
   */
  mutateMapPolicy(change: (policy: MapPolicy) => MapPolicy, options: { skipUnchanged?: boolean; resetCorrupt?: boolean; keepCache?: boolean } = {}): Promise<MapPolicy> {
    const run = this.policyTail.then(async () => {
      let current: MapPolicy;
      try {
        current = readMapPolicy(this.memoryDir);
      } catch (error) {
        if (!options.resetCorrupt || !(error instanceof MemoryPolicyError) || error.code !== 'MEMORY_CORRUPT') throw error;
        quarantineMapPolicy(this.memoryDir, this.deps.now());
        current = defaultMapPolicy();
      }
      const next = change(current);
      if (options.skipUnchanged && next === current) return current;
      await writeMapPolicy(this.memoryDir, next);
      if (!options.keepCache) this.invalidate();
      return next;
    });
    this.policyTail = run.catch(() => undefined);
    return run;
  }

  /** Resolves when no map work is queued or being written, and no policy write is pending. */
  async flush(): Promise<void> {
    await this.queue.drain();
    await this.policyTail;
  }
}

