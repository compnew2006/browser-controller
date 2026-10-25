import { describe, expect, it, vi } from 'vitest';
import { RequestJournal } from '../mcp-server/src/vault/requests.js';
import { OperationRegistry } from '../mcp-server/src/vault/operations.js';
import type { VaultBrowserContext } from '../mcp-server/src/vault/service-common.js';

const context: VaultBrowserContext = {
  browserId: 'browser-a',
  browserLabel: 'Fixture browser',
  connectionId: 'conn-1',
  agentName: 'FixtureAgent',
  supportsVault: true,
};
const connection = { browserId: 'browser-a', browserLabel: 'Fixture browser', connectionId: 'conn-1' };
const MINUTE = 60_000;

function journalAt(start = 0) {
  const clock = { now: start };
  const operations = new OperationRegistry();
  const openUi = vi.fn(async () => {});
  let live = true;
  const journal = new RequestJournal({
    now: () => clock.now,
    isSessionLive: () => live,
    operations,
    openUi,
  });
  return { journal, operations, openUi, clock, setLive: (value: boolean) => { live = value; } };
}

const begin = (journal: RequestJournal, overrides: Record<string, unknown> = {}) => journal.begin(context, {
  purpose: 'fill', sessionId: 'session-1', tabId: 7, documentId: 'doc-1', origin: 'https://example.test',
  ...overrides,
});

describe('request journal', () => {
  it('records a pending request with its expiry and opens the private page for it', async () => {
    const { journal, openUi, clock } = journalAt(1_000);
    const pending = await begin(journal);

    expect(pending.request.state).toBe('pending');
    expect(pending.request.expiresAt).toBe(1_000 + 5 * MINUTE);
    expect(pending.agentName).toBe('FixtureAgent');
    expect(openUi).toHaveBeenCalledWith(pending.request.requestId, 'session-1', 'FixtureAgent');
    expect(journal.get(pending.request.requestId)).toBe(pending);
    clock.now = 2_000;
  });

  it('ends a request as failed when the private page never opens', async () => {
    const { journal, operations } = journalAt();
    const failing = new RequestJournal({
      now: () => 0,
      isSessionLive: () => true,
      operations,
      openUi: async () => { throw new Error('no page'); },
    });
    const pending = await begin(failing);
    expect(pending.request.state).toBe('failed');
    expect(pending.terminalAt).toBe(0);
    expect(journal.get(pending.request.requestId)).toBeUndefined();
  });

  it('claims a pending request and binds an operation that cancellation can abort', async () => {
    const { journal, operations } = journalAt();
    const pending = await begin(journal);

    expect(journal.claim(pending)).toBe(true);
    expect(pending.request.state).toBe('processing');
    const signal = operations.signalFor(pending.request.requestId);
    expect(signal?.aborted).toBe(false);

    journal.cancelMatching((item) => item.request.sessionId === 'session-1');
    expect(signal?.aborted).toBe(true);
    expect(pending.request.state).toBe('cancelled');
    expect(pending.terminalAt).toBe(0);
    expect(journal.get(pending.request.requestId)).toBe(pending);
  });

  it('refuses an expired claim and records it as expired', async () => {
    const { journal, operations, clock } = journalAt();
    const pending = await begin(journal);
    clock.now = 5 * MINUTE;

    expect(journal.claim(pending)).toBe(false);
    expect(pending.request.state).toBe('expired');
    expect(operations.signalFor(pending.request.requestId)).toBeUndefined();
  });

  it('expires what timed out, keeps what is live, and forgets a terminal request only after retention', async () => {
    const { journal, clock } = journalAt();
    const expiring = await begin(journal);
    clock.now = 1 * MINUTE;
    const live = await begin(journal, { sessionId: 'session-2' });

    clock.now = 5 * MINUTE;
    journal.expire();
    expect(expiring.request.state).toBe('expired');
    expect(live.request.state).toBe('pending');
    expect(journal.get(expiring.request.requestId)).toBe(expiring);

    clock.now = 5 * MINUTE + 15 * MINUTE + 1;
    journal.expire();
    expect(journal.get(expiring.request.requestId)).toBeUndefined();
    expect(journal.get(live.request.requestId)).toBe(live);
  });

  it('resolves a request only for the connection that can see it', async () => {
    const { journal } = journalAt();
    const pending = await begin(journal);

    expect(journal.forConnection(connection, pending.request.requestId)).toBe(pending);
    expect(journal.forConnection({ ...connection, connectionId: 'conn-2' }, pending.request.requestId)).toBeUndefined();
    expect(journal.forConnection(connection, 42)).toBeUndefined();
    expect(journal.forConnection(connection, 'req_missing')).toBeUndefined();
  });

  it('lists the live requests of one connection oldest first, across its sessions', async () => {
    const { journal, clock } = journalAt();
    const first = await begin(journal);
    clock.now = 1;
    const second = await begin(journal, { sessionId: 'session-2' });
    clock.now = 2;
    const elsewhere = await journal.begin({ ...context, connectionId: 'conn-2' }, {
      purpose: 'list', sessionId: 'session-1', tabId: 7, documentId: 'doc-1', origin: 'https://example.test',
    });

    // The private page shows every session sharing its connection, and only those.
    expect(journal.activeFor(first.request.browserScope, 'conn-1')).toEqual([first, second]);
    expect(journal.activeFor(first.request.browserScope, 'conn-2')).toEqual([elsewhere]);
    journal.settle(first, 'accepted');
    expect(journal.activeFor(first.request.browserScope, 'conn-1')).toEqual([second]);
  });

  it('holds a request valid only while it is unexpired and its session is connected', async () => {
    const { journal, clock, setLive } = journalAt();
    const pending = await begin(journal);

    expect(journal.revalidate(pending)).toBe(true);
    setLive(false);
    expect(journal.revalidate(pending)).toBe(false);
    setLive(true);
    clock.now = 5 * MINUTE;
    expect(journal.revalidate(pending)).toBe(false);
  });

  it('aborts the work bound to a request without rewriting the request state', async () => {
    const { journal, operations } = journalAt();
    const pending = await begin(journal);
    journal.claim(pending);

    journal.abortWorkMatching((item) => item.request.purpose === 'fill');
    expect(operations.signalFor(pending.request.requestId)?.aborted).toBe(true);
    expect(pending.request.state).toBe('processing');
  });
});
