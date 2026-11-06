import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { KnowledgeReadRouter } from '../mcp-server/src/memory/knowledge-route.js';
import { JsonKnowledgeStore } from '../mcp-server/src/memory/knowledge-store.js';
import { JsonKnowledgePolicyStore } from '../mcp-server/src/memory/knowledge-policy-store.js';
import { createKnowledgeProposal } from '../mcp-server/src/memory/knowledge-entry.js';
import { transitionKnowledgePolicy } from '../mcp-server/src/memory/knowledge-policy.js';
import { defaultPolicy, enablePolicy, writePolicy } from '../mcp-server/src/memory/policy.js';

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-route-test-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });
const signal = () => new AbortController().signal;

async function setup() {
  await writePolicy(dir, enablePolicy(defaultPolicy(), '2026-11-05T00:00:00.000Z'));
  const policies = new JsonKnowledgePolicyStore(dir);
  const initial = await policies.get('profile-a');
  await policies.put('profile-a', transitionKnowledgePolicy(initial, { action: 'enable' }), 0, { validateApproval: () => true });
  const entries = Array.from({ length: 25 }, (_, index) => createKnowledgeProposal({
    category: 'site', subject: `معلومة ${index}`, body: 'بيانات تجريبية', source: 'task_summary',
  }));
  const store = new JsonKnowledgeStore(dir);
  await store.put({ schemaVersion: 1, browserId: 'profile-a', origin: 'https://example.invalid', revision: 1, updatedAt: '2026-11-05T00:00:00.000Z', entries }, 0,
    { validateCommit: () => true, finalizeCommit: () => {} });
  const context = { url: 'https://example.invalid/page', incognito: false, topLevel: true, stable: true, anonymous: true };
  const connection = { browserId: 'profile-a', connectionId: 'connection-a', ambiguous: false, supportsSiteContext: true };
  const router = new KnowledgeReadRouter({
    memoryDir: dir, connection: () => connection, vaultEligibility: () => 'clear', sessionLive: () => true,
    bridge: { callTool: async () => ({ siteContext: context }) },
  });
  return { router, context, connection };
}

describe('site knowledge read route', () => {
  it('searches Arabic text and binds cursors to the query and category', async () => {
    const { router } = await setup();
    const first = await router.read({ tabId: 7, action: 'search', query: 'معلومة', category: 'site' }, 'session-a', 'agent', signal());
    expect(first.success).toBe(true);
    if (!first.success || !first.result.nextCursor) throw new Error('expected search cursor');
    expect(first.result.entries.every((entry) => entry.subject.includes('معلومة'))).toBe(true);
    expect((await router.read({ tabId: 7, action: 'search', query: 'تجريبية', category: 'site', cursor: first.result.nextCursor }, 'session-a', 'agent', signal())).success).toBe(false);
    const empty = await router.read({ tabId: 7, action: 'search', query: 'غير موجود', category: 'problem' }, 'session-a', 'agent', signal());
    expect(empty.success && empty.result.entries).toEqual([]);
  });
  it('returns bounded, explicitly untrusted results from the actual tab scope', async () => {
    const { router } = await setup();
    const first = await router.read({ tabId: 7 }, 'session-a', 'agent', signal());
    expect(first.success).toBe(true);
    if (!first.success) return;
    expect(first.result.untrusted).toBe(true);
    expect(first.result.entries.length).toBeLessThanOrEqual(20);
    expect(Buffer.byteLength(JSON.stringify(first.result))).toBeLessThanOrEqual(8192);
    expect(first.result.nextCursor).toBeTruthy();
    const second = await router.read({ tabId: 7, cursor: first.result.nextCursor }, 'session-a', 'agent', signal());
    expect(second.success).toBe(true);
    if (second.success) {
      expect(new Set([...first.result.entries, ...second.result.entries].map((entry) => entry.id)).size).toBe(25);
    }
  });

  it('rejects agent-supplied profile, origin, approval fields and invalid tab IDs', async () => {
    const { router } = await setup();
    for (const args of [{ tabId: 7, browserId: 'profile-b' }, { tabId: 7, origin: 'https://other.invalid' }, { tabId: 7, ownerConfirmed: true }, { tabId: -1 }]) {
      expect((await router.read(args, 'session-a', 'agent', signal())).success).toBe(false);
    }
  });

  it('rejects cursors after profile or origin changes, and does not reveal the prior profile', async () => {
    const { router, context, connection } = await setup();
    const first = await router.read({ tabId: 7 }, 'session-a', 'agent', signal());
    if (!first.success) throw new Error('expected initial fixture read');
    context.url = 'https://other.invalid/';
    expect((await router.read({ tabId: 7, cursor: first.result.nextCursor }, 'session-a', 'agent', signal())).success).toBe(false);
    context.url = 'https://example.invalid/';
    connection.browserId = 'profile-b';
    expect((await router.read({ tabId: 7, cursor: first.result.nextCursor }, 'session-a', 'agent', signal())).success).toBe(false);
  });

  it('rejects malformed or tampered cursors', async () => {
    const { router } = await setup();
    const first = await router.read({ tabId: 7 }, 'session-a', 'agent', signal());
    if (!first.success || !first.result.nextCursor) throw new Error('expected cursor');
    expect((await router.read({ tabId: 7, cursor: `${first.result.nextCursor}!` }, 'session-a', 'agent', signal())).success).toBe(false);
    const tampered = `A${first.result.nextCursor.slice(1)}`;
    expect((await router.read({ tabId: 7, cursor: tampered }, 'session-a', 'agent', signal())).success).toBe(false);
  });
});
