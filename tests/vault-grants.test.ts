import { describe, expect, it } from 'vitest';
import { GrantRegistry } from '../mcp-server/src/vault/grants.js';
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
});
