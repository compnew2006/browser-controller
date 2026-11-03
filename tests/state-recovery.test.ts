import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { JsonMemoryStore, type SiteRecord } from '../mcp-server/src/memory/store.js';
import { JsonMapStore } from '../mcp-server/src/memory/map-store.js';
import { emptyMapRecord } from '../mcp-server/src/memory/map-record.js';
import { CredentialVaultStore } from '../mcp-server/src/vault/store.js';
import {
  connectFakeExtension, connectIpcClient, startIsolatedDaemon, stopIsolatedDaemon,
  type DaemonHandle, type FakeExtension, type IpcClient,
} from './helpers/memory-fixtures.js';

it('recovers an offline state copy in an isolated daemon without changing its source', { timeout: 30_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-recovery-test-'));
  const source = path.join(root, 'source');
  const restored = path.join(root, 'restored');
  const origin = 'https://recovery.example.test';
  const browserId = 'recovery-fixture';
  const entryId = 'cred_0123456789abcdef0123456789abcdef';
  const timestamp = '2026-01-01T00:00:00.000Z';
  const record: SiteRecord = {
    schemaVersion: 1, origin, profiles: {}, commitSeq: 1, updatedAt: timestamp,
    facts: [{ factId: 'site.language', kind: 'site.language', value: { lang: 'ar', dir: 'rtl' }, firstObserved: timestamp, lastObserved: timestamp, status: 'current' }],
  };
  let daemon: DaemonHandle | undefined;
  let extension: FakeExtension | undefined;
  let client: IpcClient | undefined;
  fs.mkdirSync(source, { mode: 0o700 });
  try {
    daemon = await startIsolatedDaemon(source);
    await stopIsolatedDaemon(daemon);
    daemon = undefined;

    await new JsonMemoryStore(path.join(source, 'memory')).putSite(record);
    const map = emptyMapRecord(browserId, origin, timestamp);
    await new JsonMapStore(path.join(source, 'memory')).putMap(map);
    const vault = new CredentialVaultStore({ stateDir: source, browserId });
    await vault.initialize();
    await vault.upsert({ id: entryId, kind: 'login', label: 'Fixture', identifier: 'fixture', password: 'synthetic-recovery-only', origin, createdAt: 1, updatedAt: 1 });
    vault.lock();

    // The runbook excludes transient process state and copies only while stopped.
    const transient = new Set(['daemon.sock', 'daemon.lock', 'daemon.json', 'daemon.log']);
    fs.cpSync(source, restored, { recursive: true, filter: (item) => item === source || !transient.has(path.relative(source, item)) });
    for (const name of transient) expect(fs.existsSync(path.join(restored, name))).toBe(false);

    daemon = await startIsolatedDaemon(restored);
    const sourceToken = JSON.parse(fs.readFileSync(path.join(source, 'token.json'), 'utf8')).token;
    expect(daemon.token).toBe(sourceToken);
    extension = await connectFakeExtension(daemon, browserId);
    client = await connectIpcClient(daemon.sockPath, daemon.token, 'recovery-fixture');
    const reply = await client.call('browser_navigate', { url: origin });
    expect(reply.success).toBe(true);
    expect(reply.result.from).toBe(browserId);
    client.close();
    client = undefined;
    extension.close();
    extension = undefined;
    await stopIsolatedDaemon(daemon);
    daemon = undefined;

    const recoveredMemory = new JsonMemoryStore(path.join(restored, 'memory'));
    expect(await recoveredMemory.getSite(origin)).toEqual(record);
    const recoveredMap = new JsonMapStore(path.join(restored, 'memory'));
    expect(await recoveredMap.getMap(browserId, origin)).toEqual(map);
    const recoveredVault = new CredentialVaultStore({ stateDir: restored, browserId });
    await recoveredVault.unlock();
    expect((await recoveredVault.get(entryId))?.password).toBe('synthetic-recovery-only');
    recoveredVault.lock();

    await recoveredMemory.deleteSite(origin);
    await recoveredMap.deleteMap(browserId, origin);
    expect(await new JsonMemoryStore(path.join(source, 'memory')).getSite(origin)).toEqual(record);
    expect(await new JsonMapStore(path.join(source, 'memory')).getMap(browserId, origin)).toEqual(map);
    const sourceVault = new CredentialVaultStore({ stateDir: source, browserId });
    await sourceVault.unlock();
    expect((await sourceVault.get(entryId))?.password).toBe('synthetic-recovery-only');
    sourceVault.lock();
  } finally {
    client?.close();
    extension?.close();
    if (daemon) await stopIsolatedDaemon(daemon);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
