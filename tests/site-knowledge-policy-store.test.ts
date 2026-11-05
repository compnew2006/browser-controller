import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonKnowledgePolicyStore } from '../mcp-server/src/memory/knowledge-policy-store.js';
import { transitionKnowledgePolicy } from '../mcp-server/src/memory/knowledge-policy.js';

const approved = { validateApproval: () => true };

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-policy-test-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe('site knowledge policy persistence', () => {
  it('refuses to persist a change without a caller-provided owner approval check', async () => {
    const store = new JsonKnowledgePolicyStore(dir);
    const initial = await store.get('profile-a');
    const enabled = transitionKnowledgePolicy(initial, { action: 'enable' });
    await expect(store.put('profile-a', enabled, 0, undefined as never)).rejects.toThrow();
    expect((await store.get('profile-a')).enabled).toBe(false);
  });

  it('does not persist a change if approval is revoked before commit', async () => {
    let approvedNow = true;
    const store = new JsonKnowledgePolicyStore(dir, { afterTempWrite: async () => { approvedNow = false; } });
    const initial = await store.get('profile-a');
    const enabled = transitionKnowledgePolicy(initial, { action: 'enable' });
    await expect(store.put('profile-a', enabled, 0, { validateApproval: () => approvedNow })).rejects.toThrow();
    expect((await store.get('profile-a')).enabled).toBe(false);
  });

  it('starts disabled for each profile and retains changes across instances', async () => {
    const first = new JsonKnowledgePolicyStore(dir);
    const initial = await first.get('profile-a');
    expect(initial.enabled).toBe(false);
    const enabled = transitionKnowledgePolicy(initial, { action: 'enable' });
    await first.put('profile-a', enabled, initial.generation, approved);
    const restarted = new JsonKnowledgePolicyStore(dir);
    expect(await restarted.get('profile-a')).toEqual(enabled);
    expect((await restarted.get('profile-b')).enabled).toBe(false);
  });

  it('rejects conflicting updates from separate instances', async () => {
    const first = new JsonKnowledgePolicyStore(dir);
    const second = new JsonKnowledgePolicyStore(dir);
    const initial = await first.get('profile-a');
    const enabled = transitionKnowledgePolicy(initial, { action: 'enable' });
    const results = await Promise.allSettled([
      first.put('profile-a', enabled, initial.generation, approved),
      second.put('profile-a', enabled, initial.generation, approved),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  });

  it('rejects a symlinked policy directory', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-policy-outside-'));
    try {
      await fs.symlink(outside, path.join(dir, 'knowledge-policy'));
      await expect(new JsonKnowledgePolicyStore(dir).get('profile-a')).rejects.toThrow();
      expect(await fs.readdir(outside)).toEqual([]);
    } finally { await fs.rm(outside, { recursive: true, force: true }); }
  });

  it('rejects and preserves a future schema rather than resetting policy', async () => {
    const store = new JsonKnowledgePolicyStore(dir);
    const initial = await store.get('profile-a');
    await store.put('profile-a', transitionKnowledgePolicy(initial, { action: 'enable' }), initial.generation, approved);
    const directory = path.join(dir, 'knowledge-policy');
    const [file] = await fs.readdir(directory);
    const future = JSON.stringify({ schemaVersion: 2, browserId: 'profile-a', policy: initial });
    await fs.writeFile(path.join(directory, file!), future, { mode: 0o600 });
    await expect(store.get('profile-a')).rejects.toThrow();
    await expect(store.put('profile-a', transitionKnowledgePolicy(initial, { action: 'enable' }), 0, approved)).rejects.toThrow();
    expect(await fs.readFile(path.join(directory, file!), 'utf8')).toBe(future);
  });
});
