import { describe, expect, it } from 'vitest';
import { BoundedQueue, type BoundedQueueOptions, type QueueGroup } from '../mcp-server/src/core/bounded-queue.js';

type Op = { id: string; key: string };
type Group = QueueGroup<Op>;

function makeQueue(commitGroup: BoundedQueueOptions<Op, Op, Group, unknown>['commitGroup'], sideCommit: (ops: Op[]) => Promise<void> = async () => {}, members: BoundedQueueOptions<Op, Op, Group, unknown>['members'] = (entry) => [entry.op]) {
  const drained: string[] = [];
  const queue = new BoundedQueue<Op, Op, Group, unknown>({
    maxPending: 10, maxGroupEntries: 10, dedupeEntries: 10, commitTimeoutMs: 20,
    now: () => 0, opId: (op) => op.id, groupKey: (op) => op.key,
    admit: (op, existing) => ({ group: existing ?? { key: op.key, origin: op.key, entries: [], ids: 0 }, entry: { op, count: 1, opIds: [] }, added: true }),
    members, commitGroup,
    side: { limit: 10, commit: sideCommit },
    onDrained: (at) => drained.push(at),
  });
  return { queue, drained };
}

describe('bounded queue failure handling', () => {
  it('continues and counts each operation once if a members hook throws after a failed or successful commit', async () => {
    const { queue } = makeQueue(async (group, _signal, outcomes) => {
      if (group.key === 'one') throw new Error('commit failed');
      outcomes[0] = null;
    }, async () => {}, () => { throw new Error('members failed'); });
    queue.enqueue({ id: 'one', key: 'one' });
    queue.enqueue({ id: 'two', key: 'two' });
    await queue.drain();
    expect(queue.stats()).toMatchObject({ committed: 1, dropped: { io_error: 1 }, pending: 0 });
  });
  it('accounts for a rejected group, releases settle and drain, and continues', async () => {
    let fail = true;
    const { queue, drained } = makeQueue(async (_group, _signal, outcomes) => {
      if (fail) { fail = false; throw new Error('commit failed'); }
      outcomes[0] = null;
    });
    queue.enqueue({ id: 'one', key: 'one' });
    queue.enqueue({ id: 'two', key: 'two' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(queue.settle()).resolves.toBeUndefined();
    await expect(queue.drain()).resolves.toBeUndefined();
    expect(queue.stats()).toMatchObject({ committed: 1, dropped: { io_error: 1 }, pending: 0 });
    expect(drained).toHaveLength(1);
  });

  it('accounts for a rejected side commit and drains', async () => {
    const { queue } = makeQueue(async () => {}, async () => { throw new Error('side failed'); });
    queue.enqueueSide({ id: 'one', key: 'one' });
    await queue.drain();
    expect(queue.stats().dropped.io_error).toBe(1);
  });

  it('handles a commit rejecting after its timeout', async () => {
    let reject!: (error: Error) => void;
    const { queue } = makeQueue(() => new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; }));
    queue.enqueue({ id: 'one', key: 'one' });
    await queue.drain();
    expect(queue.stats().dropped.timeout).toBe(1);
    reject(new Error('late failure'));
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
});
