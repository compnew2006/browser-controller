import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryService } from '../mcp-server/src/memory/service.js';
import { JsonKnowledgeStore } from '../mcp-server/src/memory/knowledge-store.js';
import { defaultPolicy, enablePolicy, writePolicy } from '../mcp-server/src/memory/policy.js';
import type { KnowledgeFile } from '../mcp-server/src/memory/knowledge-record.js';
import type { MemoryAdminRequest } from '../mcp-server/src/daemon-config.js';
import { serializeKnowledge } from '../mcp-server/src/memory/knowledge-coordinator.js';

let dir: string;
let legacy: MemoryService;
const origin = 'https://example.invalid';
const approved = { validateCommit: () => true, finalizeCommit: () => {} };
const record = (revision: number): KnowledgeFile => ({
  schemaVersion: 1, browserId: 'profile-a', origin, revision, updatedAt: '2026-11-05T00:00:00.000Z', entries: [],
});

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-legacy-test-'));
  await writePolicy(dir, enablePolicy(defaultPolicy(), '2026-11-05T00:00:00.000Z'));
  legacy = new MemoryService({
    memoryDir: dir, vault: { memoryEligibility: () => 'clear' },
    connection: () => ({ browserId: 'profile-a', connectionId: 'connection-a', ambiguous: false, supportsSiteContext: true }),
  });
});

afterEach(async () => {
  await legacy.flush();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('existing memory policy and knowledge writes', () => {
  it.each(['disable', 'exclude'] as const)('cancels an in-flight knowledge write when existing memory is %sd', async (command) => {
    const baseline = new JsonKnowledgeStore(dir);
    await baseline.put(record(1), 0, approved);
    let pending: Promise<unknown> | undefined;
    const store = new JsonKnowledgeStore(dir, { afterTempWrite: async () => {
      const request: MemoryAdminRequest = { kind: 'memory-admin', id: 'fixture', command, ...(command === 'exclude' ? { origin } : {}) };
      pending = legacy.admin(request);
    } });
    await expect(store.put(record(2), 1, approved)).rejects.toThrow();
    expect(pending).toBeDefined();
    expect(await pending).toMatchObject({ success: true });
    expect((await baseline.get('profile-a', origin))?.revision).toBe(1);
  });

  it('waits for a queued policy change during flush', async () => {
    let release!: () => void;
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    const blocked = serializeKnowledge(dir, () => new Promise<void>((resolve) => { release = resolve; started(); }));
    await running;
    const change = legacy.admin({ kind: 'memory-admin', id: 'fixture', command: 'disable' });
    let flushed = false;
    const flushing = legacy.flush().then(() => { flushed = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    try { expect(flushed).toBe(false); } finally { release(); }
    await Promise.all([blocked, change, flushing]);
    expect(flushed).toBe(true);
  });
});
