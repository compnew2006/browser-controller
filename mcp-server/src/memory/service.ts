import path from 'node:path';
import {
  parseMemoryAdminRequest,
  type MemoryAdminRequest,
  type MemoryAdminResult,
  type MemoryAdminStatus,
} from '../daemon-config.js';
import { OBSERVABLE_TOOLS } from '../bridge-frames.js';
import type { MemoryObservation } from '../vault/daemon-routing.js';
import { SITE_CONTEXT_CAPABILITY } from '../protocol.js';
import { controlFact, languageFact, loginFact, searchFact, type CandidateFact } from './allowlist.js';
import {
  MemoryPolicyError,
  canonicalOrigin,
  disablePolicy,
  enablePolicy,
  excludeOrigin,
  includeOrigin,
  pruneDeletions,
  readPolicy,
  recordDeletion,
  writePolicy,
  type MemoryPolicy,
} from './policy.js';
import { MemoryQueue, type CaptureOp, type DropReason } from './queue.js';
import { decideScope, type ScopeSiteContext } from './scope.js';
import { JsonMemoryStore, MemoryStoreError, type MemoryStore } from './store.js';

const MAX_PATH = 120;
const MAX_CANDIDATES = 64;
const SNAPSHOT_LINE = /^\s*(?:-\s+)?([a-z]+) "([^"\n]*)"(?:\s|$)/u;

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
}

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

/** Candidate facts from snapshot lines `<role> "<name>"`. A line counts only when role and whole name are on the allowlist; nothing is truncated. */
export function extractSnapshotFacts(text: string): CandidateFact[] {
  const found = new Map<string, CandidateFact>();
  for (const line of text.split('\n')) {
    const match = SNAPSHOT_LINE.exec(line);
    if (!match) continue;
    const fact = searchFact(match[1], match[2]) ?? controlFact(match[1], match[2]);
    if (fact && !found.has(fact.factId)) found.set(fact.factId, fact);
    if (found.size >= MAX_CANDIDATES) break;
  }
  return [...found.values()];
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

function errorCode(error: unknown): string {
  return error instanceof MemoryPolicyError || error instanceof MemoryStoreError ? error.code : 'MEMORY_UNAVAILABLE';
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
  private lastError: { code: string; at: string } | null = null;

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

  private capture(call: MemoryCall, outcome: MemoryCallOutcome, observation: MemoryObservation): void {
    const policy = readPolicy(this.memoryDir);
    const after = this.deps.connection(outcome.sessionId);
    const result = isRecord(outcome.result) ? outcome.result : {};
    const parsed = parseSiteContext(observation.siteContext);
    const tabId = typeof result.tabId === 'number' ? result.tabId : typeof outcome.params.tabId === 'number' ? outcome.params.tabId : undefined;
    const navigated = outcome.tool === 'browser_navigate';
    // A navigate whose result URL differs from the tab's URL cannot be attributed to one document.
    const context: ParsedSiteContext | null = parsed && navigated && !sameDocument(result.url, parsed.url) ? { ...parsed, stable: false } : parsed;

    const decision = decideScope({
      purpose: 'capture',
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
    if (!decision.in || !context) return;

    const { scope } = decision;
    const at = this.iso();
    const base = { profileId: scope.browserId, origin: scope.origin, at, enqueuedAt: at };
    if (navigated) this.queue.enqueue({ ...base, opId: outcome.daemonCallId, type: 'visit', facts: [] });

    const snapshotted = outcome.tool === 'browser_snapshot' || (navigated && outcome.params.snapshot === true);
    if (!snapshotted || scope.anonymous !== true) return;
    const facts = new Map<string, CandidateFact>();
    const add = (fact: CandidateFact | null) => {
      if (fact && !facts.has(fact.factId)) facts.set(fact.factId, fact);
    };
    add(languageFact(context.lang, context.dir));
    add(loginFact(context.passwordField, scope.path));
    if (typeof result.text === 'string') for (const fact of extractSnapshotFacts(result.text)) add(fact);
    if (facts.size === 0) return;
    const op: CaptureOp = {
      ...base,
      opId: navigated ? `${outcome.daemonCallId}#facts` : outcome.daemonCallId,
      type: 'facts',
      facts: [...facts.values()].slice(0, MAX_CANDIDATES),
      tool: outcome.tool as 'browser_navigate' | 'browser_snapshot',
      ...(scope.path.length <= MAX_PATH ? { path: scope.path } : {}),
    };
    this.queue.enqueue(op);
  }

  /** The `browser_memory` tool is not part of this build yet; the daemon does not route to it. */
  async handleTool(_tool: string, _params: Record<string, unknown>, _sessionId: string): Promise<{ success: false; error: string }> {
    return { success: false, error: 'MEMORY_UNAVAILABLE: browser_memory is not available in this build' };
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
    const stored = await this.store.status();
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
  async adminFromWire(raw: unknown): Promise<MemoryAdminResult> {
    const parsed = parseMemoryAdminRequest(raw);
    if (!parsed.ok) {
      const id = isRecord(raw) && typeof raw.id === 'string' ? raw.id.slice(0, 64) : '';
      return { kind: 'memory-admin-result', id, success: false, error: parsed.error };
    }
    return this.admin(parsed.request);
  }

  async admin(request: MemoryAdminRequest): Promise<MemoryAdminResult> {
    const { id } = request;
    const done = (extra: Partial<MemoryAdminResult> = {}): MemoryAdminResult => ({ kind: 'memory-admin-result', id, success: true, ...extra });
    try {
      const origin = request.origin === undefined ? null : canonicalOrigin(request.origin);
      if (request.origin !== undefined && origin === null) throw new MemoryPolicyError('INVALID_ARGUMENT', 'origin must be an http or https origin');
      const at = this.iso();
      switch (request.command) {
        case 'status':
          return done({ status: await this.status() });
        case 'enable':
          await this.mutatePolicy((policy) => enablePolicy(policy, at));
          return done({ status: await this.status() });
        case 'disable':
          await this.mutatePolicy((policy) => disablePolicy(policy, at));
          this.queue.dropPending('disabled');
          return done({ status: await this.status() });
        case 'exclude':
          await this.mutatePolicy((policy) => excludeOrigin(policy, origin as string, at));
          this.queue.dropPending('excluded', (op) => op.origin === origin);
          return done({ status: await this.status() });
        case 'include':
          await this.mutatePolicy((policy) => includeOrigin(policy, origin as string, at));
          return done({ status: await this.status() });
        case 'inspect': {
          const site = await this.store.getSite(origin as string);
          return done({ records: site ? [site] : [] });
        }
        case 'export':
          return done({ records: await this.store.listSites() });
        case 'delete': {
          // Tombstone first, so queued and in-flight work for the origin cannot write it back.
          const key = request.all === true ? '*' : (origin as string);
          await this.mutatePolicy((policy) => recordDeletion(policy, key, at));
          this.queue.dropPending('deleted', (op) => key === '*' || op.origin === key);
          await this.queue.drain();
          if (key === '*') await this.store.deleteAll();
          else await this.store.deleteSite(key);
          return done({ status: await this.status() });
        }
      }
    } catch (error) {
      const code = errorCode(error);
      const message = error instanceof MemoryPolicyError || error instanceof MemoryStoreError ? error.message : 'memory operation failed';
      return { kind: 'memory-admin-result', id, success: false, error: `${code}: ${message}` };
    }
  }

  /** Resolves when no capture is queued or being written. Used by tests and shutdown. */
  async flush(): Promise<void> {
    await this.queue.drain();
    await this.policyTail;
  }
}
