import { describe, expect, it } from 'vitest';
import { SnapshotRegistry } from '../extension/lib/snapshot-registry.js';

function entry(overrides: Record<string, unknown> = {}) {
  return {
    snapshotId: 's_1',
    tabId: 7,
    sessionId: 'agent-a',
    documentId: 'd_1',
    documentVersion: 'd_1:1',
    createdAt: 1_000,
    ...overrides,
  };
}

describe('SnapshotRegistry', () => {
  it('isolates snapshots by tab and session', () => {
    const registry = new SnapshotRegistry({ ttlMs: 1_000, now: () => 1_100 });
    registry.register(entry());

    expect(registry.validate('s_1', 7, 'agent-a')).toMatchObject({ ok: true });
    expect(registry.validate('s_1', 8, 'agent-a')).toMatchObject({
      ok: false,
      error: 'SNAPSHOT_NOT_FOUND',
      reason: 'WRONG_TAB',
    });
    expect(registry.validate('s_1', 7, 'agent-b')).toMatchObject({
      ok: false,
      error: 'SNAPSHOT_NOT_FOUND',
      reason: 'WRONG_SESSION',
    });
  });

  it('distinguishes expired from unknown snapshots', () => {
    let now = 1_100;
    const registry = new SnapshotRegistry({ ttlMs: 100, now: () => now });
    registry.register(entry());
    now = 1_101;

    expect(registry.validate('s_1', 7, 'agent-a')).toMatchObject({
      ok: false,
      error: 'SNAPSHOT_EXPIRED',
    });
    expect(registry.validate('missing', 7, 'agent-a')).toMatchObject({
      ok: false,
      error: 'SNAPSHOT_NOT_FOUND',
    });
  });

  it('bounds retained observations without sharing or silently retargeting refs', () => {
    const registry = new SnapshotRegistry({ maxEntries: 2, ttlMs: 10_000, now: () => 1_100 });
    registry.register(entry());
    registry.register(entry({ snapshotId: 's_2', createdAt: 1_010 }));
    registry.register(entry({ snapshotId: 's_3', createdAt: 1_020 }));

    expect(registry.size).toBe(2);
    expect(registry.validate('s_1', 7, 'agent-a')).toMatchObject({
      ok: false,
      error: 'SNAPSHOT_EXPIRED',
    });
  });

  it('drops all state owned by a closed tab or disconnected session', () => {
    const registry = new SnapshotRegistry({ ttlMs: 10_000, now: () => 1_100 });
    registry.register(entry());
    registry.register(entry({ snapshotId: 's_2', tabId: 8 }));
    registry.register(entry({ snapshotId: 's_3', sessionId: 'agent-b' }));

    registry.dropTab(8);
    registry.dropSession('agent-b');
    expect(registry.serialize().map((item: { snapshotId: string }) => item.snapshotId)).toEqual(['s_1']);
  });

  it('restores only valid, well-shaped metadata after a service-worker recycle', () => {
    const registry = new SnapshotRegistry({ ttlMs: 1_000, now: () => 1_100 });
    registry.restore([
      entry(),
      entry({ snapshotId: '', tabId: 'wrong' }),
      null,
      { unexpected: true },
    ]);

    expect(registry.size).toBe(1);
    expect(registry.validate('s_1', 7, 'agent-a')).toMatchObject({ ok: true });
  });
});
