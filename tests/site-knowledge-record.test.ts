import { describe, expect, it } from 'vitest';
import { validateKnowledgeRecord } from '../mcp-server/src/memory/knowledge-record.js';
import { createKnowledgeProposal, validateKnowledgeProposal } from '../mcp-server/src/memory/knowledge-entry.js';

const time = '2026-11-05T00:00:00.000Z';
function record(): Record<string, unknown> {
  return {
    schemaVersion: 1, browserId: 'profile-a', origin: 'https://example.invalid', revision: 0, updatedAt: time,
    entries: [{
      id: '9e2e0987-5e85-4627-8264-d68065f7380a', category: 'site', subject: 'تعريف الموقع', body: 'موقع تجريبي',
      source: 'owner_statement', attestation: 'declared', observedAt: null, lastVerifiedAt: null,
      createdAt: time, updatedAt: time, status: 'unverified', execution: 'unknown', testOutcome: 'not_applicable', relatedIds: [],
    }],
  };
}

describe('site knowledge record boundary', () => {
  const relation = () => ({
    origin: 'https://other.invalid', relationship: 'staging_for', source: 'task_summary',
    attestation: 'declared', observedAt: null,
  });

  it('accepts bounded descriptive related sites without changing legacy records', () => {
    const value = { ...record(), relatedSites: [relation()] };
    expect(validateKnowledgeRecord(value)).toEqual(value);
    expect(validateKnowledgeRecord(record())).toEqual(record());
  });

  it.each([
    ['same origin', [ { ...relation(), origin: 'https://example.invalid' } ]],
    ['duplicate origin', [relation(), relation()]],
    ['non-canonical origin', [ { ...relation(), origin: 'https://other.invalid/path' } ]],
    ['too many references', Array.from({ length: 21 }, (_, i) => ({ ...relation(), origin: `https://site${i}.invalid` }))],
    ['unknown relationship', [ { ...relation(), relationship: 'trusted' } ]],
    ['invalid source', [ { ...relation(), source: 'invented' } ]],
    ['invalid attestation', [ { ...relation(), attestation: 'proven' } ]],
    ['invalid observation time', [ { ...relation(), observedAt: 'tomorrow' } ]],
    ['extra field', [ { ...relation(), secret: 'synthetic-marker' } ]],
  ])('rejects %s in related sites without echo', (_name, relatedSites) => {
    try {
      validateKnowledgeRecord({ ...record(), relatedSites });
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toMatchObject({ code: 'INVALID_ARGUMENT' });
      expect(String(error)).not.toContain('synthetic-marker');
    }
  });

  it('accepts a bounded Arabic record without rewriting it', () => {
    const value = record();
    expect(validateKnowledgeRecord(value)).toEqual(value);
  });

  it('returns a registered argument code without leaking rejected values', () => {
    const value = { ...record(), schemaVersion: 999 };
    try {
      validateKnowledgeRecord(value);
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toMatchObject({ code: 'INVALID_ARGUMENT' });
    }
  });

  it.each([
    ['unknown schema', (v: Record<string, unknown>) => { v.schemaVersion = 2; }],
    ['unknown field', (v: Record<string, unknown>) => { v.extra = true; }],
    ['non-canonical origin', (v: Record<string, unknown>) => { v.origin = 'https://example.invalid/path'; }],
    ['invalid revision', (v: Record<string, unknown>) => { v.revision = -1; }],
    ['too many entries', (v: Record<string, unknown>) => { v.entries = Array(101).fill((v.entries as unknown[])[0]); }],
    ['invalid timestamp', (v: Record<string, unknown>) => { v.updatedAt = 'tomorrow'; }],
    ['impossible timestamp', (v: Record<string, unknown>) => { v.updatedAt = '2026-02-31T00:00:00.000Z'; }],
  ])('rejects %s without echoing input', (_case, mutate) => {
    const value = record(); mutate(value);
    expect(() => validateKnowledgeRecord(value)).toThrow();
  });

  it('rejects oversized UTF-8 content and does not echo it', () => {
    const value = record();
    (value.entries as Array<Record<string, unknown>>)[0]!.body = 'ع'.repeat(2000);
    expect(() => validateKnowledgeRecord(value)).toThrow();
    try { validateKnowledgeRecord(value); } catch (error) { expect(String(error)).not.toContain('ع'.repeat(20)); }
  });

  it('rejects URL credentials or query in a source reference', () => {
    const value = record();
    (value.entries as Array<Record<string, unknown>>)[0]!.sourceReference = 'https://example.invalid/log?secret=test';
    expect(() => validateKnowledgeRecord(value)).toThrow();
  });

  it('rejects known synthetic secrets without echoing them', () => {
    const value = record();
    const marker = 'password=synthetic-example-123';
    (value.entries as Array<Record<string, unknown>>)[0]!.body = marker;
    expect(() => validateKnowledgeRecord(value)).toThrow();
    try { validateKnowledgeRecord(value); } catch (error) { expect(String(error)).not.toContain(marker); }
  });

  it.each(['contact@example.invalid', 'account_id=synthetic-account-123', 'اسم الموظف: اسم تجريبي'])(
    'rejects a detected account identifier without echoing it',
    (identifier) => {
      const value = record();
      (value.entries as Array<Record<string, unknown>>)[0]!.body = identifier;
      expect(() => validateKnowledgeRecord(value)).toThrow();
      try { validateKnowledgeRecord(value); } catch (error) { expect(String(error)).not.toContain(identifier); }
    },
  );

  it('rejects a synthetic payment-card number', () => {
    const value = record();
    (value.entries as Array<Record<string, unknown>>)[0]!.body = '4111 1111 1111 1111';
    expect(() => validateKnowledgeRecord(value)).toThrow();
  });

  it('rejects URLs with query strings embedded in body text', () => {
    const value = record();
    (value.entries as Array<Record<string, unknown>>)[0]!.body = 'انظر https://example.invalid/path?ticket=123';
    expect(() => validateKnowledgeRecord(value)).toThrow();
  });

  it('requires a source reference and verification time for a verified result', () => {
    const value = record();
    const entry = (value.entries as Array<Record<string, unknown>>)[0]!;
    entry.attestation = 'corroborated'; entry.testOutcome = 'passed'; entry.lastVerifiedAt = time;
    expect(() => validateKnowledgeRecord(value)).toThrow();
  });

  it('does not let an untrusted proposal assert that it is corroborated', () => {
    expect(typeof validateKnowledgeProposal).toBe('function');
    const entry = (record().entries as Array<Record<string, unknown>>)[0]!;
    entry.source = 'task_summary'; entry.attestation = 'corroborated'; entry.sourceReference = 'https://example.invalid/evidence';
    expect(() => validateKnowledgeProposal(entry)).toThrow();
  });

  it('accepts an unverified and declared proposal without altering it', () => {
    const entry = (record().entries as Array<Record<string, unknown>>)[0]!;
    entry.source = 'task_summary';
    expect(validateKnowledgeProposal(entry)).toEqual(entry);
  });

  it('does not attribute an agent proposal to the owner without an owner channel', () => {
    const entry = (record().entries as Array<Record<string, unknown>>)[0]!;
    expect(() => validateKnowledgeProposal(entry)).toThrow();
  });

  it('does not let an untrusted proposal claim a verification timestamp', () => {
    const entry = (record().entries as Array<Record<string, unknown>>)[0]!;
    entry.source = 'task_summary';
    entry.lastVerifiedAt = time;
    expect(() => validateKnowledgeProposal(entry)).toThrow();
  });

  it('creates the proposal ID and system times rather than accepting them from an agent', () => {
    const proposal = { category: 'site', subject: 'صفحة', body: 'وصف مختصر', source: 'task_summary' };
    const entry = createKnowledgeProposal(proposal);
    expect(entry.id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(Number.isFinite(Date.parse(entry.createdAt))).toBe(true);
    expect(entry.updatedAt).toBe(entry.createdAt);
    expect(entry.attestation).toBe('declared');
    expect(() => createKnowledgeProposal({ ...proposal, createdAt: time })).toThrow();
    expect(() => createKnowledgeProposal({ ...proposal, id: entry.id })).toThrow();
  });
});
