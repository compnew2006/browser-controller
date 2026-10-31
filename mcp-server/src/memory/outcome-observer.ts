/**
 * What a browser outcome tells the memory service (specs/007-form-shape-facts).
 *
 * Two things in this feature are read from an outcome the daemon already has, and neither needs an observation:
 *
 * - the **hidden-control counter**: a refused action carries no `siteContext`, so its origin comes from the
 *   last observed read of that tab (C7). The counter counts this profile's own failures, holds no part of them,
 *   and is not behind the anonymity gate (C6).
 * - the **commit mode**: a write that moved the address is a commit candidate, held against the path it ran on
 *   and applied at the next observed read of that path (C8).
 *
 * Both need the tab cache, which lives here rather than in the service, so that the service keeps its size.
 */
import { ALLOWLIST, type CommitMode } from './allowlist.js';
import { readPolicy } from './policy.js';
import { decideScope } from './scope.js';
import { TabStateCache } from './tab-state.js';
import type { MemoryQueue } from './queue.js';
import { SITE_CONTEXT_CAPABILITY } from '../protocol.js';

/** The fields of a browser outcome this module reads. */
export interface ObservedOutcome {
  sessionId: string;
  tool: string;
  params: Record<string, unknown>;
  daemonCallId: string;
  result: unknown;
  error?: string;
}

/** The connection of a session, as the observer needs it. */
export interface ObserverConnection {
  browserId: string;
  connectionId: string;
  ambiguous: boolean;
}

export interface ObserverDeps {
  connection(sessionId: string): ObserverConnection;
  vault: { memoryEligibility(browserId: string, tabId?: number): 'clear' | 'protected' | 'unknown' };
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The code of a failed call: the text before the first colon, as the tools report it (`ELEMENT_HIDDEN: …`). */
export function failureCode(error: string | undefined): string | null {
  if (typeof error !== 'string' || error === '') return null;
  const code = error.split(':', 1)[0].trim().toUpperCase();
  return code === '' ? null : code;
}

export class OutcomeObserver {
  /** The per-tab memory: the last observed read of a tab, and a pending commit mode. */
  readonly tabs = new TabStateCache();

  constructor(
    private readonly deps: ObserverDeps,
    private readonly memoryDir: string,
    private readonly queue: MemoryQueue,
    private readonly now: () => number,
    private readonly iso: () => string,
  ) {}

  /**
   * The hidden-control counter. A refused action carries no siteContext, so the origin comes from the last
   * observed read of that tab; a tab that was never read has no known origin and nothing is counted. The
   * counter is behind the scope gate (the vault's protection, the exclusion list), but not behind the
   * anonymity gate: it counts this profile's own failures and holds no page content (C6).
   */
  noteHiddenFailure(outcome: ObservedOutcome): void {
    const code = failureCode(outcome.error);
    if (!code || !(ALLOWLIST.failureCodes as readonly string[]).includes(code)) return;
    const tabId = typeof outcome.params.tabId === 'number' ? outcome.params.tabId : undefined;
    if (tabId === undefined) return;
    let after: ObserverConnection;
    try {
      after = this.deps.connection(outcome.sessionId);
    } catch {
      return;
    }
    const now = this.now();
    const entry = this.tabs.lookup(after.connectionId, tabId, now);
    if (!entry) return;
    const decision = decideScope({
      purpose: 'capture',
      policy: readPolicy(this.memoryDir),
      browserId: after.browserId,
      liveConnectionsForBrowserId: after.ambiguous ? 2 : 1,
      connectionIdBefore: entry.connectionId,
      connectionIdAfter: after.connectionId,
      // The entry exists only because the extension reported a site context for that tab.
      extensionCapabilities: [SITE_CONTEXT_CAPABILITY],
      vault: this.deps.vault.memoryEligibility(after.browserId, tabId),
      siteContext: { url: entry.url, incognito: false, topLevel: true, stable: true, anonymous: entry.anonymous },
      sanitizedUnchanged: true,
    });
    if (!decision.in) return;
    const at = this.iso();
    this.queue.enqueue({
      opId: `${outcome.daemonCallId}#hidden`,
      type: 'hidden',
      profileId: decision.scope.browserId,
      origin: decision.scope.origin,
      at,
      facts: [],
      enqueuedAt: at,
    });
  }

  /**
   * The commit mode. A write that moved the address is a commit candidate: `browser_type` that pressed Enter,
   * or a click on a control the last snapshot marked `button`. The candidate is held against the path it ran
   * on; nothing but the mode is kept — no tool, no target, no tab, no time, and not the address that proved it.
   */
  noteCommitCandidate(outcome: ObservedOutcome): void {
    const result = isRecord(outcome.result) ? outcome.result : null;
    if (!result || typeof result.navigated !== 'string' || result.navigated === '') return;
    const tabId = typeof outcome.params.tabId === 'number' ? outcome.params.tabId : undefined;
    if (tabId === undefined) return;
    let after: ObserverConnection;
    try {
      after = this.deps.connection(outcome.sessionId);
    } catch {
      return;
    }
    const now = this.now();
    const entry = this.tabs.lookup(after.connectionId, tabId, now);
    if (!entry) return;
    const mode = this.commitModeFor(outcome, after.connectionId, tabId, now);
    if (!mode) return;
    this.tabs.setCommitMode(after.connectionId, entry.origin, entry.path, mode, now);
  }

  /** The mode a write implies: `enter` when it pressed Enter, `button` when it clicked a button. */
  private commitModeFor(outcome: ObservedOutcome, connectionId: string, tabId: number, now: number): CommitMode | null {
    if (outcome.tool === 'browser_type') {
      const key = typeof outcome.params.key === 'string' ? outcome.params.key : '';
      return outcome.params.submit === true || /enter/i.test(key) ? 'enter' : null;
    }
    if (outcome.tool === 'browser_click') {
      const target = outcome.params.target;
      const explicit = isRecord(target) && typeof target.role === 'string' ? target.role : null;
      const role = explicit ?? this.tabs.roleOf(connectionId, tabId, typeof target === 'string' ? target : undefined, now);
      return role === 'button' ? 'button' : null;
    }
    return null;
  }
}
