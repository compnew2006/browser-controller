import { describe, expect, it } from 'vitest';
import { KnowledgeDrafts, type DraftBinding } from '../mcp-server/src/memory/knowledge-draft.js';
import { createKnowledgeProposal } from '../mcp-server/src/memory/knowledge-entry.js';

const binding: DraftBinding = {
  sessionId: 'session-a', connectionId: 'connection-a', browserId: 'profile-a', origin: 'https://example.invalid',
  operation: 'add', revision: 0, policyGeneration: 0, deletionGeneration: 0,
};
const proposal = () => createKnowledgeProposal({ category: 'site', subject: 'اختبار', body: 'بيانات اصطناعية', source: 'task_summary' });

describe('pending approval at commit', () => {
  it('reserves one draft and completes it only once', () => {
    const drafts = new KnowledgeDrafts();
    const draft = drafts.prepare(binding, [proposal()]);
    const lease = drafts.beginCommit(draft.id, binding, () => true);
    expect(() => drafts.beginCommit(draft.id, binding, () => true)).toThrow();
    expect(drafts.validateCommit(lease, binding)).toBe(true);
    expect(drafts.finishCommit(lease, binding).id).toBe(draft.id);
    expect(() => drafts.finishCommit(lease, binding)).toThrow();
  });

  it('refuses a pending commit if its owner approval is revoked', () => {
    const drafts = new KnowledgeDrafts();
    const draft = drafts.prepare(binding, [proposal()]);
    let approved = true;
    const lease = drafts.beginCommit(draft.id, binding, () => approved);
    approved = false;
    expect(() => drafts.finishCommit(lease, binding)).toThrow();
    expect(() => drafts.preview(draft.id, binding)).toThrow();
  });

  it('refuses a pending commit when the session disconnects', () => {
    const drafts = new KnowledgeDrafts();
    const draft = drafts.prepare(binding, [proposal()]);
    const lease = drafts.beginCommit(draft.id, binding, () => true);
    drafts.cancelSession(binding.sessionId);
    expect(() => drafts.finishCommit(lease, binding)).toThrow();
  });

  it('refuses a pending commit when its deadline expires', () => {
    let clock = 0;
    const drafts = new KnowledgeDrafts(() => clock, () => clock);
    const draft = drafts.prepare(binding, [proposal()]);
    const lease = drafts.beginCommit(draft.id, binding, () => true);
    clock = 5 * 60 * 1000;
    expect(() => drafts.finishCommit(lease, binding)).toThrow();
  });
});
