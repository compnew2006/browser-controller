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
  /** Asks the extension to draw the in-page approval card; false (or a throw) falls back to the private page. */
  showCard?: (pending: InternalPending) => Promise<boolean>;
  /** Asks the extension to take a card down once its request ended some other way. Never throws. */
  closeCard?: (pending: InternalPending) => void;
}

/** Purposes the in-page card can decide (specs/006 D4); a save always needs the private page's password field. */
const CARD_PURPOSES: ReadonlySet<VaultPrivateRequest['purpose']> = new Set(['approve', 'fill']);
const LIVE_STATES: ReadonlySet<VaultPrivateRequest['state']> = new Set(['pending', 'processing']);

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
  private readonly waiters = new Map<string, Set<() => void>>();

  constructor(private readonly options: RequestJournalOptions) {}

  /**
   * Records a request and asks the owner. With `card`, an approval or fill request is shown on the
   * requesting tab, or joins the card already showing for the same profile and site; when no card
   * can be drawn, the private page opens instead. A page that never opens ends the request as failed.
   */
  async begin(
    context: VaultBrowserContext,
    input: Pick<VaultPrivateRequest, 'purpose' | 'sessionId' | 'tabId' | 'documentId' | 'origin' | 'credentialId'> & { label?: string; card?: boolean },
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
    if (input.card && CARD_PURPOSES.has(request.purpose) && request.origin && request.tabId !== undefined && this.options.showCard) {
      const showing = this.cardFor(request.browserScope, request.origin, pending.connectionId);
      if (showing) {
        pending.surface = 'card';
        pending.cardOf = showing.request.requestId;
        return pending;
      }
      // Marked first, so requests for the same site join this card while it is being drawn.
      pending.surface = 'card';
      this.replaceHeld(pending);
      let shown: boolean;
      try { shown = await this.options.showCard(pending); } catch { shown = false; }
      if (shown) {
        // Ended while the card was being drawn: the close sent at settle time came too early. A card
        // held for the site decision stays up.
        if (!LIVE_STATES.has(pending.request.state) && !pending.held) this.options.closeCard?.(pending);
        return pending;
      }
      if (pending.held) {
        // Its session ended while the card was being drawn, and the card never showed.
        this.release(pending);
        return pending;
      }
      // A card the extension draws after this side gave up on it (a slow page) is taken down.
      this.options.closeCard?.(pending);
      if (pending.request.state === 'pending') await this.moveToPage(pending);
      return pending;
    }
    pending.surface = 'page';
    try {
      await this.options.openUi(request.requestId, input.sessionId, context.agentName ?? '');
    } catch {
      this.settle(pending, 'failed');
    }
    return pending;
  }

  /** The live request whose card is showing for one profile scope and site, on this connection. */
  cardFor(scope: string, origin: string, connectionId: string): InternalPending | undefined {
    return [...this.requests.values()].find((item) => item.surface === 'card' && !item.cardOf
      && item.request.browserScope === scope && item.request.origin === origin && item.connectionId === connectionId
      && LIVE_STATES.has(item.request.state));
  }

  /**
   * A card held after its session ended names an agent that is gone (FR-004): a new request for the site
   * gets its own card, and the requests waiting on the held one move to it.
   */
  private replaceHeld(next: InternalPending): void {
    const { browserScope, origin } = next.request;
    for (const held of this.requests.values()) {
      if (!held.held || held.request.browserScope !== browserScope || held.request.origin !== origin
        || held.connectionId !== next.connectionId) continue;
      for (const item of this.requests.values()) {
        if (item.cardOf === held.request.requestId && LIVE_STATES.has(item.request.state)) item.cardOf = next.request.requestId;
      }
      held.held = false;
      this.options.closeCard?.(held);
    }
  }

  /** A card request and every live request that joined it. */
  cardGroup(shown: InternalPending): InternalPending[] {
    const id = shown.cardOf ?? shown.request.requestId;
    return [...this.requests.values()].filter((item) => item.surface === 'card'
      && (item.request.requestId === id || item.cardOf === id) && LIVE_STATES.has(item.request.state));
  }

  /**
   * The live approval and fill requests for one profile scope and site, from any session and surface:
   * one site decision settles all of them (specs/006 FR-007).
   */
  liveForSite(scope: string, origin: string): InternalPending[] {
    return [...this.requests.values()].filter((item) => CARD_PURPOSES.has(item.request.purpose)
      && item.request.browserScope === scope && item.request.origin === origin && LIVE_STATES.has(item.request.state));
  }

  /** Moves a card request (and the requests that joined it) to the private page, still pending. */
  async moveToPage(shown: InternalPending): Promise<void> {
    const group = this.cardGroup(shown);
    for (const item of group) {
      item.surface = 'page';
      item.cardOf = undefined;
    }
    const lead = group.find((item) => item.request.requestId === (shown.cardOf ?? shown.request.requestId)) ?? shown;
    try {
      await this.options.openUi(lead.request.requestId, lead.request.sessionId, lead.agentName);
    } catch {
      for (const item of group) this.settle(item, 'failed');
    }
    // The agent calls waiting on the card answer now: the owner decides on the private page instead.
    for (const item of group) this.wake(item);
  }

  /**
   * Resolves once the request leaves pending and processing or its card moves to the private page,
   * or after `timeoutMs`, or when `signal` aborts; it reports whether the request ended.
   */
  waitForEnd(pending: InternalPending, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    if (!LIVE_STATES.has(pending.request.state)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const id = pending.request.requestId;
      let set = this.waiters.get(id);
      if (!set) {
        set = new Set();
        this.waiters.set(id, set);
      }
      const finish = (ended: boolean) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        set!.delete(wake);
        if (set!.size === 0) this.waiters.delete(id);
        resolve(ended);
      };
      const wake = () => finish(!LIVE_STATES.has(pending.request.state));
      const onAbort = () => finish(false);
      const timer = setTimeout(() => finish(!LIVE_STATES.has(pending.request.state)), Math.max(0, timeoutMs));
      set.add(wake);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  private notify(pending: InternalPending): void {
    if (LIVE_STATES.has(pending.request.state)) return;
    this.wake(pending);
    if (pending.surface !== 'card' || pending.cardOf || pending.held) return;
    this.endCard(pending);
  }

  /** Takes a card down; requests still waiting on it move to the private page. */
  endCard(pending: InternalPending): void {
    this.options.closeCard?.(pending);
    // A card decision settles the whole group in the same turn. Requests still pending after it
    // joined a card that ended without one (its own request expired, or it was held and then
    // expired or lost its connection): they would be left with no card, so the owner decides
    // them on the private page instead.
    const cardId = pending.request.requestId;
    queueMicrotask(() => {
      const orphan = [...this.requests.values()].find((item) => item.surface === 'card' && item.cardOf === cardId
        && item.request.state === 'pending');
      if (orphan) void this.moveToPage(orphan).catch(() => {});
    });
  }

  /** Resolves every waitForEnd on this request, whatever its state. */
  private wake(pending: InternalPending): void {
    const set = this.waiters.get(pending.request.requestId);
    if (set) for (const resume of [...set]) resume();
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
    this.notify(pending);
  }

  /** Expires what timed out, and forgets terminal requests once retention lapses. */
  expire(): void {
    const now = this.options.now();
    for (const [id, pending] of this.requests) {
      if (pending.request.state === 'pending' && pending.request.expiresAt <= now) {
        this.settle(pending, 'expired');
      } else if (pending.held && pending.request.expiresAt <= now) {
        this.release(pending);
      } else if (pending.terminalAt && now - pending.terminalAt > TERMINAL_RETENTION_MS) this.requests.delete(id);
    }
  }

  /** Forgets terminal requests whose retention lapsed, leaving live ones alone. */
  pruneTerminal(): void {
    for (const [id, pending] of this.requests) {
      if (pending.terminalAt && this.options.now() - pending.terminalAt > TERMINAL_RETENTION_MS) {
        this.release(pending);
        this.requests.delete(id);
      }
    }
  }

  /** Cancels matching live private requests, ends matching held cards, and aborts the work bound to them. */
  cancelMatching(matching: (pending: InternalPending) => boolean = () => true): void {
    for (const pending of this.requests.values()) {
      if (!matching(pending)) continue;
      if (pending.held) this.release(pending);
      if (!['pending', 'processing'].includes(pending.request.state)) continue;
      this.settle(pending, 'cancelled');
      this.options.operations.abort(pending.request.requestId);
    }
  }

  /**
   * Ends a session's live requests as cancelled and aborts their work. A card one of them was showing
   * stays up, held for the site decision (specs/006 edge cases), also while the owner's decision on it
   * is running; its joined requests stay on it.
   */
  cancelSession(sessionId: string): void {
    for (const pending of this.requests.values()) {
      if (pending.request.sessionId !== sessionId || !LIVE_STATES.has(pending.request.state)) continue;
      if (pending.surface === 'card' && !pending.cardOf && pending.request.expiresAt > this.options.now()) pending.held = true;
      this.settle(pending, 'cancelled');
      this.options.operations.abort(pending.request.requestId);
    }
  }

  /** Takes a held card for the owner's decision, once. False when it is no longer held or has expired. */
  takeHeld(pending: InternalPending): boolean {
    if (!pending.held) return false;
    if (pending.request.expiresAt <= this.options.now()) {
      this.release(pending);
      return false;
    }
    pending.held = false;
    return true;
  }

  private release(pending: InternalPending): void {
    if (!pending.held) return;
    pending.held = false;
    this.endCard(pending);
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
