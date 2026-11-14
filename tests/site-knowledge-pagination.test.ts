import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createKnowledgeProposal } from '../mcp-server/src/memory/knowledge-entry.js';
import { KnowledgeReadRouter } from '../mcp-server/src/memory/knowledge-route.js';
import { JsonKnowledgePolicyStore } from '../mcp-server/src/memory/knowledge-policy-store.js';
import { transitionKnowledgePolicy } from '../mcp-server/src/memory/knowledge-policy.js';
import { JsonKnowledgeStore } from '../mcp-server/src/memory/knowledge-store.js';
import { defaultPolicy, enablePolicy, writePolicy } from '../mcp-server/src/memory/policy.js';

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-pagination-test-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe('site knowledge pagination isolation', () => {
  it('bounds pages and refuses stale, malformed and cross-profile cursors without returning another profile', async () => {
    await writePolicy(dir, enablePolicy(defaultPolicy(), '2026-11-05T00:00:00.000Z'));
    const policies = new JsonKnowledgePolicyStore(dir);
    const store = new JsonKnowledgeStore(dir);
    const origin = 'https://example.invalid';
    const approved = { validateCommit: () => true, finalizeCommit: () => {} };
    for (const profile of ['profile-a', 'profile-b']) {
      await policies.put(profile, transitionKnowledgePolicy(await policies.get(profile), { action: 'enable' }), 0, { validateApproval: () => true });
      const entries = Array.from({ length: 25 }, (_, index) => createKnowledgeProposal({
        category: 'site', subject: `${profile} ${index}`, body: 'بيانات اصطناعية', source: 'task_summary',
      }));
      await store.put({ schemaVersion: 1, browserId: profile, origin, revision: 1, updatedAt: '2026-11-05T00:00:00.000Z', entries }, 0, approved);
    }
    const connection = { browserId: 'profile-a', connectionId: 'connection-a', ambiguous: false, supportsSiteContext: true };
    const router = new KnowledgeReadRouter({
      memoryDir: dir, connection: () => connection, vaultEligibility: () => 'clear', sessionLive: () => true,
      bridge: { callTool: async () => ({ siteContext: { url: `${origin}/`, incognito: false, topLevel: true, stable: true, anonymous: true } }) },
    });
    const read = (args: Record<string, unknown>) => router.read(args, 'session-a', 'agent', new AbortController().signal);
    const first = await read({ tabId: 7 });
    if (!first.success || !first.result.nextCursor) throw new Error('expected a first page and cursor');
    expect(first.result.entries.length).toBeLessThanOrEqual(20);
    expect(Buffer.byteLength(JSON.stringify(first.result), 'utf8')).toBeLessThanOrEqual(8192);
    expect(first.result.entries.every((entry) => entry.subject.startsWith('profile-a'))).toBe(true);
    expect((await read({ tabId: 7, cursor: 'not-a-valid-cursor' })).success).toBe(false);
    connection.browserId = 'profile-b'; connection.connectionId = 'connection-b';
    const crossProfile = await read({ tabId: 7, cursor: first.result.nextCursor });
    expect(crossProfile.success).toBe(false);
    expect(JSON.stringify(crossProfile)).not.toContain('profile-a');
    const other = await read({ tabId: 7 });
    if (!other.success) throw new Error('expected separate profile page');
    expect(other.result.entries.every((entry) => entry.subject.startsWith('profile-b'))).toBe(true);
    expect(JSON.stringify(other)).not.toContain('profile-a');
    connection.browserId = 'profile-a'; connection.connectionId = 'connection-a';
    const current = await store.get('profile-a', origin);
    if (!current) throw new Error('expected record');
    await store.put({ ...current, revision: 2 }, 1, approved);
    expect((await read({ tabId: 7, cursor: first.result.nextCursor })).success).toBe(false);
  });
});
