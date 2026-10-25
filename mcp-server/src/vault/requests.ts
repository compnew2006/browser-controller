import { scopeForBrowser } from './store.js';
import { randomId, type VaultPrivateRequest } from './types.js';
import { TERMINAL_RETENTION_MS, VAULT_PENDING_TTL_MS, type InternalPending, type PrivateConnection } from './service-common.js';
import type { OperationRegistry } from './operations.js';
import type { VaultBrowserContext } from './service-common.js';

export interface RequestJournalOptions {
  now: () => number;
  isSessionLive: (sessionId: string) => boolean;
  /** In-flight work is aborted when its request is cancelled, so the journal needs the operations. */
  operations: OperationRegistry;
  /** Asks the extension to open its private page for a request; a failure ends the request as failed. */
  openUi: (requestId: string, sessionId: string, agentName: string) => Promise<void>;
}

/**
 * The private-request journal: every request a browser session asked for, the
 * state it reached, and when it ended.
 *
 * `settle` is the only way a state changes, so the rule "a request ends once,
 * with the time it ended" holds by construction. The journal knows nothing
 * about credentials, grants or the page — only who asked, for what, and whether
 * the answer is still live (ADR-02).
 */
export class RequestJournal {
  private readonly requests = new Map<string, InternalPending>();

  constructor(private readonly options: RequestJournalOptions) {}

  /** Records a request and opens the private page for it. A page that never opens ends the request as failed. */
  async begin(
    context: VaultBrowserContext,
    input: Pick<VaultPrivateRequest, 'purpose' | 'sessionId' | 'tabId' | 'documentId' | 'origin' | 'credentialId'> & { label?: string },
  ): Promise<InternalPending> {
    const createdAt = this.options.now();
    const request: VaultPrivateRequest = {
      requestId: randomId('req'),
      purpose: input.purpose,
      sessionId: input.sessionId,
      browserScope: scopeForBrowser(context.browserId),
      ...(input.tabId !== undefined ? { tabId: input.tabId } : {}),
      ...(input.documentId ? { documentId: input.documentId } : {}),
      ...(input.origin ? { origin: input.origin } : {}),
      ...(input.credentialId ? { credentialId: input.credentialId } : {}),
      createdAt,
      expiresAt: createdAt + VAULT_PENDING_TTL_MS,
      state: 'pending',
    };
    const pending: InternalPending = {
      request,
      browserId: context.browserId,
      browserLabel: context.browserLabel,
      connectionId: context.connectionId,
      agentName: context.agentName || 'Connected session',
    };
    this.requests.set(request.requestId, pending);
    try {
      await this.options.openUi(request.requestId, input.sessionId, context.agentName ?? '');
    } catch {
      this.settle(pending, 'failed');
    }
    return pending;
  }

  get(requestId: string): InternalPending | undefined {
    return this.requests.get(requestId);
  }

  /** A request id from the private page, if it belongs to that connection. */
  forConnection(connection: PrivateConnection, requestId: unknown): InternalPending | undefined {
    if (typeof requestId !== 'string') return undefined;
    const pending = this.requests.get(requestId);
    if (!pending || pending.request.browserScope !== scopeForBrowser(connection.browserId) || pending.connectionId !== connection.connectionId) return undefined;
    return pending;
  }

  /** The requests one connection is still waiting on, oldest first. */
  activeFor(scope: string, connectionId: string): InternalPending[] {
    return [...this.requests.values()]
      .filter((item) => item.request.browserScope === scope && item.connectionId === connectionId
        && ['pending', 'processing'].includes(item.request.state))
      .sort((left, right) => left.request.createdAt - right.request.createdAt);
  }

  /**
   * Takes a pending request for processing and binds an operation to it, so
   * cancelling the request aborts the work. Refuses a request that expired or
   * was already handled.
   */
  claim(pending: InternalPending): boolean {
    if (pending.request.state !== 'pending' || pending.request.expiresAt <= this.options.now()) {
      this.settle(pending, pending.request.state === 'pending' ? 'expired' : pending.request.state);
      return false;
    }
    pending.request = { ...pending.request, state: 'processing' };
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    this.options.operations.track(pending.request.requestId, {
      scope: pending.request.browserScope,
      sessionId: pending.request.sessionId,
    }, undefined, { done, resolveDone });
    return true;
  }

  /** Ends a private request: its final state is recorded once, with the time it ended. */
  settle(pending: InternalPending, state: VaultPrivateRequest['state']): void {
    pending.request = { ...pending.request, state };
    pending.terminalAt = this.options.now();
  }

  /** Expires what timed out, and forgets terminal requests once retention lapses. */
  expire(): void {
    const now = this.options.now();
    for (const [id, pending] of this.requests) {
      if (pending.request.state === 'pending' && pending.request.expiresAt <= now) {
        pending.request = { ...pending.request, state: 'expired' };
        pending.terminalAt = now;
      } else if (pending.terminalAt && now - pending.terminalAt > TERMINAL_RETENTION_MS) this.requests.delete(id);
    }
  }

  /** Forgets terminal requests whose retention lapsed, leaving live ones alone. */
  pruneTerminal(): void {
    for (const [id, pending] of this.requests) {
      if (pending.terminalAt && this.options.now() - pending.terminalAt > TERMINAL_RETENTION_MS) this.requests.delete(id);
    }
  }

  /** Cancels matching live private requests and aborts the work bound to them. */
  cancelMatching(matching: (pending: InternalPending) => boolean = () => true): void {
    for (const pending of this.requests.values()) {
      if (!matching(pending) || !['pending', 'processing'].includes(pending.request.state)) continue;
      this.settle(pending, 'cancelled');
      this.options.operations.abort(pending.request.requestId);
    }
  }

  /** Aborts the work bound to matching requests without changing what the journal recorded for them. */
  abortWorkMatching(matching: (pending: InternalPending) => boolean): void {
    for (const pending of this.requests.values()) if (matching(pending)) this.options.operations.abort(pending.request.requestId);
  }

  /** Whether a request may still be handled: unexpired, and its session still connected. */
  revalidate(pending: InternalPending): boolean {
    return pending.request.expiresAt > this.options.now() && this.options.isSessionLive(pending.request.sessionId);
  }
}
