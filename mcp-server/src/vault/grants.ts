import { scopeForBrowser } from './store.js';
import { randomId } from './types.js';
import type { LiveGrant, PrivateConnection, VaultBrowserContext } from './service-common.js';

/**
 * Every grant the vault has issued, and the whole rule for when one may be
 * used.
 *
 * A grant is the user saying "this browser, this site, this account, this
 * session" — nothing about it needs a store, a transport or a request, so the
 * predicate in {@link find} can be exercised on its own (ADR-02).
 */
export class GrantRegistry {
  private readonly grants = new Map<string, LiveGrant>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * The one rule for using a grant: unexpired, unrevoked, unconsumed, issued to
   * this session on this connection for this origin, and wide enough for the
   * purpose asked for. A `list` purpose also accepts a reusable `fill` grant.
   */
  find(
    context: VaultBrowserContext,
    sessionId: string,
    origin: string,
    purpose: 'list' | 'fill',
    credentialId?: string,
  ): LiveGrant | undefined {
    const scope = scopeForBrowser(context.browserId);
    return [...this.grants.values()].find((grant) => !grant.revoked && !grant.consumed && grant.expiresAt > this.now()
      && grant.sessionId === sessionId && grant.browserScope === scope && grant.connectionId === context.connectionId && grant.origin === origin
      && (grant.purpose === purpose || (purpose === 'list' && grant.purpose === 'fill' && !grant.oneShot))
      && (purpose === 'list' || !grant.credentialId || grant.credentialId === credentialId));
  }

  get(grantId: string): LiveGrant | undefined {
    return this.grants.get(grantId);
  }

  create(
    context: PrivateConnection,
    sessionId: string,
    origin: string,
    purpose: 'list' | 'fill',
    credentialId?: string,
    oneShot = false,
  ): LiveGrant {
    const grant: LiveGrant = {
      grantId: randomId('grant'),
      sessionId,
      browserScope: scopeForBrowser(context.browserId),
      connectionId: context.connectionId,
      origin,
      ...(credentialId ? { credentialId } : {}),
      purpose,
      ...(oneShot ? { oneShot: true } : {}),
      createdAt: this.now(),
      expiresAt: Number.MAX_SAFE_INTEGER,
      revoked: false,
    };
    this.grants.set(grant.grantId, grant);
    return grant;
  }

  /** The grants the private page lists for one connection: issued to it, and still standing. */
  activeFor(scope: string, connectionId: string): LiveGrant[] {
    return [...this.grants.values()]
      .filter((grant) => grant.browserScope === scope && grant.connectionId === connectionId && !grant.revoked);
  }

  /**
   * Claims a one-shot grant for `operationId`; false when it was already used
   * or is being used by another operation. A normal grant is never claimed.
   */
  claimOneShot(grant: LiveGrant | undefined, operationId: string): boolean {
    if (!grant?.oneShot) return true;
    if (grant.consumed || grant.claimedBy) return false;
    grant.claimedBy = operationId;
    return true;
  }

  /** Closes out a one-shot grant once its fill ends, whatever the outcome. Takes the grant itself, so a grant revoked mid-fill still closes. */
  consumeOneShot(grant: LiveGrant | undefined): void {
    if (!grant?.oneShot) return;
    grant.consumed = true;
    grant.claimedBy = undefined;
    this.grants.delete(grant.grantId);
  }

  revoke(grantId: string): void {
    this.grants.delete(grantId);
  }

  /** Every grant issued for one browser scope: locking or restoring the store retires all of them. */
  revokeScope(scope: string): void {
    for (const [id, grant] of this.grants) if (grant.browserScope === scope) this.grants.delete(id);
  }

  /** Removing an account retires the grants that were issued for it. */
  revokeCredential(scope: string, credentialId: string): void {
    for (const [id, grant] of this.grants) if (grant.browserScope === scope && grant.credentialId === credentialId) this.grants.delete(id);
  }

  revokeSession(sessionId: string): void {
    for (const [id, grant] of this.grants) if (grant.sessionId === sessionId) this.grants.delete(id);
  }

  /** A reconnect is a new authority epoch even when the copied profile ID matches. */
  revokeConnection(scope: string, connectionId: string): void {
    for (const [id, grant] of this.grants) if (grant.browserScope === scope && grant.connectionId === connectionId) this.grants.delete(id);
  }

  clear(): void {
    for (const grantId of this.grants.keys()) this.grants.delete(grantId);
  }
}
