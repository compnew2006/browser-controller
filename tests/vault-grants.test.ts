import { describe, expect, it } from 'vitest';
import { GrantRegistry } from '../mcp-server/src/vault/grants.js';
import { scopeForBrowser } from '../mcp-server/src/vault/store.js';
import type { PrivateConnection, VaultBrowserContext } from '../mcp-server/src/vault/service-common.js';

const ORIGIN = 'https://example.test';
const context: VaultBrowserContext = {
  browserId: 'browser-a',
  browserLabel: 'Fixture browser',
  connectionId: 'conn-1',
  supportsVault: true,
};
const connection: PrivateConnection = context;
const otherConnection: PrivateConnection = { ...context, connectionId: 'conn-2' };

function registryAt(now = 1_000) {
  return new GrantRegistry(() => now);
}

describe('grant registry', () => {
  it('accepts a reusable fill grant for a list and for a fill, but a one-shot fill grant only for a fill', () => {
    const grants = registryAt();
    const reusable = grants.create(connection, 'session-1', ORIGIN, 'fill', 'cred_fixture');
    const oneShot = grants.create(connection, 'session-1', ORIGIN, 'fill', 'cred_fixture', true);

    expect(grants.find(context, 'session-1', ORIGIN, 'list')).toBe(reusable);
    expect(grants.find(context, 'session-1', ORIGIN, 'list', 'cred_fixture')).toBe(reusable);
    expect(grants.find(context, 'session-1', ORIGIN, 'fill', 'cred_fixture')).toBe(reusable);
    expect(grants.find(context, 'session-1', ORIGIN, 'list')?.grantId).not.toBe(oneShot.grantId);
  });

  it('never lets a list grant authorise a fill', () => {
    const grants = registryAt();
    grants.create(connection, 'session-1', ORIGIN, 'list');
    expect(grants.find(context, 'session-1', ORIGIN, 'fill', 'cred_fixture')).toBeUndefined();
  });

  it('narrows a fill grant to its account, and treats a grant with no account as "any account on this site"', () => {
    const grants = registryAt();
    const narrow = grants.create(connection, 'session-1', ORIGIN, 'fill', 'cred_fixture');
    expect(grants.find(context, 'session-1', ORIGIN, 'fill', 'cred_other')).toBeUndefined();
    expect(grants.find(context, 'session-1', ORIGIN, 'fill', undefined)).toBeUndefined();
    expect(grants.find(context, 'session-1', ORIGIN, 'fill', 'cred_fixture')).toBe(narrow);

    const wide = grants.create(connection, 'session-2', ORIGIN, 'fill');
    expect(grants.find(context, 'session-2', ORIGIN, 'fill', 'cred_other')).toBe(wide);
  });

  it('refuses a grant from another connection, another session, or another origin', () => {
    const grants = registryAt();
    grants.create(connection, 'session-1', ORIGIN, 'fill', 'cred_fixture');
    expect(grants.find({ ...context, connectionId: 'conn-2' }, 'session-1', ORIGIN, 'fill', 'cred_fixture')).toBeUndefined();
    expect(grants.find(context, 'session-2', ORIGIN, 'fill', 'cred_fixture')).toBeUndefined();
    expect(grants.find(context, 'session-1', 'https://other.test', 'fill', 'cred_fixture')).toBeUndefined();
    expect(grants.find({ ...context, browserId: 'browser-b' }, 'session-1', ORIGIN, 'fill', 'cred_fixture')).toBeUndefined();
    expect(grants.find(context, 'session-1', ORIGIN, 'fill', 'cred_fixture')).toBeDefined();
  });

  it('refuses a revoked, consumed or expired grant', () => {
    let now = 1_000;
    const grants = new GrantRegistry(() => now);
    const revoked = grants.create(connection, 'session-1', ORIGIN, 'fill', 'cred_fixture');
    revoked.revoked = true;
    const consumed = grants.create(connection, 'session-1', ORIGIN, 'fill', 'cred_fixture');
    consumed.consumed = true;
    const expiring = grants.create(connection, 'session-1', ORIGIN, 'fill', 'cred_fixture');
    now = expiring.expiresAt;

    expect(grants.find(context, 'session-1', ORIGIN, 'fill', 'cred_fixture')).toBeUndefined();
  });

  it('lets one operation claim a one-shot grant, and retires it when that operation ends', () => {
    const grants = registryAt();
    const oneShot = grants.create(connection, 'session-1', ORIGIN, 'fill', 'cred_fixture', true);

    expect(grants.claimOneShot(oneShot, 'fillop-1')).toBe(true);
    expect(grants.claimOneShot(oneShot, 'fillop-2')).toBe(false);
    expect(grants.get(oneShot.grantId)).toBe(oneShot);

    grants.consumeOneShot(oneShot);
    expect(oneShot.consumed).toBe(true);
    expect(grants.get(oneShot.grantId)).toBeUndefined();
  });

  it('leaves a reusable grant claimed, consumable and listed when a fill uses it', () => {
    const grants = registryAt();
    const reusable = grants.create(connection, 'session-1', ORIGIN, 'fill', 'cred_fixture');

    expect(grants.claimOneShot(reusable, 'fillop-1')).toBe(true);
    grants.consumeOneShot(reusable);
    expect(grants.get(reusable.grantId)).toBe(reusable);
    expect(reusable.consumed).toBeUndefined();
  });

  it('retires the grants each revocation asks for and leaves the rest', () => {
    const grants = registryAt();
    const kept = grants.create(connection, 'session-1', ORIGIN, 'fill', 'cred_fixture');
    grants.create(connection, 'session-1', ORIGIN, 'list');
    grants.create(otherConnection, 'session-2', ORIGIN, 'fill', 'cred_second');
    grants.create(connection, 'session-3', ORIGIN, 'fill', 'cred_other');

    expect(grants.activeFor(kept.browserScope, 'conn-1')).toHaveLength(3);
    grants.revokeCredential(kept.browserScope, 'cred_fixture');
    expect(grants.get(kept.grantId)).toBeUndefined();
    expect(grants.activeFor(kept.browserScope, 'conn-1').map((grant) => grant.credentialId)).toEqual([undefined, 'cred_other']);

    grants.revokeConnection(kept.browserScope, 'conn-1');
    expect(grants.activeFor(kept.browserScope, 'conn-1')).toEqual([]);
    expect(grants.activeFor(kept.browserScope, 'conn-2')).toHaveLength(1);

    grants.clear();
    expect(grants.activeFor(kept.browserScope, 'conn-2')).toEqual([]);
  });

  describe('site approvals (specs/006)', () => {
    const scope = scopeForBrowser(context.browserId);

    it('answers a list or fill for any session and connection of the profile, for that exact origin only', () => {
      const grants = registryAt();
      const site = grants.createSite(scope, ORIGIN, 'card');
      expect(grants.find(context, 'session-1', ORIGIN, 'list')).toBe(site);
      expect(grants.find(context, 'session-2', ORIGIN, 'fill', 'cred_any')).toBe(site);
      expect(grants.find({ ...context, connectionId: 'conn-9' }, 'session-3', ORIGIN, 'fill', 'cred_any')).toBe(site);
      expect(grants.find(context, 'session-1', 'https://sub.example.test', 'list')).toBeUndefined();
      expect(grants.find({ ...context, browserId: 'browser-b' }, 'session-1', ORIGIN, 'list')).toBeUndefined();
    });

    it('keeps one approval per profile and site, as first given', () => {
      const grants = registryAt();
      const first = grants.createSite(scope, ORIGIN, 'page');
      expect(grants.createSite(scope, ORIGIN, 'allowlist')).toBe(first);
      expect(first.via).toBe('page');
      expect(grants.activeSitesFor(scope)).toEqual([first]);
    });

    it('prefers a session grant that matches, then falls back to the site approval', () => {
      const grants = registryAt();
      const session = grants.create(connection, 'session-1', ORIGIN, 'fill', 'cred_fixture');
      const site = grants.createSite(scope, ORIGIN, 'card');
      expect(grants.find(context, 'session-1', ORIGIN, 'fill', 'cred_fixture')).toBe(session);
      expect(grants.find(context, 'session-1', ORIGIN, 'fill', 'cred_other')).toBe(site);
    });

    it('outlives session, connection and account revocation, and ends with its scope, its own revocation or clear', () => {
      const grants = registryAt();
      const site = grants.createSite(scope, ORIGIN, 'card');
      grants.revokeSession('session-1');
      grants.revokeConnection(scope, 'conn-1');
      grants.revokeCredential(scope, 'cred_fixture');
      expect(grants.findSite(scope, ORIGIN)).toBe(site);

      grants.revokeScope(scope);
      expect(site.revoked).toBe(true);
      expect(grants.findSite(scope, ORIGIN)).toBeUndefined();

      const second = grants.createSite(scope, ORIGIN, 'page');
      expect(grants.getSite(second.grantId)).toBe(second);
      grants.revoke(second.grantId);
      expect(second.revoked).toBe(true);
      expect(grants.getSite(second.grantId)).toBeUndefined();

      const third = grants.createSite(scope, ORIGIN, 'page');
      grants.clear();
      expect(third.revoked).toBe(true);
      expect(grants.activeSitesFor(scope)).toEqual([]);
    });

    it('ends only the approvals an allowlist entry gave when that entry is removed', () => {
      const grants = registryAt();
      const fromAllowlist = grants.createSite(scope, ORIGIN, 'allowlist');
      const other = grants.createSite(scope, 'https://other.test', 'card');
      expect(grants.revokeSiteVia(scope, 'https://other.test', 'allowlist')).toEqual([]);
      expect(grants.revokeSiteVia(scope, ORIGIN, 'allowlist')).toEqual([fromAllowlist]);
      expect(fromAllowlist.revoked).toBe(true);
      expect(grants.activeSitesFor(scope)).toEqual([other]);
    });
  });
});
