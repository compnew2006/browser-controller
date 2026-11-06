import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { KnowledgeDeletionJournal } from '../mcp-server/src/memory/knowledge-deletion-journal.js';

let dir: string;
const origin = 'https://example.invalid';
const approved = () => true;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-delete-journal-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe('durable knowledge deletion journal', () => {
  it('persists a scoped read/write block without storing the origin and reloads it', async () => {
    const journal = new KnowledgeDeletionJournal(dir);
    await journal.begin(origin, approved);
    const restarted = new KnowledgeDeletionJournal(dir);
    expect(await restarted.isBlocked(origin)).toBe(true);
    expect(await restarted.isBlocked('https://other.invalid')).toBe(false);
    expect(await fs.readFile(path.join(dir, 'knowledge-delete-journal.json'), 'utf8')).not.toContain(origin);
  });

  it('blocks all sites for delete-all until cleanup is verified', async () => {
    const journal = new KnowledgeDeletionJournal(dir);
    await journal.begin('*', approved);
    expect(await journal.isBlocked(origin)).toBe(true);
    expect(await journal.blocksAllForCommit()).toBe(true);
    await expect(journal.complete('*', async () => false)).rejects.toThrow();
    expect(await journal.isBlocked(origin)).toBe(true);
    await journal.complete('*', async () => true);
    expect(await journal.isBlocked(origin)).toBe(false);
  });

  it('does not allow a scoped completion to bypass a pending delete-all', async () => {
    const journal = new KnowledgeDeletionJournal(dir);
    await journal.begin('*', approved);
    await expect(journal.complete(origin, async () => true)).rejects.toThrow();
    expect(await journal.isBlocked(origin)).toBe(true);
  });

  it('does not create a journal without an authorization check', async () => {
    const journal = new KnowledgeDeletionJournal(dir);
    await expect(journal.begin(origin, () => false)).rejects.toThrow();
    await expect(fs.access(path.join(dir, 'knowledge-delete-journal.json'))).rejects.toThrow();
  });

  it('fails closed on an unsupported journal version and leaves it intact', async () => {
    const file = path.join(dir, 'knowledge-delete-journal.json');
    const future = JSON.stringify({ schemaVersion: 99, all: false, origins: [] });
    await fs.writeFile(file, future, { mode: 0o600 });
    const journal = new KnowledgeDeletionJournal(dir);
    await expect(journal.isBlocked(origin)).rejects.toThrow();
    await expect(journal.begin(origin, approved)).rejects.toThrow();
    expect(await fs.readFile(file, 'utf8')).toBe(future);
  });

  it('reports an unknown outcome after rename durability failure and leaves the block recoverable', async () => {
    const journal = new KnowledgeDeletionJournal(dir, { syncDirectory: async () => { throw new Error('synthetic fsync failure'); } });
    await expect(journal.begin(origin, approved)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    expect(await new KnowledgeDeletionJournal(dir).isBlocked(origin)).toBe(true);
  });

  it('refuses a symlinked journal without touching its target', async () => {
    const outside = path.join(dir, 'outside');
    await fs.writeFile(outside, 'fixture', { mode: 0o600 });
    await fs.symlink(outside, path.join(dir, 'knowledge-delete-journal.json'));
    const journal = new KnowledgeDeletionJournal(dir);
    await expect(journal.begin(origin, approved)).rejects.toThrow();
    expect(await fs.readFile(outside, 'utf8')).toBe('fixture');
  });
});
