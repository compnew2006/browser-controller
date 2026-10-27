import path from 'node:path';
import type { MemoryAdminRequest, MemoryAdminResult, MemoryAdminStatus } from '../daemon-config.js';
import { OBSERVABLE_TOOLS } from '../bridge-frames.js';
import type { MemoryObservation } from '../vault/daemon-routing.js';
import { SITE_CONTEXT_CAPABILITY } from '../protocol.js';
import { adminFromWire, errorCode, runAdminCommand, type AdminContext } from './admin.js';
import { collectFacts, extractSnapshotFacts, MAX_CANDIDATES } from './facts.js';
import { MemoryCursorError, buildMemoryView, buildReminder, unavailableLine, type MemoryView } from './output.js';
import { MemoryPolicyError, pruneDeletions, readPolicy, writePolicy, type MemoryPolicy } from './policy.js';
import { MemoryQueue, type CaptureOp, type DropReason } from './queue.js';
import { decideScope, type ScopeDecision, type ScopeSiteContext } from './scope.js';
import { JsonMemoryStore, MemoryStoreError, type MemoryStore, type SiteRecord } from './store.js';

export { extractSnapshotFacts };

const MAX_PATH = 120;
const REMINDER_TIMEOUT_MS = 50;
const TOOL_KINDS: readonly string[] = ['all', 'facts', 'visits'];

/** Identity of the extension connection that serves a session; `ambiguous` means another live connection has the same browserId. */
export interface MemoryConnection {
  browserId: string;
  connectionId: string;
  ambiguous: boolean;
  supportsSiteContext: boolean;
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
}

/** What the daemon hands `handleTool` besides the validated agent arguments. */
export interface MemoryToolContext {
  /** The tab's `siteContext` from the extension (internal action `browser_memory_internal_context`, under the tab lock), or null. Never agent-supplied. */
  siteContext: unknown;
}

export type MemoryToolResult = ({ success: true } & MemoryView) | { success: false; error: string };

/** State taken before the browser call and handed back to `afterCall`. */
export interface MemoryCall {
  /** True only for navigate and snapshot while the policy is enabled; the daemon puts it on the extension request. */
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
}

interface ParsedSiteContext extends ScopeSiteContext {
  lang: string | null;
  dir: string | null;
  passwordField: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

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
  };
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
  private policyTail: Promise<unknown> = Promise.resolve();
  private warmed = false;
  private lastError: { code: string; at: string } | null = null;
  private readonly adminContext: AdminContext;

  constructor(deps: MemoryServiceDeps) {
    this.deps = deps;
    this.memoryDir = path.resolve(deps.memoryDir);
    this.now = deps.now ?? Date.now;
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
    this.adminContext = {
      iso: () => this.iso(),
      store: this.store,
      queue: this.queue,
      mutatePolicy: (change) => this.mutatePolicy(change),
      status: () => this.status(),
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
      return { observe: true, browserId: connection.browserId, connectionIdBefore: connection.connectionId };
    } catch (error) {
      if (error instanceof MemoryPolicyError) this.noteError(error.code);
      return { observe: false };
    }
  }

  /** Capture after the browser outcome is final. Synchronous, never throws, and only enqueues. */
  afterCall(call: MemoryCall, outcome: MemoryCallOutcome): void {
    if (!call.observe || !outcome.observation) return;
    try {
      this.capture(call, outcome, outcome.observation);
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
  ): { decision: ScopeDecision; context: ParsedSiteContext | null; result: Record<string, unknown> } {
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
    return { decision, context, result };
  }

  private capture(call: MemoryCall, outcome: MemoryCallOutcome, observation: MemoryObservation): void {
    const { decision, context, result } = this.scopeFor('capture', call, outcome, observation);
    if (!decision.in || !context) return;

    const navigated = outcome.tool === 'browser_navigate';
    const { scope } = decision;
    const at = this.iso();
    const base = { profileId: scope.browserId, origin: scope.origin, at, enqueuedAt: at };
    if (navigated) this.queue.enqueue({ ...base, opId: outcome.daemonCallId, type: 'visit', facts: [] });

    const snapshotted = outcome.tool === 'browser_snapshot' || (navigated && outcome.params.snapshot === true);
    if (!snapshotted || scope.anonymous !== true) return;
    const facts = collectFacts({
      text: typeof result.text === 'string' ? result.text : null,
      lang: context.lang,
      dir: context.dir,
      passwordField: context.passwordField,
      path: scope.path,
    });
    if (facts.length === 0) return;
    const op: CaptureOp = {
      ...base,
      opId: navigated ? `${outcome.daemonCallId}#facts` : outcome.daemonCallId,
      type: 'facts',
      facts: facts.slice(0, MAX_CANDIDATES),
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
      const lines = await this.reminderLines(decision.scope.origin, decision.scope.browserId, typeof result.tabId === 'number' ? result.tabId : undefined);
      if (!lines) return result;
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
   * `browser_memory {tabId, kind?, cursor?}` for the verified profile and the origin of the tab's current page. The
   * profile and origin come from the connection and the extension, never from the parameters (AC-26). Failures are
   * `CODE: message`; none names a policy command or carries page content (R-12).
   */
  async handleTool(tool: string, params: Record<string, unknown>, sessionId: string, context: MemoryToolContext): Promise<MemoryToolResult> {
    const fail = (code: string, message: string): MemoryToolResult => ({ success: false, error: `${code}: ${message}` });
    try {
      if (tool !== 'browser_memory') return fail('INVALID_ARGUMENT', `unknown memory tool ${tool}`);
      const input = parseToolInput(params);
      if (typeof input === 'string') return fail('INVALID_ARGUMENT', input);

      const policy = readPolicy(this.memoryDir);
      if (!policy.enabled) return fail('MEMORY_DISABLED', 'website memory is off; the owner controls it.');
      const before = this.deps.connection(sessionId);
      if (!before.supportsSiteContext) return fail('MEMORY_NOT_SUPPORTED', 'the connected browser extension does not support website memory.');

      const after = this.deps.connection(sessionId);
      const siteContext = parseSiteContext(context.siteContext);
      const decision = decideScope({
        purpose: 'reminder',
        policy,
        browserId: before.browserId,
        liveConnectionsForBrowserId: after.ambiguous ? 2 : 1,
        connectionIdBefore: before.connectionId,
        connectionIdAfter: after.connectionId,
        extensionCapabilities: after.supportsSiteContext ? [SITE_CONTEXT_CAPABILITY] : [],
        vault: this.deps.vault.memoryEligibility(before.browserId, input.tabId),
        siteContext,
        sanitizedUnchanged: true,
      });
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

  /** Tombstones the queue has drained past are removed through the one policy writer. */
  private pruneTombstones(drainedThrough: string): void {
    this.mutatePolicy((policy) => pruneDeletions(policy, drainedThrough, this.iso()), true).catch((error) => this.noteError(errorCode(error)));
  }

  /** Every policy change runs here, one at a time. With `skipUnchanged`, an unchanged policy is not written. */
  private mutatePolicy(change: (policy: MemoryPolicy) => MemoryPolicy, skipUnchanged = false): Promise<MemoryPolicy> {
    const run = this.policyTail.then(async () => {
      const current = readPolicy(this.memoryDir);
      const next = change(current);
      if (skipUnchanged && next === current) return current;
      await writePolicy(this.memoryDir, next);
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
      quarantined: stored.corrupt.length,
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
  }
}
