import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { KnowledgeService, type TrustedKnowledgeContext } from '../mcp-server/src/memory/knowledge-service.js';
import { JsonKnowledgePolicyStore } from '../mcp-server/src/memory/knowledge-policy-store.js';
import { JsonKnowledgeStore } from '../mcp-server/src/memory/knowledge-store.js';
import { KnowledgeDeletionJournal } from '../mcp-server/src/memory/knowledge-deletion-journal.js';
import { createKnowledgeProposal } from '../mcp-server/src/memory/knowledge-entry.js';
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
  it('binds proposed related sites to the reviewed draft and commits them with the selected entries', async () => {
    await enablePolicyForTest();
    const service = new KnowledgeService(dir, { currentContext: async () => initialContext(), currentMemoryPolicy: memory });
    const relation = { origin: 'https://other.invalid', relationship: 'same_product', source: 'task_summary', observedAt: null };
    const draft = await service.prepareAdd([input()], [relation]);
    expect(draft.relatedSites).toEqual([{ ...relation, attestation: 'declared' }]);
    expect(await service.read()).toBeNull();
    const preview = await service.preview(draft.id, 'add');
    expect(preview.relatedSites).toEqual(draft.relatedSites);
    preview.relatedSites![0]!.origin = 'https://changed.invalid';
    const saved = await service.commitAdd(draft.id, () => true);
    expect(saved.relatedSites).toEqual([{ ...relation, attestation: 'declared' }]);
    expect(saved.entries).toHaveLength(1);
    await expect(service.commitAdd(draft.id, () => true)).rejects.toThrow();
  });

  it('rejects unsafe or unapproved related site proposals without writing', async () => {
    await enablePolicyForTest();
    const service = new KnowledgeService(dir, { currentContext: async () => initialContext(), currentMemoryPolicy: memory });
    const relation = { origin: 'https://other.invalid', relationship: 'same_product', source: 'task_summary', observedAt: null };
    for (const candidate of [
      { ...relation, origin: initialContext().origin }, { ...relation, origin: 'https://other.invalid/path' },
      { ...relation, attestation: 'corroborated' }, { ...relation, source: 'owner_statement' },
    ]) await expect(service.prepareAdd([], [candidate])).rejects.toThrow();
    await expect(service.prepareAdd([], [relation, relation])).rejects.toThrow();
    const draft = await service.prepareAdd([], [relation]);
    await expect(service.commitAdd(draft.id, () => false)).rejects.toThrow();
    expect(await service.read()).toBeNull();
  });

  it('rejects stale or oversized related-site batches without a partial write', async () => {
    await enablePolicyForTest();
    const service = new KnowledgeService(dir, { currentContext: async () => initialContext(), currentMemoryPolicy: memory });
    const relation = (index: number) => ({ origin: `https://site${index}.invalid`, relationship: 'same_product', source: 'task_summary', observedAt: null });
    await expect(service.prepareAdd([input()], Array.from({ length: 8 }, (_, index) => relation(index)))).rejects.toThrow();
    const first = await service.prepareAdd([], [relation(1)]);
    const stale = await service.prepareAdd([], [relation(2)]);
    await service.commitAdd(first.id, () => true);
    await expect(service.commitAdd(stale.id, () => true)).rejects.toThrow();
    expect((await service.read())?.relatedSites).toEqual([{ ...relation(1), attestation: 'declared' }]);
    await expect(service.prepareAdd([], [relation(1)])).rejects.toThrow();
  });

  it('refuses a proposal that would exceed the record relationship limit before review', async () => {
    await enablePolicyForTest();
    const makeSite = (index: number) => ({
      origin: `https://site${index}.invalid`, relationship: 'same_product' as const,
      source: 'task_summary' as const, attestation: 'declared' as const, observedAt: null,
    });
    const store = new JsonKnowledgeStore(dir);
    const relatedSites = Array.from({ length: 20 }, (_, index) => makeSite(index));
    await store.put({ schemaVersion: 1, browserId: 'profile-a', origin: initialContext().origin, revision: 1,
      updatedAt: '2026-11-05T00:00:00.000Z', entries: [], relatedSites }, 0,
    { validateCommit: () => true, finalizeCommit: () => {} });
    const service = new KnowledgeService(dir, { currentContext: async () => initialContext(), currentMemoryPolicy: memory });
    const { attestation: _attestation, ...candidate } = makeSite(20);
    await expect(service.prepareAdd([], [candidate])).rejects.toThrow();
    expect((await service.read())?.relatedSites).toEqual(relatedSites);
  });

  it('refuses a proposal that would exceed the record entry limit before review', async () => {
    await enablePolicyForTest();
    const entries = Array.from({ length: 100 }, (_, index) => createKnowledgeProposal({ ...input(), subject: `معلومة ${index}` }));
    const store = new JsonKnowledgeStore(dir);
    await store.put({ schemaVersion: 1, browserId: 'profile-a', origin: initialContext().origin, revision: 1,
      updatedAt: '2026-11-05T00:00:00.000Z', entries }, 0,
    { validateCommit: () => true, finalizeCommit: () => {} });
    const service = new KnowledgeService(dir, { currentContext: async () => initialContext(), currentMemoryPolicy: memory });
    await expect(service.prepareAdd([input()])).rejects.toThrow();
    expect((await service.read())?.entries).toEqual(entries);
  });

  it('preserves descriptive related sites when adding, editing and deleting entries', async () => {
    await enablePolicyForTest();
    const relatedSites = [{
      origin: 'https://other.invalid', relationship: 'same_product' as const, source: 'task_summary' as const,
      attestation: 'declared' as const, observedAt: null,
    }];
    const store = new JsonKnowledgeStore(dir);
    await store.put({
      schemaVersion: 1, browserId: 'profile-a', origin: initialContext().origin, revision: 1,
      updatedAt: '2026-11-05T00:00:00.000Z', entries: [], relatedSites,
    }, 0, { validateCommit: () => true, finalizeCommit: () => {} });
    const service = new KnowledgeService(dir, { currentContext: async () => initialContext(), currentMemoryPolicy: memory });
    const add = await service.prepareAdd([input()]);
    const added = await service.commitAdd(add.id, () => true);
    expect(added.relatedSites).toEqual(relatedSites);
    const edit = await service.prepareEdit(added.entries[0]!.id, { ...input(), body: 'نص معدل' });
    const edited = await service.commitEdit(edit.id, () => true);
    expect(edited.relatedSites).toEqual(relatedSites);
    const deletion = await service.prepareDelete(edited.entries[0]!.id);
    expect((await service.commitDelete(deletion.id, () => true)).relatedSites).toEqual(relatedSites);
    expect((await service.read())?.relatedSites).toEqual(relatedSites);
  });

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
    const candidates = [input(), { ...input(), subject: 'ثانية' }, { ...input(), subject: 'ثالثة غير مختارة' }];
    const draft = await service.prepareAdd(candidates.slice(0, 2));
    expect((await service.preview(draft.id, 'add')).entries.map((entry) => entry.subject)).toEqual(['معلومة', 'ثانية']);
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
