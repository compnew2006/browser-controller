import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { KnowledgeService } from '../mcp-server/src/memory/knowledge-service.js';
import { createKnowledgeContextProvider } from '../mcp-server/src/memory/knowledge-context.js';
import { JsonKnowledgePolicyStore } from '../mcp-server/src/memory/knowledge-policy-store.js';
import { currentKnowledgeEpoch } from '../mcp-server/src/memory/knowledge-coordinator.js';
import { transitionKnowledgePolicy } from '../mcp-server/src/memory/knowledge-policy.js';
import { defaultPolicy, enablePolicy } from '../mcp-server/src/memory/policy.js';

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-context-service-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe('trusted context and knowledge service composition', () => {
  it('uses the selected connection and tab, and refuses agent-provided scope fields', async () => {
    const policies = new JsonKnowledgePolicyStore(dir);
    const state = await policies.get('profile-a');
    await policies.put('profile-a', transitionKnowledgePolicy(state, { action: 'enable' }), 0, { validateApproval: () => true });
    const memory = enablePolicy(defaultPolicy(), '2026-11-05T00:00:00.000Z');
    let url = 'https://example.invalid/page';
    const deps = {
      memoryPolicy: () => memory,
      knowledgePolicy: (browserId: string) => policies.get(browserId),
      knowledgePolicyForCommit: (browserId: string) => policies.readForCommit(browserId),
      connection: () => ({ browserId: 'profile-a', connectionId: 'connection-a', ambiguous: false, supportsSiteContext: true }),
      vaultEligibility: () => 'clear' as const,
      sessionLive: () => true,
      epoch: () => currentKnowledgeEpoch(dir),
      bridge: { callTool: async () => ({ siteContext: { url, incognito: false, topLevel: true, stable: true, anonymous: true } }) },
    };
    const signal = new AbortController().signal;
    const service = new KnowledgeService(dir, {
      currentContext: createKnowledgeContextProvider(deps, 'session-a', 'agent', 7, signal),
      currentMemoryPolicy: () => memory,
    });
    const input = { category: 'site', subject: 'تجربة', body: 'معلومة عامة', source: 'task_summary' };
    await expect(service.prepareAdd([{ ...input, browserId: 'profile-b' }])).rejects.toThrow();
    await expect(service.prepareAdd([{ ...input, origin: 'https://other.invalid' }])).rejects.toThrow();
    const draft = await service.prepareAdd([input]);
    expect(draft.binding).toMatchObject({ browserId: 'profile-a', origin: 'https://example.invalid' });
    url = 'https://other.invalid/';
    await expect(service.commitAdd(draft.id, () => true)).rejects.toThrow();
    url = 'https://example.invalid/page';
    expect(await service.read()).toBeNull();
    const second = await service.prepareAdd([input]);
    const commit = service.commitAdd(second.id, () => true);
    await expect(Promise.race([
      commit,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('commit stalled')), 1000)),
    ])).resolves.toMatchObject({ revision: 1 });
  });
});
