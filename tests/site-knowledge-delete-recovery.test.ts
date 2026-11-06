import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { KnowledgeDeletionCoordinator } from '../mcp-server/src/memory/knowledge-deletion-coordinator.js';
import { KnowledgeDeletionJournal } from '../mcp-server/src/memory/knowledge-deletion-journal.js';
import { JsonKnowledgeStore } from '../mcp-server/src/memory/knowledge-store.js';
import type { KnowledgeFile } from '../mcp-server/src/memory/knowledge-record.js';
import { MemoryService } from '../mcp-server/src/memory/service.js';
import { defaultPolicy, enablePolicy, writePolicy } from '../mcp-server/src/memory/policy.js';

let dir: string;
const origin = 'https://example.invalid';
const approved = { validateCommit: () => true, finalizeCommit: () => {} };
const record: KnowledgeFile = { schemaVersion: 1, browserId: 'profile-a', origin, revision: 1, updatedAt: '2026-11-05T00:00:00.000Z', entries: [] };
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-delete-recovery-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe('coordinated deletion recovery', () => {
  it('does not touch old or new stores if the owner does not authorize deletion', async () => {
    const legacyDelete = vi.fn(async () => undefined);
    const coordinator = new KnowledgeDeletionCoordinator(dir, { deleteLegacy: legacyDelete, verifyLegacy: async () => true });
    const result = await coordinator.run(origin, () => false);
    expect(result.success).toBe(false);
    expect(legacyDelete).not.toHaveBeenCalled();
    expect(await new KnowledgeDeletionJournal(dir).isBlocked(origin)).toBe(false);
  });

  it('existing owner site deletion also removes site knowledge before reporting success', async () => {
    await writePolicy(dir, enablePolicy(defaultPolicy(), '2026-11-05T00:00:00.000Z'));
    const store = new JsonKnowledgeStore(dir);
    await store.put(record, 0, approved);
    const legacy = new MemoryService({
      memoryDir: dir, vault: { memoryEligibility: () => 'clear' },
      connection: () => ({ browserId: 'profile-a', connectionId: 'connection-a', ambiguous: false, supportsSiteContext: true }),
    });
    const result = await legacy.admin({ kind: 'memory-admin', id: 'fixture', command: 'delete', origin });
    expect(result.success).toBe(true);
    expect(await store.get('profile-a', origin)).toBeNull();
    await legacy.flush();
  });

  it('routes the existing wire command through coordinated deletion and preserves other sites', async () => {
    await writePolicy(dir, enablePolicy(defaultPolicy(), '2026-11-05T00:00:00.000Z'));
    const store = new JsonKnowledgeStore(dir);
    const other = 'https://other.invalid';
    await store.put(record, 0, approved);
    await store.put({ ...record, origin: other }, 0, approved);
    const legacy = new MemoryService({
      memoryDir: dir, vault: { memoryEligibility: () => 'clear' },
      connection: () => ({ browserId: 'profile-a', connectionId: 'connection-a', ambiguous: false, supportsSiteContext: true }),
    });
    expect((await legacy.adminFromWire({ kind: 'memory-admin', id: 'wire', command: 'delete', origin })).success).toBe(true);
    expect(await store.get('profile-a', origin)).toBeNull();
    expect(await store.get('profile-a', other)).not.toBeNull();
    await legacy.flush();
  });

  it('keeps deletion blocked if a quarantined map prevents verification', async () => {
    await writePolicy(dir, enablePolicy(defaultPolicy(), '2026-11-05T00:00:00.000Z'));
    const store = new JsonKnowledgeStore(dir);
    await store.put(record, 0, approved);
    const mapDir = path.join(dir, 'maps', 'a'.repeat(64));
    await fs.mkdir(mapDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(mapDir, `${'b'.repeat(64)}.json.corrupt-1`), 'unreadable', { mode: 0o600 });
    const legacy = new MemoryService({
      memoryDir: dir, vault: { memoryEligibility: () => 'clear' },
      connection: () => ({ browserId: 'profile-a', connectionId: 'connection-a', ambiguous: false, supportsSiteContext: true }),
    });
    expect((await legacy.admin({ kind: 'memory-admin', id: 'fixture', command: 'delete', origin })).success).toBe(false);
    expect(await new KnowledgeDeletionJournal(dir).isBlocked(origin)).toBe(true);
    await legacy.flush();
  });

  it('deletes every knowledge scope for the existing delete-all command', async () => {
    await writePolicy(dir, enablePolicy(defaultPolicy(), '2026-11-05T00:00:00.000Z'));
    const store = new JsonKnowledgeStore(dir);
    await store.put(record, 0, approved);
    await store.put({ ...record, browserId: 'profile-b', origin: 'https://other.invalid' }, 0, approved);
    const legacy = new MemoryService({
      memoryDir: dir, vault: { memoryEligibility: () => 'clear' },
      connection: () => ({ browserId: 'profile-a', connectionId: 'connection-a', ambiguous: false, supportsSiteContext: true }),
    });
    expect((await legacy.adminFromWire({ kind: 'memory-admin', id: 'all', command: 'delete', all: true })).success).toBe(true);
    expect(await store.get('profile-a', origin)).toBeNull();
    expect(await store.get('profile-b', 'https://other.invalid')).toBeNull();
    await legacy.flush();
  });

  it('leaves a block when legacy cleanup fails, then resumes safely after restart', async () => {
    const store = new JsonKnowledgeStore(dir);
    await store.put(record, 0, approved);
    const first = new KnowledgeDeletionCoordinator(dir, { deleteLegacy: async () => { throw new Error('synthetic failure'); }, verifyLegacy: async () => true });
    expect((await first.run(origin, () => true)).success).toBe(false);
    expect(await new KnowledgeDeletionJournal(dir).isBlocked(origin)).toBe(true);
    await expect(store.get('profile-a', origin)).rejects.toThrow();
    const restarted = new KnowledgeDeletionCoordinator(dir, { deleteLegacy: async () => undefined, verifyLegacy: async () => true });
    expect((await restarted.run(origin, () => true)).success).toBe(true);
    expect(await new KnowledgeDeletionJournal(dir).isBlocked(origin)).toBe(false);
    expect(await store.get('profile-a', origin)).toBeNull();
  });

  it('keeps the block when legacy cleanup cannot be verified', async () => {
    const coordinator = new KnowledgeDeletionCoordinator(dir, { deleteLegacy: async () => undefined, verifyLegacy: async () => false });
    expect((await coordinator.run(origin, () => true)).success).toBe(false);
    expect(await new KnowledgeDeletionJournal(dir).isBlocked(origin)).toBe(true);
  });

  it('leaves the block after partial knowledge cleanup and finishes on retry', async () => {
    const normal = new JsonKnowledgeStore(dir);
    await normal.put(record, 0, approved);
    await normal.put({ ...record, browserId: 'profile-b' }, 0, approved);
    let calls = 0;
    const failing = new JsonKnowledgeStore(dir, { unlink: async (file) => {
      if (++calls === 2) throw new Error('synthetic failure');
      await fs.unlink(file);
    } });
    const first = new KnowledgeDeletionCoordinator(dir, { deleteLegacy: async () => undefined, verifyLegacy: async () => true, store: failing });
    expect((await first.run(origin, () => true)).success).toBe(false);
    expect(await new KnowledgeDeletionJournal(dir).isBlocked(origin)).toBe(true);
    const restarted = new KnowledgeDeletionCoordinator(dir, { deleteLegacy: async () => undefined, verifyLegacy: async () => true });
    expect((await restarted.run(origin, () => true)).success).toBe(true);
    expect(await normal.get('profile-a', origin)).toBeNull();
    expect(await normal.get('profile-b', origin)).toBeNull();
  });

  it('refuses an overlapping deletion until the active workflow has finished', async () => {
    let release!: () => void;
    let notify!: () => void;
    const started = new Promise<void>((resolve) => { notify = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const coordinator = new KnowledgeDeletionCoordinator(dir, {
      deleteLegacy: async () => { calls += 1; if (calls === 1) { notify(); await gate; } },
      verifyLegacy: async () => true,
    });
    const first = coordinator.run(origin, () => true);
    await started;
    const second = await coordinator.run(origin, () => true);
    try { expect(second.success).toBe(false); expect(calls).toBe(1); } finally { release(); }
    expect((await first).success).toBe(true);
    expect((await coordinator.run(origin, () => true)).success).toBe(true);
    expect(await new KnowledgeDeletionJournal(dir).isBlocked(origin)).toBe(false);
  });
});
