import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { KnowledgeService, type TrustedKnowledgeContext } from '../mcp-server/src/memory/knowledge-service.js';
import { JsonKnowledgePolicyStore } from '../mcp-server/src/memory/knowledge-policy-store.js';
import { JsonKnowledgeStore } from '../mcp-server/src/memory/knowledge-store.js';
import { KnowledgeDeletionJournal } from '../mcp-server/src/memory/knowledge-deletion-journal.js';
import { transitionKnowledgePolicy } from '../mcp-server/src/memory/knowledge-policy.js';
import { defaultPolicy, enablePolicy } from '../mcp-server/src/memory/policy.js';

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-service-test-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const initialContext = (): TrustedKnowledgeContext => ({
  sessionId: 'session-a', connectionId: 'connection-a', browserId: 'profile-a', origin: 'https://example.invalid',
});
const input = () => ({ category: 'site', subject: 'معلومة', body: 'بيانات تجريبية', source: 'task_summary' });
const memory = () => enablePolicy(defaultPolicy(), '2026-11-05T00:00:00.000Z');

async function enablePolicyForTest(profile = 'profile-a'): Promise<void> {
  const policies = new JsonKnowledgePolicyStore(dir);
  const initial = await policies.get(profile);
  await policies.put(profile, transitionKnowledgePolicy(initial, { action: 'enable' }), initial.generation, { validateApproval: () => true });
}

describe('site knowledge service in isolation', () => {
  it('fails closed while knowledge policy is disabled', async () => {
    const service = new KnowledgeService(dir, { currentContext: async () => initialContext(), currentMemoryPolicy: memory });
    await expect(service.prepareAdd([input()])).rejects.toThrow();
    await expect(service.read()).rejects.toThrow();
  });

  it.each(['sessionId', 'connectionId'] as const)('rejects an incomplete trusted %s', async (field) => {
    await enablePolicyForTest();
    const service = new KnowledgeService(dir, {
      currentContext: async () => ({ ...initialContext(), [field]: '' }), currentMemoryPolicy: memory,
    });
    await expect(service.read()).rejects.toThrow();
  });

  it('does not persist a proposal until the owner approval callback succeeds', async () => {
    await enablePolicyForTest();
    const service = new KnowledgeService(dir, { currentContext: async () => initialContext(), currentMemoryPolicy: memory });
    const draft = await service.prepareAdd([input()]);
    expect(await new JsonKnowledgeStore(dir).get('profile-a', 'https://example.invalid')).toBeNull();
    await expect(service.commitAdd(draft.id, () => false)).rejects.toThrow();
    expect(await new JsonKnowledgeStore(dir).get('profile-a', 'https://example.invalid')).toBeNull();
  });

  it('previews only the current scope and cancellation prevents a later commit', async () => {
    await enablePolicyForTest();
    let context = initialContext();
    const service = new KnowledgeService(dir, { currentContext: async () => context, currentMemoryPolicy: memory });
    const draft = await service.prepareAdd([input()]);
    expect((await service.preview(draft.id, 'add')).entries[0].body).toBe(input().body);
    context = { ...context, connectionId: 'other-connection' };
    await expect(service.preview(draft.id, 'add')).rejects.toThrow();
    context = initialContext();
    await expect(service.commitAdd(draft.id, () => true)).rejects.toThrow();
    const next = await service.prepareAdd([input()]);
    service.cancel(next.id);
    await expect(service.commitAdd(next.id, () => true)).rejects.toThrow();
    expect(await service.read()).toBeNull();
  });

  it('drops the drafts of a disconnected session and leaves other sessions alone', async () => {
    await enablePolicyForTest();
    const service = new KnowledgeService(dir, { currentContext: async () => initialContext(), currentMemoryPolicy: memory });
    const draft = await service.prepareAdd([input()]);
    service.cancelSession('session-zzz');
    expect((await service.preview(draft.id, 'add')).entries[0].body).toBe(input().body);
    service.cancelSession(initialContext().sessionId);
    await expect(service.preview(draft.id, 'add')).rejects.toThrow();
    await expect(service.commitAdd(draft.id, () => true)).rejects.toThrow();
    expect(await new JsonKnowledgeStore(dir).get('profile-a', 'https://example.invalid')).toBeNull();
  });

  it('writes only the selected proposed entries after an approved commit', async () => {
    await enablePolicyForTest();
    const service = new KnowledgeService(dir, { currentContext: async () => initialContext(), currentMemoryPolicy: memory });
    const draft = await service.prepareAdd([input(), { ...input(), subject: 'ثانية' }]);
    await service.commitAdd(draft.id, () => true);
    const record = await service.read();
    expect(record?.entries.map((entry) => entry.subject)).toEqual(['معلومة', 'ثانية']);
    expect(record?.revision).toBe(1);
    await expect(service.commitAdd(draft.id, () => true)).rejects.toThrow();
  });

  it('refuses commit after a session or profile change', async () => {
    await enablePolicyForTest();
    let context = initialContext();
    const service = new KnowledgeService(dir, { currentContext: async () => context, currentMemoryPolicy: memory });
    const draft = await service.prepareAdd([input()]);
    context = { ...context, connectionId: 'other-connection' };
    await expect(service.commitAdd(draft.id, () => true)).rejects.toThrow();
    expect(await new JsonKnowledgeStore(dir).get('profile-a', 'https://example.invalid')).toBeNull();
  });

  it('discards a draft if the trusted context is temporarily unavailable during commit', async () => {
    await enablePolicyForTest();
    let unavailable = false;
    const service = new KnowledgeService(dir, {
      currentContext: async () => { if (unavailable) throw new Error('temporary disconnect'); return initialContext(); },
      currentMemoryPolicy: memory,
    });
    const draft = await service.prepareAdd([input()]);
    unavailable = true;
    await expect(service.commitAdd(draft.id, () => true)).rejects.toThrow();
    unavailable = false;
    await expect(service.commitAdd(draft.id, () => true)).rejects.toThrow();
    expect(await new JsonKnowledgeStore(dir).get('profile-a', 'https://example.invalid')).toBeNull();
  });

  it('refuses pending commit after policy is disabled', async () => {
    await enablePolicyForTest();
    const service = new KnowledgeService(dir, { currentContext: async () => initialContext(), currentMemoryPolicy: memory });
    const draft = await service.prepareAdd([input()]);
    const policies = new JsonKnowledgePolicyStore(dir);
    const current = await policies.get('profile-a');
    await policies.put('profile-a', transitionKnowledgePolicy(current, { action: 'disable' }), current.generation, { validateApproval: () => true });
    await expect(service.commitAdd(draft.id, () => true)).rejects.toThrow();
    expect(await new JsonKnowledgeStore(dir).get('profile-a', 'https://example.invalid')).toBeNull();
  });

  it('rejects a read when policy changes during the final scope check', async () => {
    await enablePolicyForTest();
    const policies = new JsonKnowledgePolicyStore(dir);
    let calls = 0;
    const service = new KnowledgeService(dir, {
      currentMemoryPolicy: memory,
      currentContext: async () => {
        if (++calls === 2) {
          const current = await policies.get('profile-a');
          await policies.put('profile-a', transitionKnowledgePolicy(current, { action: 'disable' }), current.generation, { validateApproval: () => true });
        }
        return initialContext();
      },
    });
    await expect(service.read()).rejects.toThrow();
  });

  it('does not persist when owner approval expires during commit checks', async () => {
    await enablePolicyForTest();
    const service = new KnowledgeService(dir, { currentContext: async () => initialContext(), currentMemoryPolicy: memory });
    const draft = await service.prepareAdd([input()]);
    let checks = 0;
    await expect(service.commitAdd(draft.id, () => ++checks < 3)).rejects.toThrow();
    expect(await new JsonKnowledgeStore(dir).get('profile-a', 'https://example.invalid')).toBeNull();
  });

  it('does not persist if the existing memory policy is disabled during final approval', async () => {
    await enablePolicyForTest();
    let currentMemory = memory();
    const service = new KnowledgeService(dir, {
      currentContext: async () => initialContext(), currentMemoryPolicy: () => currentMemory,
    });
    const draft = await service.prepareAdd([input()]);
    let checks = 0;
    await expect(service.commitAdd(draft.id, () => {
      if (++checks === 4) currentMemory = defaultPolicy();
      return true;
    })).rejects.toThrow();
    expect(await new JsonKnowledgeStore(dir).get('profile-a', 'https://example.invalid')).toBeNull();
  });

  it('does not persist if the trusted tab moves during commit', async () => {
    await enablePolicyForTest();
    let checks = 0;
    const service = new KnowledgeService(dir, {
      currentMemoryPolicy: memory,
      currentContext: async () => {
        checks += 1;
        return checks >= 6 ? { ...initialContext(), origin: 'https://other.invalid' } : initialContext();
      },
    });
    const draft = await service.prepareAdd([input()]);
    await expect(service.commitAdd(draft.id, () => true)).rejects.toThrow();
    expect(await new JsonKnowledgeStore(dir).get('profile-a', 'https://example.invalid')).toBeNull();
  });

  it('reviews an edit, preserves its ID, and applies it only after approval', async () => {
    await enablePolicyForTest();
    const service = new KnowledgeService(dir, { currentContext: async () => initialContext(), currentMemoryPolicy: memory });
    const add = await service.prepareAdd([input()]);
    const original = (await service.commitAdd(add.id, () => true)).entries[0]!;
    const edit = await service.prepareEdit(original.id, { ...input(), body: 'نص معدل' });
    expect((await service.read())?.entries[0]?.body).toBe(original.body);
    const changed = await service.commitEdit(edit.id, () => true);
    expect(changed.entries[0]).toMatchObject({ id: original.id, createdAt: original.createdAt, body: 'نص معدل' });
    expect(changed.revision).toBe(2);
  });

  it('leaves a record intact when deletion is declined and deletes after approval', async () => {
    await enablePolicyForTest();
    const service = new KnowledgeService(dir, { currentContext: async () => initialContext(), currentMemoryPolicy: memory });
    const add = await service.prepareAdd([input()]);
    const original = (await service.commitAdd(add.id, () => true)).entries[0]!;
    const denied = await service.prepareDelete(original.id);
    await expect(service.commitDelete(denied.id, () => false)).rejects.toThrow();
    expect((await service.read())?.entries).toHaveLength(1);
    const approvedDelete = await service.prepareDelete(original.id);
    const after = await service.commitDelete(approvedDelete.id, () => true);
    expect(after.entries).toEqual([]);
    expect(after.revision).toBe(2);
  });

  it('rejects one of two approvals for the same initial revision', async () => {
    await enablePolicyForTest();
    const service = new KnowledgeService(dir, { currentContext: async () => initialContext(), currentMemoryPolicy: memory });
    const first = await service.prepareAdd([input()]);
    const second = await service.prepareAdd([{ ...input(), subject: 'ثانية' }]);
    const results = await Promise.allSettled([service.commitAdd(first.id, () => true), service.commitAdd(second.id, () => true)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect((await service.read())?.entries).toHaveLength(1);
  });

  it('does not return an entry deleted while a read is in progress', async () => {
    await enablePolicyForTest();
    const writer = new KnowledgeService(dir, { currentContext: async () => initialContext(), currentMemoryPolicy: memory });
    const add = await writer.prepareAdd([input()]);
    const original = (await writer.commitAdd(add.id, () => true)).entries[0]!;
    let release!: () => void;
    let notify!: () => void;
    const waiting = new Promise<void>((resolve) => { notify = resolve; });
    let calls = 0;
    const reader = new KnowledgeService(dir, {
      currentMemoryPolicy: memory,
      currentContext: async () => {
        if (++calls === 2) await new Promise<void>((resolve) => { release = resolve; notify(); });
        return initialContext();
      },
    });
    const pendingRead = reader.read();
    await waiting;
    const deletion = await writer.prepareDelete(original.id);
    await writer.commitDelete(deletion.id, () => true);
    release();
    await expect(pendingRead).rejects.toThrow();
    expect((await writer.read())?.entries).toHaveLength(0);
  });

  it('blocks reading and old draft commits while durable deletion recovery is pending', async () => {
    await enablePolicyForTest();
    const service = new KnowledgeService(dir, { currentContext: async () => initialContext(), currentMemoryPolicy: memory });
    const add = await service.prepareAdd([input()]);
    await service.commitAdd(add.id, () => true);
    const pending = await service.prepareAdd([{ ...input(), subject: 'معلقة' }]);
    await new KnowledgeDeletionJournal(dir).begin('https://example.invalid', () => true);
    await expect(service.read()).rejects.toThrow();
    await expect(service.commitAdd(pending.id, () => true)).rejects.toThrow();
    await expect(new JsonKnowledgeStore(dir).get('profile-a', 'https://example.invalid')).rejects.toThrow();
  });
});
