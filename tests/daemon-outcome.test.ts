import { afterEach, describe, expect, it, vi } from 'vitest';

// Importing daemon.ts starts main(); keep that bootstrap pending without binding a socket.
vi.mock('../mcp-server/src/daemon-config.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../mcp-server/src/daemon-config.js')>(),
  prepareSecretDirectory: vi.fn(),
  acquireDaemonLock: () => new Promise<void>(() => {}),
}));
vi.mock('../mcp-server/src/vault/daemon-routing.js', () => ({ routeVaultAwareCall: vi.fn() }));

import { Daemon } from '../mcp-server/src/daemon.js';
import { routeVaultAwareCall } from '../mcp-server/src/vault/daemon-routing.js';

const secret = 'synthetic-private-error';

function fixture() {
  const daemon = new Daemon() as any;
  const writes: any[] = [];
  const client = { socket: { write: (line: string) => writes.push(JSON.parse(line)) }, sessionId: 'session', agentName: 'fixture', pending: new Map(), rateWindowStart: Date.now(), rateBudget: 120 };
  daemon.bridge = {};
  daemon.vaultService = {};
  daemon.memory = { beginCall: vi.fn(() => ({ observe: false })), withReminder: vi.fn(async (_call: unknown, outcome: any) => outcome.result), afterCall: vi.fn() };
  const call = () => daemon.routeCall(client, { kind: 'call', id: '1', cid: 'abcd1234', tool: 'browser_click', params: { tabId: 1 } });
  return { daemon, client, writes, call };
}

afterEach(() => { vi.resetAllMocks(); });

describe('daemon result handling', () => {
  it('keeps a successful result when post-response observation throws and sends no second result', async () => {
    const f = fixture();
    vi.mocked(routeVaultAwareCall).mockResolvedValue({ success: true, result: { ok: true } });
    f.daemon.memory.afterCall.mockImplementation(() => { throw new Error(secret); });
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await f.call();
      expect(f.writes).toEqual([{ kind: 'result', id: '1', cid: 'abcd1234', success: true, result: { ok: true } }]);
      expect(JSON.stringify(stderr.mock.calls)).not.toContain(secret);
      expect(f.client.pending.size).toBe(0);
      expect(f.daemon.pendingCalls.size).toBe(0);
    } finally { stderr.mockRestore(); }
  });

  it('returns a generic safe error and cleans up when preparation fails', async () => {
    const f = fixture();
    f.daemon.memory.beginCall.mockImplementation(() => { throw new Error(secret); });
    await f.call();
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0].error).toMatch(/^INTERNAL_ERROR: /);
    expect(JSON.stringify(f.writes)).not.toContain(secret);
    expect(f.client.pending.size).toBe(0);
    expect(f.daemon.pendingCalls.size).toBe(0);
  });

  it('fails closed without exposing an exception if result sanitization fails', async () => {
    const f = fixture();
    vi.mocked(routeVaultAwareCall).mockRejectedValue(new Error(secret));
    await f.call();
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0].success).toBe(false);
    expect(f.writes[0].error).toMatch(/^INTERNAL_ERROR: .*may have/);
    expect(JSON.stringify(f.writes)).not.toContain(secret);
    expect(f.client.pending.size).toBe(0);
  });

  it('returns the already sanitized result if the optional reminder fails', async () => {
    const f = fixture();
    vi.mocked(routeVaultAwareCall).mockResolvedValue({ success: true, result: { ok: true } });
    f.daemon.memory.withReminder.mockRejectedValue(new Error(secret));
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await f.call();
      expect(f.writes).toEqual([{ kind: 'result', id: '1', cid: 'abcd1234', success: true, result: { ok: true } }]);
      expect(JSON.stringify(stderr.mock.calls)).not.toContain(secret);
    } finally { stderr.mockRestore(); }
  });
});
