import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonKnowledgeStore } from '../mcp-server/src/memory/knowledge-store.js';
import { JsonKnowledgePolicyStore } from '../mcp-server/src/memory/knowledge-policy-store.js';
import { transitionKnowledgePolicy } from '../mcp-server/src/memory/knowledge-policy.js';
import { invalidateKnowledgeEpoch } from '../mcp-server/src/memory/knowledge-coordinator.js';
import type { KnowledgeFile } from '../mcp-server/src/memory/knowledge-record.js';

const approved = { validateCommit: () => true, finalizeCommit: () => {} };

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-store-test-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

function record(browserId = 'profile-a', revision = 1): KnowledgeFile {
  return { schemaVersion: 1, browserId, origin: 'https://example.invalid', revision, updatedAt: '2026-11-05T00:00:00.000Z', entries: [] };
}

describe('isolated site knowledge store', () => {
  it('rejects writes when the caller omits the commit authorization check', async () => {
    const store = new JsonKnowledgeStore(dir);
    await expect(store.put(record(), 0, undefined as never)).rejects.toThrow();
    expect(await store.get('profile-a', record().origin)).toBeNull();
  });

  it('can recheck trusted asynchronous policy state under the store lock', async () => {
    const policies = new JsonKnowledgePolicyStore(dir);
    const initial = await policies.get('profile-a');
    await policies.put('profile-a', transitionKnowledgePolicy(initial, { action: 'enable' }), 0, { validateApproval: () => true });
    const store = new JsonKnowledgeStore(dir);
    await expect(store.put(record(), 0, { ...approved, validateCommit: async () => (await policies.readForCommit('profile-a')).enabled })).resolves.toBeUndefined();
    expect(await store.get('profile-a', record().origin)).toEqual(record());
  });

  it('finalizes the approved draft exactly once immediately before replacing the file', async () => {
    const store = new JsonKnowledgeStore(dir);
    let finalized = 0;
    await store.put(record(), 0, { validateCommit: () => true, finalizeCommit: () => { finalized += 1; } });
    expect(finalized).toBe(1);
  });

  it('does not replace a record if finalizing approval fails', async () => {
    const store = new JsonKnowledgeStore(dir);
    await store.put(record(), 0, approved);
    await expect(store.put(record('profile-a', 2), 1, {
      validateCommit: () => true, finalizeCommit: () => { throw new Error('approval no longer valid'); },
    })).rejects.toThrow();
    expect(await store.get('profile-a', record().origin)).toEqual(record());
  });

  it('separates profiles at one origin and does not change older stores', async () => {
    const legacy = path.join(dir, 'sites'); await fs.mkdir(legacy);
    const maps = path.join(dir, 'maps'); await fs.mkdir(maps);
    await fs.writeFile(path.join(legacy, 'keep.json'), 'legacy fixture');
    await fs.writeFile(path.join(maps, 'keep.json'), 'map fixture');
    const store = new JsonKnowledgeStore(dir);
    await store.put(record(), 0, approved);
    expect(await store.get('profile-a', record().origin)).toEqual(record());
    expect(await store.get('profile-b', record().origin)).toBeNull();
    expect(await fs.readFile(path.join(legacy, 'keep.json'), 'utf8')).toBe('legacy fixture');
    expect(await fs.readFile(path.join(maps, 'keep.json'), 'utf8')).toBe('map fixture');
  });

  it('rejects stale revisions and concurrent conflicting writes', async () => {
    const store = new JsonKnowledgeStore(dir);
    await store.put(record(), 0, approved);
    const writes = await Promise.allSettled([store.put(record('profile-a', 2), 1, approved), store.put(record('profile-a', 2), 1, approved)]);
    expect(writes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect((await store.get('profile-a', record().origin))?.revision).toBe(2);
  });

  it('serializes conflicting writes even through two store instances in one daemon', async () => {
    const one = new JsonKnowledgeStore(dir);
    const two = new JsonKnowledgeStore(dir);
    await one.put(record(), 0, approved);
    const writes = await Promise.allSettled([one.put(record('profile-a', 2), 1, approved), two.put(record('profile-a', 2), 1, approved)]);
    expect(writes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  });

  it('rejects a nonsequential revision', async () => {
    const store = new JsonKnowledgeStore(dir);
    await expect(store.put(record('profile-a', 2), 0, approved)).rejects.toThrow();
    expect(await store.get('profile-a', record().origin)).toBeNull();
  });

  it('returns a stable code when the expected revision is stale', async () => {
    const store = new JsonKnowledgeStore(dir);
    await store.put(record(), 0, approved);
    await expect(store.put(record(), 0, approved)).rejects.toMatchObject({ code: 'STALE_REVISION' });
  });

  it('enforces quotas without deleting existing records', async () => {
    const store = new JsonKnowledgeStore(dir, { maxFilesPerProfile: 1 });
    await store.put(record(), 0, approved);
    await expect(store.put({ ...record(), origin: 'https://other.invalid' }, 0, approved)).rejects.toThrow();
    expect(await store.get('profile-a', record().origin)).toEqual(record());
    await expect(store.put(record('profile-b'), 0, approved)).resolves.toBeUndefined();
  });

  it('rejects writes beyond the total-byte quota without storing a partial record', async () => {
    const store = new JsonKnowledgeStore(dir, { maxTotalBytes: 1 });
    await expect(store.put(record(), 0, approved)).rejects.toThrow();
    expect(await store.get('profile-a', record().origin)).toBeNull();
  });

  it('refuses a symlink in the store directory path', async () => {
    const external = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-external-'));
    try {
      await fs.symlink(external, path.join(dir, 'knowledge'));
      await expect(new JsonKnowledgeStore(dir).put(record(), 0, approved)).rejects.toThrow();
      expect(await fs.readdir(external)).toEqual([]);
    } finally { await fs.rm(external, { recursive: true, force: true }); }
  });

  it('rejects a symlink replacing a stored record', async () => {
    const store = new JsonKnowledgeStore(dir);
    await store.put(record(), 0, approved);
    const directory = path.join(dir, 'knowledge');
    const [file] = await fs.readdir(directory);
    const external = path.join(dir, 'external-fixture');
    await fs.writeFile(external, 'not a record', { mode: 0o600 });
    await fs.unlink(path.join(directory, file!));
    await fs.symlink(external, path.join(directory, file!));
    await expect(store.get('profile-a', record().origin)).rejects.toThrow();
    expect(await fs.readFile(external, 'utf8')).toBe('not a record');
  });

  it.skipIf(process.platform === 'win32')('rejects a record readable by other users', async () => {
    const store = new JsonKnowledgeStore(dir);
    await store.put(record(), 0, approved);
    const directory = path.join(dir, 'knowledge');
    const [file] = await fs.readdir(directory);
    await fs.chmod(path.join(directory, file!), 0o644);
    await expect(store.get('profile-a', record().origin)).rejects.toThrow();
  });

  it('preserves a record with an unsupported schema instead of replacing it', async () => {
    const store = new JsonKnowledgeStore(dir);
    await store.put(record(), 0, approved);
    const directory = path.join(dir, 'knowledge');
    const [file] = await fs.readdir(directory);
    const pathname = path.join(directory, file!);
    const future = JSON.stringify({ ...record(), schemaVersion: 999 });
    await fs.writeFile(pathname, future, { mode: 0o600 });
    await expect(store.put(record('profile-a', 2), 1, approved)).rejects.toThrow();
    expect(await fs.readFile(pathname, 'utf8')).toBe(future);
  });

  it('refuses a record whose stored identity does not match its filename', async () => {
    const store = new JsonKnowledgeStore(dir);
    await store.put(record(), 0, approved);
    const directory = path.join(dir, 'knowledge');
    const [file] = await fs.readdir(directory);
    await fs.writeFile(path.join(directory, file!), JSON.stringify({ ...record(), browserId: 'profile-b' }), { mode: 0o600 });
    await expect(store.get('profile-a', record().origin)).rejects.toMatchObject({ code: 'MEMORY_CORRUPT' });
  });

  it('leaves the old record intact on a failure before rename', async () => {
    const store = new JsonKnowledgeStore(dir);
    await store.put(record(), 0, approved);
    const failing = new JsonKnowledgeStore(dir, { afterTempWrite: async () => { throw new Error('synthetic failure'); } });
    await expect(failing.put(record('profile-a', 2), 1, approved)).rejects.toThrow();
    expect(await store.get('profile-a', record().origin)).toEqual(record());
  });

  it('cancels an aborted write after the temporary file is written', async () => {
    const initial = new JsonKnowledgeStore(dir);
    await initial.put(record(), 0, approved);
    const controller = new AbortController();
    const store = new JsonKnowledgeStore(dir, { afterTempWrite: async () => { controller.abort(); } });
    await expect(store.put(record('profile-a', 2), 1, { ...approved, signal: controller.signal })).rejects.toThrow();
    expect(await initial.get('profile-a', record().origin)).toEqual(record());
  });

  it('cancels when an asynchronous commit guard is interrupted', async () => {
    const initial = new JsonKnowledgeStore(dir);
    await initial.put(record(), 0, approved);
    const controller = new AbortController();
    let calls = 0;
    const guard = async () => { if (++calls === 2) controller.abort(); return true; };
    await expect(initial.put(record('profile-a', 2), 1, { ...approved, signal: controller.signal, validateCommit: guard })).rejects.toThrow();
    expect(await initial.get('profile-a', record().origin)).toEqual(record());
  });

  it('refuses to commit when the policy generation changes during the write', async () => {
    const initial = new JsonKnowledgeStore(dir);
    await initial.put(record(), 0, approved);
    let generation = 1;
    const store = new JsonKnowledgeStore(dir, { afterTempWrite: async () => { generation = 2; } });
    await expect(store.put(record('profile-a', 2), 1, { ...approved, validateCommit: () => generation === 1 })).rejects.toThrow();
    expect(await initial.get('profile-a', record().origin)).toEqual(record());
  });

  it('cancels a pending write when an approved policy disable arrives before rename', async () => {
    const policies = new JsonKnowledgePolicyStore(dir);
    const initialPolicy = await policies.get('profile-a');
    const enabled = transitionKnowledgePolicy(initialPolicy, { action: 'enable' });
    const policyApproval = { validateApproval: () => true };
    await policies.put('profile-a', enabled, 0, policyApproval);
    const initial = new JsonKnowledgeStore(dir);
    await initial.put(record(), 0, approved);
    let pendingDisable: Promise<void> | undefined;
    const store = new JsonKnowledgeStore(dir, { afterTempWrite: async () => {
      const disabled = transitionKnowledgePolicy(enabled, { action: 'disable' });
      pendingDisable = policies.put('profile-a', disabled, enabled.generation, policyApproval);
    } });
    await expect(store.put(record('profile-a', 2), 1, approved)).rejects.toThrow();
    expect(pendingDisable).toBeDefined();
    await pendingDisable;
    expect((await policies.get('profile-a')).enabled).toBe(false);
    expect(await initial.get('profile-a', record().origin)).toEqual(record());
  });

  it('cancels a pending write if a delete invalidates its generation', async () => {
    const initial = new JsonKnowledgeStore(dir);
    await initial.put(record(), 0, approved);
    const store = new JsonKnowledgeStore(dir, { afterTempWrite: async () => { invalidateKnowledgeEpoch(dir); } });
    await expect(store.put(record('profile-a', 2), 1, approved)).rejects.toThrow();
    expect(await initial.get('profile-a', record().origin)).toEqual(record());
  });

  it('leaves the old record intact when rename fails', async () => {
    const store = new JsonKnowledgeStore(dir);
    await store.put(record(), 0, approved);
    const failing = new JsonKnowledgeStore(dir, { rename: async () => { throw new Error('synthetic rename failure'); } });
    await expect(failing.put(record('profile-a', 2), 1, approved)).rejects.toThrow();
    expect(await store.get('profile-a', record().origin)).toEqual(record());
  });

  it('reports an unconfirmed outcome if directory durability fails after rename', async () => {
    const store = new JsonKnowledgeStore(dir);
    await store.put(record(), 0, approved);
    const failing = new JsonKnowledgeStore(dir, { syncDirectory: async () => { throw new Error('synthetic failure'); } });
    await expect(failing.put(record('profile-a', 2), 1, approved)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    expect((await store.get('profile-a', record().origin))?.revision).toBe(2);
  });
});
