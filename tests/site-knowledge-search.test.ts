import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-search-test-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe('site knowledge search evidence', () => {
  it('returns conflicting claims, planned work and failed tests with their evidence, without executing their text', async () => {
    await writePolicy(dir, enablePolicy(defaultPolicy(), '2026-11-05T00:00:00.000Z'));
    const policies = new JsonKnowledgePolicyStore(dir);
    await policies.put('profile-a', transitionKnowledgePolicy(await policies.get('profile-a'), { action: 'enable' }), 0, { validateApproval: () => true });
    const proposal = (body: string) => createKnowledgeProposal({ category: 'problem', subject: 'حالة المزامنة', body, source: 'task_summary' });
    const first = { ...proposal('المزامنة تعمل'), source: 'historical_record' as const, status: 'historical' as const, observedAt: '2026-10-01T10:00:00.000Z' };
    const second = { ...proposal('إدارة المزامنة لا تعمل'), observedAt: '2026-11-01T10:00:00.000Z' };
    const planned = { ...proposal('إصلاح مخطط؛ لا تنفذه تلقائيًا'), category: 'change' as const, execution: 'planned' as const };
    const failed = {
      ...proposal('اختبار المزامنة فشل'), category: 'test' as const, testOutcome: 'failed' as const,
      attestation: 'corroborated' as const, sourceReference: 'https://example.invalid/evidence',
      lastVerifiedAt: '2026-11-02T10:00:00.000Z',
    };
    await new JsonKnowledgeStore(dir).put({
      schemaVersion: 1, browserId: 'profile-a', origin: 'https://example.invalid', revision: 1,
      updatedAt: '2026-11-05T00:00:00.000Z', entries: [first, second, planned, failed],
    }, 0, { validateCommit: () => true, finalizeCommit: () => {} });
    const bridge = vi.fn(async (tool: string) => {
      if (tool !== 'browser_memory_internal_context') throw new Error('unexpected browser action');
      return { siteContext: { url: 'https://example.invalid/', incognito: false, topLevel: true, stable: true, anonymous: true } };
    });
    const router = new KnowledgeReadRouter({
      memoryDir: dir, connection: () => ({ browserId: 'profile-a', connectionId: 'connection-a', ambiguous: false, supportsSiteContext: true }),
      vaultEligibility: () => 'clear', sessionLive: () => true, bridge: { callTool: bridge },
    });
    const result = await router.read({ tabId: 7, action: 'search', query: 'المزامنة' }, 'session-a', 'agent', new AbortController().signal);
    if (!result.success) throw new Error('expected scoped search result');
    expect(result.result.untrusted).toBe(true);
    expect(result.result.entries).toEqual([first, second, planned, failed]);
    expect(result.result.entries[0]).toMatchObject({ source: 'historical_record', status: 'historical', observedAt: first.observedAt });
    expect(result.result.entries[1]).toMatchObject({ attestation: 'declared', status: 'unverified', lastVerifiedAt: null });
    expect(result.result.entries[2]).toMatchObject({ execution: 'planned', testOutcome: 'not_applicable' });
    expect(result.result.entries[3]).toMatchObject({ testOutcome: 'failed', lastVerifiedAt: failed.lastVerifiedAt });
    expect(bridge).toHaveBeenCalled();
    expect(bridge.mock.calls.every(([tool]) => tool === 'browser_memory_internal_context')).toBe(true);
    const filtered = await router.read({ tabId: 7, action: 'search', query: 'المزامنة', category: 'test' }, 'session-a', 'agent', new AbortController().signal);
    if (!filtered.success) throw new Error('expected filtered result');
    expect(filtered.result.entries).toEqual([failed]);
    const normalized = await router.read({ tabId: 7, action: 'search', query: 'ا\u0655دارة' }, 'session-a', 'agent', new AbortController().signal);
    if (!normalized.success) throw new Error('expected Unicode search result');
    expect(normalized.result.entries).toEqual([second]);
  });
});
