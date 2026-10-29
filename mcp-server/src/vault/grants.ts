import { scopeForBrowser } from './store.js';
import { randomId } from './types.js';
import type { LiveGrant, PrivateConnection, SiteGrant, VaultBrowserContext } from './service-common.js';

/**
 * Every grant the vault has issued, and the whole rule for when one may be
 * used.
 *
 * A grant is the user saying "this browser, this site, this account, this
 * session" — nothing about it needs a store, a transport or a request, so the
 * predicate in {@link find} can be exercised on its own (ADR-02).
 *
 * A site approval (specs/006-vault-site-approval D1) says less: "this browser
 * profile, this exact site". It covers listing and filling every account of the
 * site for any session and survives reconnects; only scope revocation (lock,
 * restore), its own revocation and {@link clear} end it.
 */
export class GrantRegistry {
  private readonly grants = new Map<string, LiveGrant>();
  private readonly siteGrants = new Map<string, SiteGrant>();
  /** Per profile scope: sites the owner stopped allowing while the always-allowed list may still hold them. */
  private readonly blockedSites = new Map<string, Set<string>>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * The one rule for using a grant: unexpired, unrevoked, unconsumed, issued to
   * this session on this connection for this origin, and wide enough for the
   * purpose asked for. A `list` purpose also accepts a reusable `fill` grant.
   * Without such a grant, a site approval for this profile and origin answers.
   */
  find(
    context: VaultBrowserContext,
    sessionId: string,
    origin: string,
    purpose: 'list' | 'fill',
    credentialId?: string,
  ): LiveGrant | SiteGrant | undefined {
    const scope = scopeForBrowser(context.browserId);
    return [...this.grants.values()].find((grant) => !grant.revoked && !grant.consumed && grant.expiresAt > this.now()
      && grant.sessionId === sessionId && grant.browserScope === scope && grant.connectionId === context.connectionId && grant.origin === origin
      && (grant.purpose === purpose || (purpose === 'list' && grant.purpose === 'fill' && !grant.oneShot))
      && (purpose === 'list' || !grant.credentialId || grant.credentialId === credentialId))
      ?? this.findSite(scope, origin);
  }

  get(grantId: string): LiveGrant | undefined {
    return this.grants.get(grantId);
  }

  /** The standing site approval for one profile scope and exact origin. */
  findSite(scope: string, origin: string): SiteGrant | undefined {
    return [...this.siteGrants.values()].find((grant) => !grant.revoked && grant.browserScope === scope && grant.origin === origin);
  }

  getSite(grantId: string): SiteGrant | undefined {
    return this.siteGrants.get(grantId);
  }

  /** Approves a site for a profile; an existing approval is kept as it was given. */
  createSite(scope: string, origin: string, via: SiteGrant['via']): SiteGrant {
    const existing = this.findSite(scope, origin);
    if (existing) return existing;
    const grant: SiteGrant = { kind: 'site', grantId: randomId('grant'), browserScope: scope, origin, via, createdAt: this.now(), revoked: false };
    this.siteGrants.set(grant.grantId, grant);
    return grant;
  }

  /** The site approvals of one profile scope, oldest first. */
  activeSitesFor(scope: string): SiteGrant[] {
    return [...this.siteGrants.values()]
      .filter((grant) => grant.browserScope === scope && !grant.revoked)
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  /**
   * Keeps the always-allowed list from approving a site again while the owner's revoke or removal of it is being
   * written, and after that write failed. The owner allowing the site again, a lock or a restore lifts it.
   */
  blockSite(scope: string, origin: string): void {
    const sites = this.blockedSites.get(scope) ?? new Set<string>();
    sites.add(origin);
    this.blockedSites.set(scope, sites);
  }

  unblockSite(scope: string, origin: string): void {
    const sites = this.blockedSites.get(scope);
    sites?.delete(origin);
    if (sites?.size === 0) this.blockedSites.delete(scope);
  }

  siteBlocked(scope: string, origin: string): boolean {
    return this.blockedSites.get(scope)?.has(origin) === true;
  }

  /** Ends every approval of one origin in one profile scope, however it was given. */
  revokeSite(scope: string, origin: string): SiteGrant[] {
    const revoked: SiteGrant[] = [];
    for (const [id, grant] of this.siteGrants) {
      if (grant.browserScope !== scope || grant.origin !== origin) continue;
      grant.revoked = true;
      this.siteGrants.delete(id);
      revoked.push(grant);
    }
    return revoked;
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
    const site = this.siteGrants.get(grantId);
    if (site) {
      site.revoked = true;
      this.siteGrants.delete(grantId);
    }
  }

  /** Every grant issued for one browser scope: locking or restoring the store retires all of them, site approvals included. */
  revokeScope(scope: string): void {
    this.blockedSites.delete(scope);
    for (const [id, grant] of this.grants) if (grant.browserScope === scope) this.grants.delete(id);
    for (const [id, grant] of this.siteGrants) {
      if (grant.browserScope !== scope) continue;
      grant.revoked = true;
      this.siteGrants.delete(id);
    }
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
    this.blockedSites.clear();
    for (const grantId of this.grants.keys()) this.grants.delete(grantId);
    for (const grant of this.siteGrants.values()) grant.revoked = true;
    this.siteGrants.clear();
  }
}
