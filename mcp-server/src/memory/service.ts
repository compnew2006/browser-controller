import path from 'node:path';
import type { MemoryAdminRequest, MemoryAdminResult, MemoryAdminStatus } from '../daemon-config.js';
import { OBSERVABLE_TOOLS } from '../bridge-frames.js';
import type { MemoryObservation } from '../vault/daemon-routing.js';
import { SITE_CONTEXT_CAPABILITY } from '../protocol.js';
import { adminFromWire, errorCode, runAdminCommand, type AdminContext } from './admin.js';
import { ALLOWLIST, DEFAULT_SHAPE_GATE, shapePath, type CommitMode, type ShapeGate } from './allowlist.js';
import { collectFacts, extractSnapshotFacts, MAX_CANDIDATES } from './facts.js';
import { MapService, type MapLookupResult } from './map-service.js';
import type { JsonMapStore } from './map-store.js';
import { MemoryCursorError, buildMemoryView, buildReminder, unavailableLine, type MemoryView } from './output.js';
import {
  MemoryPolicyError,
  countQuarantinedPolicies,
  defaultPolicy,
  pruneDeletions,
  quarantinePolicy,
  readPolicy,
  writePolicy,
  type MemoryPolicy,
} from './policy.js';
import { MemoryQueue, type CaptureOp, type DropReason } from './queue.js';
import { decideScope, type ScopeDecision, type ScopeSiteContext } from './scope.js';
import { JsonMemoryStore, MemoryStoreError, type MemoryStore, type SiteRecord } from './store.js';
import { snapshotRoles } from './tab-state.js';
import { OutcomeObserver } from './outcome-observer.js';
import type { MemoryToolContext, MemoryToolPurpose } from './tool-route.js';
import { isRecord } from './guards.js';

export { extractSnapshotFacts };
export type { MemoryToolContext };

const MAX_PATH = 120;
const REMINDER_TIMEOUT_MS = 50;
const TOOL_KINDS: readonly string[] = ['all', 'facts', 'visits'];

/** Identity of the extension connection that serves a session; `ambiguous` means another live connection has the same browserId. */
export interface MemoryConnection {
  browserId: string;
  browserLabel?: string;
  connectionId: string;
  ambiguous: boolean;
  supportsSiteContext: boolean;
  /** The extension sends the light `siteContext` for clicks (004, capability `site-map`). */
  supportsSiteMap?: boolean;
}

export interface MemoryServiceDeps {
  memoryDir: string;
  vault: { memoryEligibility(browserId: string, tabId?: number): 'clear' | 'protected' | 'unknown' };
  /** Throws when the session has no connection. */
  connection: (sessionId: string) => MemoryConnection;
  now?: () => number;
  /** Test seam; the default is a JSON store under `memoryDir`. */
  store?: MemoryStore;
  /** Longest wait for the store when building a navigate reminder. */
  reminderTimeoutMs?: number;
  /** Test seam for the site map's store. */
  mapStore?: JsonMapStore;
  /**
   * Which option of OD-1 is in force for the shape fact (007): `option1` keeps it behind 003's anonymity gate,
   * `option2` stores it for every in-scope site. The owner decides; the default is `option1`.
   */
  shapeGate?: ShapeGate;
}


export type MemoryToolResult = ({ success: true } & MemoryView) | MapLookupResult | { success: false; error: string };

/** State taken before the browser call and handed back to `afterCall`. */
export interface MemoryCall {
  /** True for navigate and snapshot while the policy is enabled, and for click while the map is effective (004); the daemon puts it on the extension request. */
  observe: boolean;
  browserId?: string;
  connectionIdBefore?: string;
}

export interface MemoryCallOutcome {
  sessionId: string;
  tool: string;
  params: Record<string, unknown>;
  daemonCallId: string;
  /** What the agent receives: `siteContext` is already removed and the vault already applied. */
  result: unknown;
  observation: MemoryObservation | undefined;
  /** The agent's error text for a failed call; the site map uses it for click use feedback (004 R-08). */
  error?: string;
}

interface ParsedSiteContext extends ScopeSiteContext {
  lang: string | null;
  dir: string | null;
  passwordField: boolean;
  /** The measured form's shape, when the extension reported one (007). */
  formShape?: unknown;
}

function parseSiteContext(raw: unknown): ParsedSiteContext | null {
  if (!isRecord(raw) || typeof raw.url !== 'string') return null;
  if (typeof raw.incognito !== 'boolean' || typeof raw.topLevel !== 'boolean' || typeof raw.stable !== 'boolean') return null;
  const anonymous = raw.anonymous === true ? true : raw.anonymous === false ? false : null;
  return {
    url: raw.url,
    incognito: raw.incognito,
    topLevel: raw.topLevel,
    stable: raw.stable,
    anonymous,
    lang: typeof raw.lang === 'string' ? raw.lang : null,
    dir: typeof raw.dir === 'string' ? raw.dir : null,
    passwordField: raw.passwordField === true,
    ...(isRecord(raw.formShape) ? { formShape: raw.formShape } : {}),
  };
}

/** The code of a failed call: the text before the first colon, as the tools report it (`ELEMENT_HIDDEN: …`). */
function failureCode(error: string | undefined): string | null {
  if (typeof error !== 'string' || error === '') return null;
  const code = error.split(':', 1)[0].trim().toUpperCase();
  return code === '' ? null : code;
}

/** Same document ignoring userinfo and fragment (R-05: the navigate result and the tab must agree). */
function sameDocument(a: unknown, b: string): boolean {
  if (typeof a !== 'string') return false;
  try {
    const left = new URL(a);
    const right = new URL(b);
    for (const url of [left, right]) {
      url.username = '';
      url.password = '';
      url.hash = '';
    }
    return left.href === right.href;
  } catch {
    return false;
  }
}

/** Validates the `browser_memory` input; a string result is the reason it is invalid. */
function parseToolInput(params: Record<string, unknown>): { tabId: number; kind: 'all' | 'facts' | 'visits'; cursor?: string } | string {
  for (const key of Object.keys(params)) if (key !== 'tabId' && key !== 'kind' && key !== 'cursor') return `unknown parameter ${key}`;
  const { tabId, kind, cursor } = params;
  if (typeof tabId !== 'number' || !Number.isInteger(tabId) || tabId < 0) return 'tabId must be a non-negative integer';
  if (kind !== undefined && (typeof kind !== 'string' || !TOOL_KINDS.includes(kind))) return 'kind must be all, facts or visits';
  if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 64)) return 'cursor must be a string of at most 64 characters';
  return { tabId, kind: (kind as 'all' | 'facts' | 'visits' | undefined) ?? 'all', ...(cursor === undefined ? {} : { cursor }) };
}

const DROP_ERROR_CODES: Partial<Record<DropReason, string>> = {
  io_error: 'MEMORY_UNAVAILABLE',
  timeout: 'MEMORY_UNAVAILABLE',
  corrupt: 'MEMORY_CORRUPT',
  capacity: 'MEMORY_FULL',
  queue_full: 'MEMORY_QUEUE_FULL',
};

/**
 * Daemon-side facade for website memory. The daemon calls `beginCall` before a tool call and `afterCall`
 * once the agent's result has been sent; everything here is local and never changes or fails that result
 * (R-15, R-16). Memory is off until `policy.json` says otherwise.
 */
export class MemoryService {
  private readonly memoryDir: string;
  private readonly deps: MemoryServiceDeps;
  private readonly now: () => number;
  private readonly store: MemoryStore;
  private readonly queue: MemoryQueue;
  /** What a browser outcome tells the service: the hidden-control counter and the commit mode (007). */
  private readonly observer: OutcomeObserver;
  private policyTail: Promise<unknown> = Promise.resolve();
  private warmed = false;
  private lastError: { code: string; at: string } | null = null;
  private readonly adminContext: AdminContext;
  /** The site map (specs/004-site-navigation-map). */
  readonly map: MapService;
  /** OD-1: whether the shape fact passes 003's anonymity gate (007). */
  private readonly shapeGate: ShapeGate;

  constructor(deps: MemoryServiceDeps) {
    this.deps = deps;
    this.memoryDir = path.resolve(deps.memoryDir);
    this.now = deps.now ?? Date.now;
    this.shapeGate = deps.shapeGate ?? DEFAULT_SHAPE_GATE;
    this.store = deps.store ?? new JsonMemoryStore(this.memoryDir, { now: this.now });
    this.queue = new MemoryQueue({
      store: this.store,
      memoryDir: this.memoryDir,
      now: this.now,
      onDrop: (_op, reason) => {
        const code = DROP_ERROR_CODES[reason];
        if (code) this.noteError(code);
      },
      onDrained: (drainedThrough) => this.pruneTombstones(drainedThrough),
    });
    this.observer = new OutcomeObserver(
      { connection: (sessionId) => this.deps.connection(sessionId), vault: this.deps.vault },
      this.memoryDir,
      this.queue,
      () => this.now(),
      () => this.iso(),
    );
    this.map = new MapService({
      memoryDir: this.memoryDir,
      now: this.now,
      vault: deps.vault,
      connection: deps.connection,
      ...(deps.mapStore ? { store: deps.mapStore } : {}),
      ...(deps.reminderTimeoutMs !== undefined ? { reminderTimeoutMs: deps.reminderTimeoutMs } : {}),
    });
    this.adminContext = {
      iso: () => this.iso(),
      store: this.store,
      queue: this.queue,
      mutatePolicy: (change, options) => this.mutatePolicy(change, false, options?.resetCorrupt === true),
      status: () => this.status(),
      map: this.map,
    };
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  private noteError(code: string): void {
    this.lastError = { code, at: this.iso() };
  }

  /** Decide, before the call, whether to ask the extension for `siteContext`. Reads the policy; an unreadable policy means off. */
  beginCall(sessionId: string, tool: string): MemoryCall {
    if (!OBSERVABLE_TOOLS.has(tool)) return { observe: false };
    try {
      if (!readPolicy(this.memoryDir).enabled) return { observe: false };
      if (!this.warmed) {
        this.warmed = true;
        void this.store.warm?.();
      }
      const connection = this.deps.connection(sessionId);
      if (tool === 'browser_click' && !this.map.wantsObserve(connection)) return { observe: false };
      return { observe: true, browserId: connection.browserId, connectionIdBefore: connection.connectionId };
    } catch (error) {
      if (error instanceof MemoryPolicyError) this.noteError(error.code);
      return { observe: false };
    }
  }

  /**
   * Capture after the browser outcome is final. Synchronous, never throws, and only enqueues. The site map goes
   * first and shares the one scope decision; it also sees a failed click, which has no observation (004 R-08).
   */
  afterCall(call: MemoryCall, outcome: MemoryCallOutcome): void {
    this.map.noteCall(outcome.sessionId, outcome.tool, outcome.params, outcome.result);
    // The counter and the commit candidate are read from the outcome alone. A failed call carries no
    // observation and no siteContext, so both run before the observe check (007, C7, C8).
    try {
      this.observer.noteHiddenFailure(outcome);
    } catch (error) {
      this.noteError(errorCode(error));
    }
    try {
      this.observer.noteCommitCandidate(outcome);
    } catch (error) {
      this.noteError(errorCode(error));
    }
    if (!call.observe) return;
    const { observation } = outcome;
    let scoped: ReturnType<MemoryService['scopeFor']> | null | undefined;
    const decide = () => (scoped ??= observation ? this.scopeFor('capture', call, outcome, observation) : null);
    this.map.afterCall({
      sessionId: outcome.sessionId,
      tool: outcome.tool,
      params: outcome.params,
      daemonCallId: outcome.daemonCallId,
      result: outcome.result,
      ...(outcome.error !== undefined && !observation ? { error: outcome.error } : {}),
      ...(call.browserId !== undefined ? { browserId: call.browserId } : {}),
      ...(call.connectionIdBefore !== undefined ? { connectionIdBefore: call.connectionIdBefore } : {}),
      siteContext: observation?.siteContext ?? null,
      decide,
    });
    if (!observation || outcome.tool === 'browser_click') return;
    try {
      this.capture(outcome, decide());
    } catch (error) {
      this.noteError(errorCode(error));
    }
  }

  /** One scope decision for the call the daemon just finished, shared by capture and reminder. Throws when the session has no connection. */
  private scopeFor(
    purpose: 'capture' | 'reminder',
    call: MemoryCall,
    outcome: MemoryCallOutcome,
    observation: MemoryObservation,
  ): { decision: ScopeDecision; context: ParsedSiteContext | null; result: Record<string, unknown>; tabId: number | undefined } {
    const policy = readPolicy(this.memoryDir);
    const after = this.deps.connection(outcome.sessionId);
    const result = isRecord(outcome.result) ? outcome.result : {};
    const parsed = parseSiteContext(observation.siteContext);
    const tabId = typeof result.tabId === 'number' ? result.tabId : typeof outcome.params.tabId === 'number' ? outcome.params.tabId : undefined;
    // A navigate whose result URL differs from the tab's URL cannot be attributed to one document.
    const context: ParsedSiteContext | null = parsed && outcome.tool === 'browser_navigate' && !sameDocument(result.url, parsed.url) ? { ...parsed, stable: false } : parsed;
    const decision = decideScope({
      purpose,
      policy,
      browserId: call.browserId ?? '',
      liveConnectionsForBrowserId: after.ambiguous ? 2 : 1,
      connectionIdBefore: call.connectionIdBefore,
      connectionIdAfter: after.connectionId,
      extensionCapabilities: after.supportsSiteContext ? [SITE_CONTEXT_CAPABILITY] : [],
      vault: this.deps.vault.memoryEligibility(call.browserId ?? '', tabId),
      siteContext: context,
      sanitizedUnchanged: observation.sanitizedUnchanged,
    });
    return { decision, context, result, tabId };
  }

  private capture(outcome: MemoryCallOutcome, scoped: ReturnType<MemoryService['scopeFor']> | null): void {
    if (!scoped) return;
    const { decision, context, result, tabId } = scoped;
    if (!decision.in || !context) return;

    const navigated = outcome.tool === 'browser_navigate';
    const { scope } = decision;
    const at = this.iso();
    const base = { profileId: scope.browserId, origin: scope.origin, at, enqueuedAt: at };
    if (navigated) this.queue.enqueue({ ...base, opId: outcome.daemonCallId, type: 'visit', facts: [] });

    // The read is remembered: a later refusal on that tab is attributed to this origin (C7), and a write's
    // commit mode is applied at the next read of the same path (C8).
    let connectionId: string | null;
    try {
      connectionId = this.deps.connection(outcome.sessionId).connectionId;
    } catch {
      connectionId = null;
    }
    if (connectionId !== null && tabId !== undefined) {
      this.observer.tabs.remember(
        connectionId,
        tabId,
        {
          connectionId,
          url: context.url,
          origin: scope.origin,
          path: scope.path,
          anonymous: scope.anonymous,
          roles: snapshotRoles(typeof result.text === 'string' ? result.text : null),
        },
        this.now(),
      );
    }

    const snapshotted = outcome.tool === 'browser_snapshot' || (navigated && outcome.params.snapshot === true);
    if (!snapshotted) return;
    // 003's anonymity gate decides what is kept. Under OD-1's Option 1 the shape fact stands behind it like every
    // other fact; under Option 2 the shape alone passes it, because it holds counts and vocabulary words only and
    // no content from the page. The hidden-control counter never passes through here (C6).
    const anonymous = scope.anonymous === true;
    const shapeOnly = !anonymous && this.shapeGate === 'option2' && context.formShape !== undefined;
    if (!anonymous && !shapeOnly) return;
    // The commit mode is taken only when a shape fact is about to be written: a mode that no fact can carry
    // stays pending for the next read of that path.
    const commit = context.formShape !== undefined && connectionId !== null && shapePath(scope.path) !== null
      ? this.observer.tabs.takeCommitMode(connectionId, scope.origin, scope.path, this.now()) ?? undefined
      : undefined;
    const facts = collectFacts({
      text: typeof result.text === 'string' ? result.text : null,
      lang: context.lang,
      dir: context.dir,
      passwordField: context.passwordField,
      path: scope.path,
      ...(context.formShape !== undefined ? { formShape: context.formShape } : {}),
      ...(commit ? { commit } : {}),
    });
    // Behind the gate every other fact stays behind it: only the shape may pass under Option 2.
    const kept = anonymous ? facts : facts.filter((fact) => fact.kind === 'ui.form.shape');
    if (kept.length === 0) return;
    const op: CaptureOp = {
      ...base,
      opId: navigated ? `${outcome.daemonCallId}#facts` : outcome.daemonCallId,
      type: 'facts',
      facts: kept.slice(0, MAX_CANDIDATES),
      tool: outcome.tool as 'browser_navigate' | 'browser_snapshot',
      ...(scope.path.length <= MAX_PATH ? { path: scope.path } : {}),
    };
    this.queue.enqueue(op);
  }

  /**
   * The result the agent receives for a successful `browser_navigate`: the bounded, labeled reminder is appended to
   * `text` and added as the `memory` array (FR-011, AC-25). It shows what was stored before this call. Without a
   * reminder (memory off, origin excluded, scope unknown, nothing stored) the same result object comes back. A store
   * failure adds only `memory: unavailable (<CODE>)`. Never throws, and waits at most the reminder timeout (R-15).
   */
  async withReminder(call: MemoryCall, outcome: MemoryCallOutcome): Promise<unknown> {
    const { result, observation } = outcome;
    if (!call.observe || outcome.tool !== 'browser_navigate' || !observation || !isRecord(result)) return result;
    try {
      const { decision } = this.scopeFor('reminder', call, outcome, observation);
      if (!decision.in) return result;
      const { origin, browserId, path: rawPath } = decision.scope;
      const mapRead = this.map.startReminder(origin, browserId, rawPath);
      const memoryLines = (await this.reminderLines(origin, browserId, typeof result.tabId === 'number' ? result.tabId : undefined)) ?? [];
      const mapLines = mapRead ? this.map.reminderLines(await mapRead, rawPath, memoryLines) : null;
      const lines = [...memoryLines, ...(mapLines ?? [])];
      if (lines.length === 0) return result;
      return { ...result, ...(typeof result.text === 'string' ? { text: `${result.text}\n${lines.join('\n')}` } : {}), memory: lines };
    } catch (error) {
      this.noteError(errorCode(error));
      return result;
    }
  }

  private async reminderLines(origin: string, profileId: string, tabId: number | undefined): Promise<string[] | null> {
    try {
      const site = await this.readSite(origin, this.deps.reminderTimeoutMs ?? REMINDER_TIMEOUT_MS);
      return buildReminder(origin, site, profileId, { tabId })?.lines ?? null;
    } catch (error) {
      const code = errorCode(error);
      this.noteError(code);
      return [unavailableLine(code)];
    }
  }

  private async readSite(origin: string, timeoutMs: number): Promise<SiteRecord | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new MemoryStoreError('MEMORY_UNAVAILABLE', 'the store did not answer in time')), timeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([this.store.getSite(origin), expired]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Before the daemon reads a tab for a memory tool. `read` (browser_memory) refuses while memory is off or the
   * extension lacks site-context, so the extension is never called; `policy` refuses nothing. Both give the
   * connection the read starts on, which `handleTool` compares with the connection after it. Never throws.
   */
  prepareTool(sessionId: string, purpose: MemoryToolPurpose): { connectionId: string | null } | { error: string } {
    try {
      if (purpose === 'read' && !readPolicy(this.memoryDir).enabled) return { error: 'MEMORY_DISABLED: website memory is off; the owner controls it.' };
    } catch (error) {
      const code = errorCode(error);
      this.noteError(code);
      return { error: `${code === 'MEMORY_CORRUPT' ? 'MEMORY_CORRUPT' : 'MEMORY_UNAVAILABLE'}: website memory could not be read.` };
    }
    let connection: MemoryConnection;
    try {
      connection = this.deps.connection(sessionId);
    } catch {
      return purpose === 'read' ? { error: 'MEMORY_UNAVAILABLE: no browser extension is connected for this session.' } : { connectionId: null };
    }
    if (purpose === 'read' && !connection.supportsSiteContext) return { error: 'MEMORY_NOT_SUPPORTED: the connected browser extension does not support website memory.' };
    return { connectionId: connection.connectionId };
  }

  /** The session's verified profile for a `map_*` request (004 R-20); reading a map also needs the vault clear. Never throws. */
  mapIdentity(sessionId: string, purpose: 'change' | 'read'): { profile: string; label: string } | { error: string } {
    let connection: MemoryConnection;
    try {
      connection = this.deps.connection(sessionId);
    } catch {
      return { error: 'MEMORY_UNAVAILABLE: no browser extension is connected for this session.' };
    }
    if (connection.browserId === 'default' || connection.ambiguous) return { error: "MEMORY_SCOPE_UNKNOWN: this session's browser profile could not be verified, so nothing was changed." };
    if (purpose === 'read' && this.deps.vault.memoryEligibility(connection.browserId) !== 'clear') {
      return { error: "MEMORY_SCOPE_UNKNOWN: this session's browser profile is protected by the credential vault." };
    }
    return { profile: connection.browserId, label: connection.browserLabel || connection.browserId };
  }

  /**
   * `browser_memory {tabId, kind?, cursor?}` for the verified profile and the origin of the tab's current page. The
   * profile and origin come from the connection and the extension, never from the parameters (AC-26). Failures are
   * `CODE: message`; none names a policy command or carries page content (R-12).
   */
  async handleTool(tool: string, params: Record<string, unknown>, sessionId: string, context: MemoryToolContext): Promise<MemoryToolResult> {
    const fail = (code: string, message: string): MemoryToolResult => ({ success: false, error: `${code}: ${message}` });
    try {
      if (tool === 'browser_site_map') return await this.map.lookup(params, sessionId, (tabId) => this.toolDecision(sessionId, context, tabId));
      if (tool !== 'browser_memory') return fail('INVALID_ARGUMENT', `unknown memory tool ${tool}`);
      const input = parseToolInput(params);
      if (typeof input === 'string') return fail('INVALID_ARGUMENT', input);

      if (!readPolicy(this.memoryDir).enabled) return fail('MEMORY_DISABLED', 'website memory is off; the owner controls it.');
      // The connection now, after the context read; the one before it came from prepareTool (R-04).
      if (!this.deps.connection(sessionId).supportsSiteContext) return fail('MEMORY_NOT_SUPPORTED', 'the connected browser extension does not support website memory.');
      const decision = this.toolDecision(sessionId, context, input.tabId);
      if (!decision.in) {
        if (decision.outcome === 'disabled') return fail('MEMORY_DISABLED', 'website memory is off; the owner controls it.');
        if (decision.outcome === 'excluded') return fail('MEMORY_EXCLUDED', 'this site is excluded from website memory.');
        if (decision.reason === 'no_site_context_capability') return fail('MEMORY_NOT_SUPPORTED', 'the connected browser extension does not support website memory.');
        return fail('MEMORY_SCOPE_UNKNOWN', "this tab's profile, site or privacy state could not be verified, so no memory is shown.");
      }
      const site = await this.readSite(decision.scope.origin, this.deps.reminderTimeoutMs ?? REMINDER_TIMEOUT_MS * 4);
      const view = buildMemoryView(decision.scope.origin, site, decision.scope.browserId, input);
      return { success: true, ...view };
    } catch (error) {
      if (error instanceof MemoryCursorError) return fail('INVALID_ARGUMENT', 'cursor is not valid.');
      const code = errorCode(error);
      this.noteError(code);
      return fail(code === 'MEMORY_CORRUPT' ? 'MEMORY_CORRUPT' : 'MEMORY_UNAVAILABLE', 'website memory could not be read.');
    }
  }

  /** The scope of a memory tool's tab read: the context the daemon read, checked against the connection now (R-04). */
  private toolDecision(sessionId: string, context: MemoryToolContext, tabId: number): ScopeDecision {
    const after = this.deps.connection(sessionId);
    return decideScope({
      purpose: 'reminder',
      policy: readPolicy(this.memoryDir),
      browserId: after.browserId,
      liveConnectionsForBrowserId: after.ambiguous ? 2 : 1,
      connectionIdBefore: context.connectionIdBefore ?? undefined,
      connectionIdAfter: after.connectionId,
      extensionCapabilities: after.supportsSiteContext ? [SITE_CONTEXT_CAPABILITY] : [],
      vault: this.deps.vault.memoryEligibility(after.browserId, tabId),
      siteContext: parseSiteContext(context.siteContext),
      sanitizedUnchanged: true,
    });
  }

  /** Tombstones the queue has drained past are removed through the one policy writer. */
  private pruneTombstones(drainedThrough: string): void {
    this.mutatePolicy((policy) => pruneDeletions(policy, drainedThrough, this.iso()), true).catch((error) => this.noteError(errorCode(error)));
  }

  /**
   * Every policy change runs here, one at a time. With `skipUnchanged`, an unchanged policy is not written. With
   * `resetCorrupt` (the owner's `disable` and `delete`), an unreadable policy is set aside and the change starts
   * from the disabled default; every other change refuses with MEMORY_CORRUPT.
   */
  private mutatePolicy(change: (policy: MemoryPolicy) => MemoryPolicy, skipUnchanged = false, resetCorrupt = false): Promise<MemoryPolicy> {
    const run = this.policyTail.then(async () => {
      let current: MemoryPolicy;
      try {
        current = readPolicy(this.memoryDir);
      } catch (error) {
        if (!resetCorrupt || !(error instanceof MemoryPolicyError) || error.code !== 'MEMORY_CORRUPT') throw error;
        quarantinePolicy(this.memoryDir, this.now());
        current = defaultPolicy();
      }
      const next = change(current);
      if (skipUnchanged && next === current) return current;
      await writePolicy(this.memoryDir, next);
      this.map.invalidate();
      return next;
    });
    this.policyTail = run.catch(() => undefined);
    return run;
  }

  async status(): Promise<MemoryAdminStatus> {
    let enabled = false;
    try {
      enabled = readPolicy(this.memoryDir).enabled;
    } catch (error) {
      this.noteError(errorCode(error));
    }
    let stored: Awaited<ReturnType<MemoryStore['status']>> = { origins: 0, totalBytes: 0, corrupt: [] };
    try {
      stored = await this.store.status();
    } catch (error) {
      this.noteError(errorCode(error));
    }
    const stats = this.queue.stats();
    return {
      enabled,
      origins: stored.origins,
      bytes: stored.totalBytes,
      queueDepth: stats.pending,
      dropped: { ...stats.dropped },
      lastError: this.lastError,
      quarantined: stored.corrupt.length + countQuarantinedPolicies(this.memoryDir),
    };
  }

  /** Validates an untrusted `memory-admin` line, then runs it. Always answers; never throws. */
  adminFromWire(raw: unknown): Promise<MemoryAdminResult> {
    return adminFromWire(this.adminContext, raw);
  }

  admin(request: MemoryAdminRequest): Promise<MemoryAdminResult> {
    return runAdminCommand(this.adminContext, request);
  }

  /** Resolves when no capture is queued or being written. Used by tests and shutdown. */
  async flush(): Promise<void> {
    await this.queue.drain();
    await this.policyTail;
    await this.map.flush();
  }
}
