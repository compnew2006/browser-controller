import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonKnowledgeStore } from '../mcp-server/src/memory/knowledge-store.js';
import { KnowledgeDeletionJournal } from '../mcp-server/src/memory/knowledge-deletion-journal.js';
import type { KnowledgeFile } from '../mcp-server/src/memory/knowledge-record.js';

let dir: string;
const origin = 'https://example.invalid';
const other = 'https://other.invalid';
const approved = { validateCommit: () => true, finalizeCommit: () => {} };
const record = (browserId: string, site: string): KnowledgeFile => ({
  schemaVersion: 1, browserId, origin: site, revision: 1, updatedAt: '2026-11-05T00:00:00.000Z', entries: [],
});
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-delete-store-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe('knowledge cleanup under a durable deletion block', () => {
  it('rejects deletion without a durable block', async () => {
    const store = new JsonKnowledgeStore(dir);
    await store.put(record('profile-a', origin), 0, approved);
    await expect(store.deleteOrigin(origin)).rejects.toThrow();
    expect(await store.get('profile-a', origin)).not.toBeNull();
  });

  it('cleans the site across profiles without touching other sites or older stores', async () => {
    const store = new JsonKnowledgeStore(dir);
    await store.put(record('profile-a', origin), 0, approved);
    await store.put(record('profile-b', origin), 0, approved);
    await store.put(record('profile-a', other), 0, approved);
    await fs.mkdir(path.join(dir, 'sites'));
    await fs.writeFile(path.join(dir, 'sites', 'legacy'), 'fixture');
    const journal = new KnowledgeDeletionJournal(dir);
    await journal.begin(origin, () => true);
    expect(await store.deleteOrigin(origin)).toBe(2);
    await expect(store.get('profile-a', origin)).rejects.toThrow();
    await expect(store.get('profile-b', origin)).rejects.toThrow();
    expect(await store.get('profile-a', other)).not.toBeNull();
    expect(await fs.readFile(path.join(dir, 'sites', 'legacy'), 'utf8')).toBe('fixture');
    expect(await journal.isBlocked(origin)).toBe(true);
    await journal.complete(origin, async () => true);
    expect(await store.get('profile-a', origin)).toBeNull();
    expect(await store.get('profile-b', origin)).toBeNull();
  });

  it('rejects a direct write to an origin blocked by pending recovery', async () => {
    const store = new JsonKnowledgeStore(dir);
    const journal = new KnowledgeDeletionJournal(dir);
    await journal.begin(origin, () => true);
    await expect(store.put(record('profile-a', origin), 0, approved)).rejects.toThrow();
    await expect(store.get('profile-a', origin)).rejects.toThrow();
  });

  it('keeps a durable block after a partial failure and supports retry after restart', async () => {
    const store = new JsonKnowledgeStore(dir);
    await store.put(record('profile-a', origin), 0, approved);
    await store.put(record('profile-b', origin), 0, approved);
    const journal = new KnowledgeDeletionJournal(dir);
    await journal.begin(origin, () => true);
    let calls = 0;
    const failing = new JsonKnowledgeStore(dir, { unlink: async (file) => {
      if (++calls === 2) throw new Error('synthetic unlink failure');
      await fs.unlink(file);
    } });
    await expect(failing.deleteOrigin(origin)).rejects.toThrow();
    expect(await new KnowledgeDeletionJournal(dir).isBlocked(origin)).toBe(true);
    expect(await new JsonKnowledgeStore(dir).deleteOrigin(origin)).toBe(1);
    expect(await journal.isBlocked(origin)).toBe(true);
  });

  it('requires a delete-all block before cleaning every knowledge file', async () => {
    const store = new JsonKnowledgeStore(dir);
    await store.put(record('profile-a', origin), 0, approved);
    const journal = new KnowledgeDeletionJournal(dir);
    await journal.begin(origin, () => true);
    await expect(store.deleteAll()).rejects.toThrow();
    await journal.begin('*', () => true);
    expect(await store.deleteAll()).toBe(1);
    expect(await journal.isBlocked(origin)).toBe(true);
  });

  it('removes recoverable temporary copies for the requested site', async () => {
    const store = new JsonKnowledgeStore(dir);
    await store.put(record('profile-a', origin), 0, approved);
    const directory = path.join(dir, 'knowledge');
    const [name] = await fs.readdir(directory);
    await fs.copyFile(path.join(directory, name!), path.join(directory, `${name}.123.deadbeef.tmp`));
    await new KnowledgeDeletionJournal(dir).begin(origin, () => true);
    expect(await store.deleteOrigin(origin)).toBe(2);
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it('fails closed when a temporary file cannot be attributed to a site', async () => {
    const store = new JsonKnowledgeStore(dir);
    await store.put(record('profile-a', origin), 0, approved);
    const directory = path.join(dir, 'knowledge');
    const [name] = await fs.readdir(directory);
    const temp = path.join(directory, `${name}.123.deadbeef.tmp`);
    await fs.writeFile(temp, '{', { mode: 0o600 });
    const journal = new KnowledgeDeletionJournal(dir);
    await journal.begin(origin, () => true);
    await expect(store.deleteOrigin(origin)).rejects.toThrow();
    expect(await fs.readFile(temp, 'utf8')).toBe('{');
    expect(await journal.isBlocked(origin)).toBe(true);
  });
});
