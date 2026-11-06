import { describe, expect, it } from 'vitest';
import { KnowledgeDrafts, type DraftBinding } from '../mcp-server/src/memory/knowledge-draft.js';
import { createKnowledgeProposal } from '../mcp-server/src/memory/knowledge-entry.js';

const binding: DraftBinding = {
  sessionId: 'session-a', connectionId: 'connection-a', browserId: 'profile-a',
  origin: 'https://example.invalid', operation: 'add', revision: 0, policyGeneration: 0, deletionGeneration: 0,
};

const entry = () => createKnowledgeProposal({ category: 'site', subject: 'معلومة', body: 'نص تجريبي', source: 'task_summary' });

describe('in-memory site knowledge drafts', () => {
  it('previews a selected group and consumes it only once after approval', () => {
    const drafts = new KnowledgeDrafts();
    const selected = [entry(), entry()];
    const review = drafts.prepare(binding, selected);
    expect(review.entries).toEqual(selected);
    expect(review.binding).toEqual(binding);
    const result = drafts.consume(review.id, binding, () => true);
    expect(result.entries).toEqual(selected);
    expect(() => drafts.consume(review.id, binding, () => true)).toThrow();
  });

  it('rejects or cancels without allowing a later approval', () => {
    const drafts = new KnowledgeDrafts();
    const first = drafts.prepare(binding, [entry()]);
    expect(() => drafts.consume(first.id, binding, () => false)).toThrow();
    expect(() => drafts.consume(first.id, binding, () => true)).toThrow();
    const second = drafts.prepare(binding, [entry()]);
    drafts.cancel(second.id);
    expect(() => drafts.preview(second.id, binding)).toThrow();
  });

  it('cancels only the drafts belonging to a disconnected session', () => {
    const drafts = new KnowledgeDrafts();
    const first = drafts.prepare(binding, [entry()]);
    const otherBinding = { ...binding, sessionId: 'session-b' };
    const second = drafts.prepare(otherBinding, [entry()]);
    drafts.cancelSession(binding.sessionId);
    expect(() => drafts.preview(first.id, binding)).toThrow();
    expect(drafts.preview(second.id, otherBinding).id).toBe(second.id);
  });

  it('discards every draft at once when the store is cleared', () => {
    const drafts = new KnowledgeDrafts();
    const first = drafts.prepare(binding, [entry()]);
    const otherBinding = { ...binding, sessionId: 'session-b' };
    const second = drafts.prepare(otherBinding, [entry()]);
    drafts.clear();
    expect(() => drafts.preview(first.id, binding)).toThrow();
    expect(() => drafts.preview(second.id, otherBinding)).toThrow();
    expect(drafts.prepare(binding, [entry()]).entries).toHaveLength(1);
  });

  it('expires after five minutes and discards the draft', () => {
    let time = 0;
    const drafts = new KnowledgeDrafts(() => time, () => time);
    const review = drafts.prepare(binding, [entry()]);
    time = 5 * 60 * 1000;
    expect(() => drafts.preview(review.id, binding)).toThrow();
    time = 0;
    expect(() => drafts.preview(review.id, binding)).toThrow();
  });

  it('fails closed if the clock cannot determine expiry', () => {
    let time = 0;
    const drafts = new KnowledgeDrafts(() => time, () => time);
    const review = drafts.prepare(binding, [entry()]);
    time = Number.NaN;
    expect(() => drafts.preview(review.id, binding)).toThrow();
    time = 0;
    expect(() => drafts.preview(review.id, binding)).toThrow();
  });

  it('expires using elapsed time even if the wall clock moves backwards', () => {
    let wall = 10_000;
    let elapsed = 0;
    const drafts = new KnowledgeDrafts(() => wall, () => elapsed);
    const review = drafts.prepare(binding, [entry()]);
    wall = 1;
    elapsed = 5 * 60 * 1000;
    expect(() => drafts.preview(review.id, binding)).toThrow();
  });

  it('rejects control characters in scope identifiers', () => {
    const drafts = new KnowledgeDrafts();
    expect(() => drafts.prepare({ ...binding, browserId: 'profile\u202Efake' }, [entry()])).toThrow();
  });

  it.each([
    ['session', { sessionId: 'other-session' }], ['connection', { connectionId: 'other-connection' }],
    ['profile', { browserId: 'other-profile' }], ['origin', { origin: 'https://other.invalid' }],
    ['operation', { operation: 'delete' }], ['revision', { revision: 1 }],
    ['policy', { policyGeneration: 1 }], ['deletion', { deletionGeneration: 1 }],
  ] as Array<[string, Partial<DraftBinding>]>)('invalidates on changed %s', (_name, changed) => {
    const drafts = new KnowledgeDrafts();
    const review = drafts.prepare(binding, [entry()]);
    expect(() => drafts.consume(review.id, { ...binding, ...changed }, () => true)).toThrow();
    expect(() => drafts.preview(review.id, binding)).toThrow();
  });

  it('never lets changing a returned preview change the approved content', () => {
    const drafts = new KnowledgeDrafts();
    const original = entry();
    const review = drafts.prepare(binding, [original]);
    review.entries[0]!.body = 'بديل';
    expect(drafts.consume(review.id, binding, () => true).entries[0]!.body).toBe(original.body);
  });

  it('rejects empty, oversized, or duplicate selections', () => {
    const drafts = new KnowledgeDrafts();
    const item = entry();
    expect(() => drafts.prepare(binding, [])).toThrow();
    expect(() => drafts.prepare(binding, [item, item])).toThrow();
    expect(() => drafts.prepare(binding, Array.from({ length: 9 }, entry))).toThrow();
    const large = Array.from({ length: 4 }, () => ({ ...entry(), body: 'ن'.repeat(700) }));
    expect(() => drafts.prepare(binding, large)).toThrow();
  });

  it('bounds the number of in-memory drafts and frees cancelled slots', () => {
    const drafts = new KnowledgeDrafts();
    const item = entry();
    const ids = Array.from({ length: 128 }, () => drafts.prepare(binding, [item]).id);
    expect(() => drafts.prepare(binding, [item])).toThrow();
    drafts.cancel(ids[0]!);
    expect(() => drafts.prepare(binding, [item])).not.toThrow();
  });

  it('rejects missing approval and discards the draft', () => {
    const drafts = new KnowledgeDrafts();
    const review = drafts.prepare(binding, [entry()]);
    expect(() => drafts.consume(review.id, binding, undefined as never)).toThrow();
    expect(() => drafts.preview(review.id, binding)).toThrow();
  });
});
