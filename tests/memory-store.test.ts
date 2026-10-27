import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ALLOWLIST } from '../mcp-server/src/memory/allowlist.js';
import {
  JsonMemoryStore,
  MAX_FACTS,
  MAX_PROFILES,
  MAX_SITE_BYTES,
  MemoryStoreError,
  siteFileName,
  type SiteFact,
  type SiteRecord,
} from '../mcp-server/src/memory/store.js';

const T1 = '2026-10-27T10:00:00.000Z';
const T2 = '2026-10-27T11:00:00.000Z';
const ORIGIN = 'https://example.com';
const OTHER = 'https://example.org';
const posix = process.platform !== 'win32';

let root: string;
let memoryDir: string;
let sitesDir: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-store-'));
  memoryDir = path.join(root, 'memory');
  sitesDir = path.join(memoryDir, 'sites');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function sha(origin: string): string {
  return crypto.createHash('sha256').update(origin).digest('hex');
}

function siteFile(origin: string): string {
  return path.join(sitesDir, `${sha(origin)}.json`);
}

function languageFact(at = T1): SiteFact {
  return { factId: 'site.language', kind: 'site.language', value: { lang: 'ar', dir: 'rtl' }, firstObserved: at, lastObserved: at, status: 'current' };
}

function controlFact(role: string, name: string, at = T1): SiteFact {
  return { factId: `ui.control:${role}:${name}`, kind: 'ui.control', value: { role, name }, firstObserved: at, lastObserved: at, status: 'current' } as SiteFact;
}

function record(origin = ORIGIN, over: Partial<SiteRecord> = {}): SiteRecord {
  return { schemaVersion: 1, origin, facts: [languageFact()], profiles: {}, commitSeq: 1, updatedAt: T1, ...over };
}

function manyControls(count: number): SiteFact[] {
  const names = [
    ...ALLOWLIST.phrases.account,
    ...ALLOWLIST.phrases.consent,
    ...ALLOWLIST.phrases.navigation,
    ...ALLOWLIST.phrases.commerce,
    ...ALLOWLIST.phrases.forms,
  ].map((name) => name.normalize('NFKC').toLowerCase());
  const facts: SiteFact[] = [];
  for (const role of ALLOWLIST.controlRoles) {
    for (const name of names) {
      if (facts.length < count) facts.push(controlFact(role, name));
    }
  }
  expect(facts.length).toBe(count);
  return facts;
}

function store(options: ConstructorParameters<typeof JsonMemoryStore>[1] = {}): JsonMemoryStore {
  return new JsonMemoryStore(memoryDir, options);
}

async function code(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(MemoryStoreError);
    return (error as MemoryStoreError).code;
  }
}

function errno(codeName: string): NodeJS.ErrnoException {
  return Object.assign(new Error(codeName), { code: codeName });
}

describe('file naming and basic round trip', () => {
  it('names a site file after sha256(origin) so a listing hides the origin', async () => {
    expect(siteFileName(ORIGIN)).toBe(`${sha(ORIGIN)}.json`);
    const s = store();
    await s.putSite(record());
    expect(fs.readdirSync(sitesDir)).toEqual([`${sha(ORIGIN)}.json`]);
    expect(fs.readFileSync(siteFile(ORIGIN), 'utf8')).toContain(ORIGIN);
    expect(fs.readdirSync(sitesDir).join('')).not.toContain('example');
  });

  it('treats a different port or scheme as a different origin', async () => {
    const s = store();
    await s.putSite(record('http://localhost:3000'));
    expect(await s.getSite('http://localhost:3001')).toBeNull();
    expect(await s.getSite('https://localhost:3000')).toBeNull();
    expect((await s.getSite('http://localhost:3000'))?.origin).toBe('http://localhost:3000');
  });

  it('returns null for an unknown origin without creating directories', async () => {
    expect(await store().getSite(ORIGIN)).toBeNull();
    expect(fs.existsSync(memoryDir)).toBe(false);
  });

  it('returns copies so a caller cannot change the cache', async () => {
    const s = store();
    await s.putSite(record());
    const first = await s.getSite(ORIGIN);
    first!.facts.length = 0;
    expect((await s.getSite(ORIGIN))!.facts).toHaveLength(1);
  });

  it('rejects a non-canonical or non-http origin', async () => {
    const s = store();
    expect(await code(s.getSite('ftp://example.com'))).toBe('INVALID_ARGUMENT');
    expect(await code(s.getSite('https://example.com/path'))).toBe('INVALID_ARGUMENT');
    expect(await code(s.putSite(record('https://example.com/path')))).toBe('INVALID_ARGUMENT');
  });
});

describe('atomic replace (AC-17, AC-18)', () => {
  it('has the temp file fully written before the rename, then no temp file remains', async () => {
    let seen: { temp: string; content: string } | null = null;
    const s = store({
      rename: async (from, to) => {
        seen = { temp: from, content: fs.readFileSync(from, 'utf8') };
        fs.renameSync(from, to);
      },
    });
    await s.putSite(record());
    expect(seen!.temp.endsWith('.tmp')).toBe(true);
    expect(JSON.parse(seen!.content).origin).toBe(ORIGIN);
    expect(fs.readFileSync(siteFile(ORIGIN), 'utf8')).toBe(seen!.content);
    expect(fs.readdirSync(sitesDir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('keeps the previous file and removes the temp file when the process dies before the rename', async () => {
    const first = store();
    await first.putSite(record(ORIGIN, { commitSeq: 1 }));
    const before = fs.readFileSync(siteFile(ORIGIN), 'utf8');

    const dying = store({
      rename: async () => {
        throw new Error('killed between temp write and rename');
      },
    });
    expect(await code(dying.putSite(record(ORIGIN, { commitSeq: 2, facts: [] })))).toBe('MEMORY_UNAVAILABLE');
    expect(fs.readFileSync(siteFile(ORIGIN), 'utf8')).toBe(before);
    expect(fs.readdirSync(sitesDir)).toEqual([`${sha(ORIGIN)}.json`]);
    // Nothing was committed, so a reader never sees the failed write (AC-18).
    expect((await dying.getSite(ORIGIN))!.commitSeq).toBe(1);
  });

  it('removes stray temp files left by a real kill when the store starts', async () => {
    const first = store();
    await first.putSite(record());
    const strayA = path.join(sitesDir, `${sha(ORIGIN)}.json.4242.deadbeef.tmp`);
    const strayB = path.join(sitesDir, `${sha(OTHER)}.json.4242.cafebabe.tmp`);
    const strayPolicy = path.join(memoryDir, 'policy.json.4242.feedface.tmp');
    fs.writeFileSync(strayA, '{"partial":');
    fs.writeFileSync(strayB, '');
    fs.writeFileSync(strayPolicy, '{"partial":');
    fs.writeFileSync(path.join(memoryDir, 'policy.json'), '{}');

    const restarted = store();
    expect((await restarted.getSite(ORIGIN))!.origin).toBe(ORIGIN);
    expect(fs.existsSync(strayA)).toBe(false);
    expect(fs.existsSync(strayB)).toBe(false);
    expect(fs.existsSync(strayPolicy)).toBe(false);
    expect(fs.existsSync(path.join(memoryDir, 'policy.json'))).toBe(true);
  });

  it('serializes concurrent writes of one origin: the last one wins and the file is never partial (AC-17)', async () => {
    const s = store();
    await Promise.all(Array.from({ length: 20 }, (_, i) => s.putSite(record(ORIGIN, { commitSeq: i + 1 }))));
    const parsed = JSON.parse(fs.readFileSync(siteFile(ORIGIN), 'utf8')) as SiteRecord;
    expect(parsed.commitSeq).toBe(20);
    expect(fs.readdirSync(sitesDir)).toEqual([`${sha(ORIGIN)}.json`]);
    expect((await store().getSite(ORIGIN))!.commitSeq).toBe(20);
  });

  it('keeps a committed observation after a restart and never reports a failed write as committed (AC-18)', async () => {
    const s = store();
    await s.putSite(record());
    const failing = store({
      rename: async () => {
        throw errno('EIO');
      },
    });
    await code(failing.putSite(record(ORIGIN, { commitSeq: 2 })));
    expect((await store().getSite(ORIGIN))!.commitSeq).toBe(1);
  });

  it('updates the cache only after the rename succeeds', async () => {
    const s = store({
      rename: async () => {
        throw errno('EIO');
      },
    });
    // Seed through a healthy store, then read through the failing one to fill its cache.
    await store().putSite(record(ORIGIN, { commitSeq: 1 }));
    expect((await s.getSite(ORIGIN))!.commitSeq).toBe(1);
    expect(await code(s.putSite(record(ORIGIN, { commitSeq: 2 })))).toBe('MEMORY_UNAVAILABLE');
    expect((await s.getSite(ORIGIN))!.commitSeq).toBe(1);
  });

  it('does not write a record whose signal is already aborted, and removes the temp file when it aborts mid-write', async () => {
    const s = store();
    await s.putSite(record(ORIGIN, { commitSeq: 1 }));
    const aborted = new AbortController();
    aborted.abort();
    expect(await code(s.putSite(record(ORIGIN, { commitSeq: 2 }), { signal: aborted.signal }))).toBe('MEMORY_UNAVAILABLE');

    const late = new AbortController();
    const slow = store({
      afterTempWrite: async () => {
        late.abort();
      },
    });
    expect(await code(slow.putSite(record(ORIGIN, { commitSeq: 3 }), { signal: late.signal }))).toBe('MEMORY_UNAVAILABLE');
    expect(fs.readdirSync(sitesDir)).toEqual([`${sha(ORIGIN)}.json`]);
    expect((await store().getSite(ORIGIN))!.commitSeq).toBe(1);
  });
});

describe('time never expires a fact (AC-23)', () => {
  it('returns a ten-year-old fact unchanged after a restart on a clock ten years later', async () => {
    await store().putSite(record(ORIGIN, { facts: [languageFact('2026-10-27T10:00:00.000Z')] }));
    const tenYears = Date.parse('2036-10-27T10:00:00.000Z');
    const later = store({ now: () => tenYears });
    const read = await later.getSite(ORIGIN);
    expect(read!.facts[0].firstObserved).toBe('2026-10-27T10:00:00.000Z');
    expect(read!.facts[0].lastObserved).toBe('2026-10-27T10:00:00.000Z');
    expect(read!.facts[0].status).toBe('current');
  });
});

describe('quarantine and schema versions', () => {
  it('quarantines a file whose origin does not hash to its name, reports it, and starts that origin empty', async () => {
    fs.mkdirSync(sitesDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(siteFile(ORIGIN), JSON.stringify(record(OTHER)), { mode: 0o600 });
    let now = 1_700_000_000_000;
    const s = store({ now: () => now });
    expect(await code(s.getSite(ORIGIN))).toBe('MEMORY_CORRUPT');
    const names = fs.readdirSync(sitesDir);
    expect(names).toHaveLength(1);
    expect(names[0]).toBe(`${sha(ORIGIN)}.json.corrupt-${now}`);
    expect(await s.getSite(ORIGIN)).toBeNull();
    const status = await s.status();
    expect(status.corrupt).toEqual([{ file: `${sha(ORIGIN)}.json`, quarantinedAs: names[0] }]);
    expect(status.origins).toBe(0);
  });

  it('gives MEMORY_CORRUPT for an unknown schemaVersion and quarantines the file instead of repairing it', async () => {
    fs.mkdirSync(sitesDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(siteFile(ORIGIN), JSON.stringify({ ...record(), schemaVersion: 2 }), { mode: 0o600 });
    const s = store();
    expect(await code(s.getSite(ORIGIN))).toBe('MEMORY_CORRUPT');
    expect(fs.existsSync(siteFile(ORIGIN))).toBe(false);
    expect(fs.readdirSync(sitesDir)[0]).toMatch(/\.json\.corrupt-\d+$/u);
  });

  it('quarantines invalid JSON, a wrong shape and an oversized file', async () => {
    fs.mkdirSync(sitesDir, { recursive: true, mode: 0o700 });
    const cases: Array<[string, string]> = [
      ['https://a.example', '{"truncated":'],
      ['https://b.example', JSON.stringify({ ...record('https://b.example'), facts: 'nope' })],
      ['https://c.example', JSON.stringify({ ...record('https://c.example'), commitSeq: 0 })],
      ['https://d.example', ' '.repeat(MAX_SITE_BYTES + 1024)],
    ];
    const s = store();
    for (const [origin, text] of cases) {
      fs.writeFileSync(siteFile(origin), text, { mode: 0o600 });
      expect(await code(s.getSite(origin))).toBe('MEMORY_CORRUPT');
      expect(await s.getSite(origin)).toBeNull();
    }
    expect((await s.status()).corrupt).toHaveLength(cases.length);
  });

  it('skips a quarantined file in listSites and keeps the healthy ones', async () => {
    const s = store();
    await s.putSite(record(ORIGIN));
    fs.writeFileSync(siteFile(OTHER), '{"truncated":', { mode: 0o600 });
    const sites = await s.listSites();
    expect(sites.map((site) => site.origin)).toEqual([ORIGIN]);
    expect((await s.status()).corrupt).toHaveLength(1);
  });
});

describe('capacity limits keep existing data (AC-17)', () => {
  it(`accepts ${MAX_FACTS} facts and rejects ${MAX_FACTS + 1} with MEMORY_FULL, keeping the old record`, async () => {
    const s = store();
    await s.putSite(record(ORIGIN, { facts: manyControls(MAX_FACTS) }));
    const before = fs.readFileSync(siteFile(ORIGIN), 'utf8');
    expect(await code(s.putSite(record(ORIGIN, { commitSeq: 2, facts: manyControls(MAX_FACTS + 1) })))).toBe('MEMORY_FULL');
    expect(fs.readFileSync(siteFile(ORIGIN), 'utf8')).toBe(before);
    expect((await s.getSite(ORIGIN))!.facts).toHaveLength(MAX_FACTS);
  });

  it(`accepts ${MAX_PROFILES} profiles and rejects ${MAX_PROFILES + 1} with MEMORY_FULL`, async () => {
    const profiles = (count: number): SiteRecord['profiles'] =>
      Object.fromEntries(Array.from({ length: count }, (_, i) => [`profile-${i}`, { visit: { firstAt: T1, lastAt: T1, count: 1 } }]));
    const s = store();
    await s.putSite(record(ORIGIN, { profiles: profiles(MAX_PROFILES) }));
    expect(await code(s.putSite(record(ORIGIN, { commitSeq: 2, profiles: profiles(MAX_PROFILES + 1) })))).toBe('MEMORY_FULL');
    expect(Object.keys((await s.getSite(ORIGIN))!.profiles)).toHaveLength(MAX_PROFILES);
  });

  it('rejects a record over 64 KiB with MEMORY_FULL and keeps the previous file', async () => {
    const verifications = (profile: number): Record<string, { at: string; tool: 'browser_snapshot' }> =>
      Object.fromEntries(
        Array.from({ length: 64 }, (_, i) => [
          `ui.control:link:v${profile}-${i}`,
          { at: T1, tool: 'browser_snapshot' as const },
        ]),
      );
    const profiles = Object.fromEntries(Array.from({ length: MAX_PROFILES }, (_, i) => [`profile-${i}`, { verifications: verifications(i) }]));
    const s = store();
    await s.putSite(record(ORIGIN));
    const before = fs.readFileSync(siteFile(ORIGIN), 'utf8');
    expect(await code(s.putSite(record(ORIGIN, { commitSeq: 2, profiles })))).toBe('MEMORY_FULL');
    expect(fs.readFileSync(siteFile(ORIGIN), 'utf8')).toBe(before);
  });

  it('rejects a new origin over the origin cap but still updates an existing one', async () => {
    const s = store({ limits: { maxOrigins: 2 } });
    await s.putSite(record('https://a.example'));
    await s.putSite(record('https://b.example'));
    expect(await code(s.putSite(record('https://c.example')))).toBe('MEMORY_FULL');
    expect(await s.getSite('https://c.example')).toBeNull();
    await s.putSite(record('https://a.example', { commitSeq: 2 }));
    expect((await s.getSite('https://a.example'))!.commitSeq).toBe(2);
  });

  it('rejects a write that would push the total size over the cap, counting a replaced file once', async () => {
    const one = Buffer.byteLength(`${JSON.stringify(record('https://a.example'))}\n`);
    const s = store({ limits: { maxTotalBytes: one * 2 + 40 } });
    await s.putSite(record('https://a.example'));
    await s.putSite(record('https://b.example'));
    expect(await code(s.putSite(record('https://c.example')))).toBe('MEMORY_FULL');
    await s.putSite(record('https://a.example', { commitSeq: 2 }));
    expect((await s.status()).origins).toBe(2);
  });

  it('counts existing files when a new store starts (limits survive a restart)', async () => {
    await store().putSite(record('https://a.example'));
    await store().putSite(record('https://b.example'));
    const restarted = store({ limits: { maxOrigins: 2 } });
    expect(await code(restarted.putSite(record('https://c.example')))).toBe('MEMORY_FULL');
  });

  it('maps ENOSPC and EDQUOT to MEMORY_FULL, keeps the old file and leaves no temp file', async () => {
    await store().putSite(record());
    const before = fs.readFileSync(siteFile(ORIGIN), 'utf8');
    for (const name of ['ENOSPC', 'EDQUOT']) {
      const full = store({
        afterTempWrite: async () => {
          throw errno(name);
        },
      });
      expect(await code(full.putSite(record(ORIGIN, { commitSeq: 2 })))).toBe('MEMORY_FULL');
      expect(fs.readFileSync(siteFile(ORIGIN), 'utf8')).toBe(before);
      expect(fs.readdirSync(sitesDir)).toEqual([`${sha(ORIGIN)}.json`]);
    }
    const noSpaceOnRename = store({
      rename: async () => {
        throw errno('ENOSPC');
      },
    });
    expect(await code(noSpaceOnRename.putSite(record(ORIGIN, { commitSeq: 2 })))).toBe('MEMORY_FULL');
  });
});

describe('write-time validation', () => {
  it('rejects a fact string that is not an exact allowlist entry', async () => {
    const s = store();
    const bad: SiteFact[] = [
      controlFact('button', 'enter password hunter2'),
      controlFact('button', 'Sign In'),
      controlFact('heading', 'sign in'),
      { ...languageFact(), value: { lang: 'arabic', dir: 'rtl' } },
      { factId: 'ui.login', kind: 'ui.login', value: { path: '/users/42/secret' }, firstObserved: T1, lastObserved: T1, status: 'current' },
      { ...languageFact(), factId: 'ui.search' },
    ];
    for (const fact of bad) {
      expect(await code(s.putSite(record(ORIGIN, { facts: [fact] })))).toBe('INVALID_ARGUMENT');
    }
    expect(fs.existsSync(memoryDir)).toBe(false);
  });

  it('accepts every fact kind and a null login path', async () => {
    const s = store();
    await s.putSite(
      record(ORIGIN, {
        facts: [
          languageFact(),
          { factId: 'ui.search', kind: 'ui.search', value: { role: 'searchbox', name: 'search' }, firstObserved: T1, lastObserved: T2, status: 'current' },
          { factId: 'ui.login', kind: 'ui.login', value: { path: null }, firstObserved: T1, lastObserved: T1, status: 'current' },
          controlFact('button', 'accept all'),
        ],
      }),
    );
    expect((await s.getSite(ORIGIN))!.facts).toHaveLength(4);
  });

  it('rejects duplicate fact ids, bad times and unsafe profile keys', async () => {
    const s = store();
    expect(await code(s.putSite(record(ORIGIN, { facts: [languageFact(), languageFact()] })))).toBe('INVALID_ARGUMENT');
    expect(await code(s.putSite(record(ORIGIN, { updatedAt: 'yesterday' })))).toBe('INVALID_ARGUMENT');
    expect(await code(s.putSite(record(ORIGIN, { commitSeq: 0 })))).toBe('INVALID_ARGUMENT');
    expect(await code(s.putSite(record(ORIGIN, { profiles: JSON.parse('{"__proto__":{}}') })))).toBe('INVALID_ARGUMENT');
  });
});

describe('deletion', () => {
  it('removes one origin file, its quarantined copies and its cache entry, and lists nothing afterwards', async () => {
    const s = store();
    await s.putSite(record(ORIGIN));
    await s.putSite(record(OTHER));
    fs.writeFileSync(path.join(sitesDir, `${sha(ORIGIN)}.json.corrupt-1700000000000`), 'old');
    expect(await s.deleteSite(ORIGIN)).toBe(true);
    expect(await s.getSite(ORIGIN)).toBeNull();
    expect(fs.readdirSync(sitesDir)).toEqual([`${sha(OTHER)}.json`]);
    expect(await s.deleteSite(ORIGIN)).toBe(false);
    expect(await store().getSite(ORIGIN)).toBeNull();
  });

  it('removes everything with deleteAll and frees the capacity counters', async () => {
    const s = store({ limits: { maxOrigins: 2 } });
    await s.putSite(record('https://a.example'));
    await s.putSite(record('https://b.example'));
    expect(await s.deleteAll()).toBe(2);
    expect(await s.listSites()).toEqual([]);
    await s.putSite(record('https://c.example'));
    expect((await s.status()).origins).toBe(1);
  });
});

describe('Windows rename retry', () => {
  it('retries rename 3 times on EPERM, EBUSY and EACCES with a 50 ms back-off, then succeeds', async () => {
    for (const name of ['EPERM', 'EBUSY', 'EACCES']) {
      fs.rmSync(memoryDir, { recursive: true, force: true });
      const sleeps: number[] = [];
      let calls = 0;
      const s = store({
        platform: 'win32',
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        rename: async (from, to) => {
          calls += 1;
          if (calls <= 3) throw errno(name);
          fs.renameSync(from, to);
        },
      });
      await s.putSite(record());
      expect(calls).toBe(4);
      expect(sleeps).toEqual([50, 50, 50]);
      expect((await s.getSite(ORIGIN))!.origin).toBe(ORIGIN);
    }
  });

  it('gives up after 3 retries with MEMORY_UNAVAILABLE and cleans the temp file', async () => {
    let calls = 0;
    const s = store({
      platform: 'win32',
      sleep: async () => undefined,
      rename: async () => {
        calls += 1;
        throw errno('EPERM');
      },
    });
    expect(await code(s.putSite(record()))).toBe('MEMORY_UNAVAILABLE');
    expect(calls).toBe(4);
    expect(fs.readdirSync(sitesDir)).toEqual([]);
  });

  it('does not retry other errors, and does not retry at all off Windows', async () => {
    let calls = 0;
    const other = store({
      platform: 'win32',
      sleep: async () => undefined,
      rename: async () => {
        calls += 1;
        throw errno('EIO');
      },
    });
    await code(other.putSite(record()));
    expect(calls).toBe(1);

    calls = 0;
    const posixStore = store({
      platform: 'linux',
      rename: async () => {
        calls += 1;
        throw errno('EPERM');
      },
    });
    await code(posixStore.putSite(record()));
    expect(calls).toBe(1);
  });

  it('skips the POSIX mode-bit check on win32 but enforces it elsewhere', async () => {
    fs.mkdirSync(sitesDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(siteFile(ORIGIN), `${JSON.stringify(record())}\n`, { mode: 0o644 });
    if (posix) fs.chmodSync(siteFile(ORIGIN), 0o644);
    expect((await store({ platform: 'win32' }).getSite(ORIGIN))!.origin).toBe(ORIGIN);
    if (posix) {
      expect(await code(store({ platform: 'linux' }).getSite(ORIGIN))).toBe('MEMORY_UNAVAILABLE');
      expect(fs.existsSync(siteFile(ORIGIN))).toBe(true);
    }
  });
});

describe.skipIf(!posix)('POSIX permissions', () => {
  it('creates files 0o600 inside 0o700 directories', async () => {
    await store().putSite(record());
    expect(fs.statSync(memoryDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(sitesDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(siteFile(ORIGIN)).mode & 0o777).toBe(0o600);
  });

  it('refuses a symlinked site file and a group-readable sites directory', async () => {
    fs.mkdirSync(sitesDir, { recursive: true, mode: 0o700 });
    const target = path.join(root, 'elsewhere.json');
    fs.writeFileSync(target, JSON.stringify(record()), { mode: 0o600 });
    fs.symlinkSync(target, siteFile(ORIGIN));
    expect(await code(store().getSite(ORIGIN))).toBe('MEMORY_UNAVAILABLE');

    fs.rmSync(siteFile(ORIGIN));
    fs.chmodSync(sitesDir, 0o750);
    expect(await code(store().getSite(ORIGIN))).toBe('MEMORY_UNAVAILABLE');
  });
});

describe('reconciliation across agents and restarts (AC-23, AC-24)', () => {
  it('keeps the original provenance after ten clock years and a restart, and refreshes nothing by itself (AC-23)', async () => {
    await store().putSite(record(ORIGIN, {
      facts: [languageFact('2026-10-27T10:00:00.000Z')],
      profiles: { 'profile-a': { visit: { firstAt: T1, lastAt: T1, count: 1 }, verifications: { 'site.language': { at: T1, tool: 'browser_navigate' } } } },
    }));
    const raw = fs.readFileSync(siteFile(ORIGIN), 'utf8');
    const later = store({ now: () => Date.parse('2036-10-27T10:00:00.000Z') });
    const read = (await later.getSite(ORIGIN))!;
    expect(read.facts[0]).toMatchObject({ status: 'current', firstObserved: T1, lastObserved: T1 });
    expect(read.profiles['profile-a'].verifications!['site.language'].at).toBe(T1);
    expect(fs.readFileSync(siteFile(ORIGIN), 'utf8')).toBe(raw);
  });

  it("makes another agent's changed observation current with its own provenance and returns no old value (AC-24)", async () => {
    const s = store();
    const { applyOp } = await import('../mcp-server/src/memory/queue.js');
    const { languageFact: candidate } = await import('../mcp-server/src/memory/allowlist.js');
    const op = (profileId: string, at: string, lang: string, dir: string) => ({
      opId: `${profileId}-${at}`,
      type: 'facts' as const,
      profileId,
      origin: ORIGIN,
      at,
      enqueuedAt: at,
      facts: [candidate(lang, dir)!],
      path: '/',
      tool: 'browser_snapshot' as const,
    });
    let site = applyOp(null, op('profile-a', T1, 'ar', 'rtl'), T1);
    await s.putSite(site);
    site = applyOp((await store().getSite(ORIGIN))!, op('profile-b', T2, 'en', 'ltr'), T2);
    await s.putSite(site);
    const read = (await store({ now: () => Date.parse('2036-01-01T00:00:00.000Z') }).getSite(ORIGIN))!;
    const languages = read.facts.filter((fact) => fact.kind === 'site.language');
    expect(languages).toHaveLength(1);
    expect(languages[0]).toMatchObject({ value: { lang: 'en', dir: 'ltr' }, firstObserved: T2, lastObserved: T2, status: 'current' });
    expect(fs.readFileSync(siteFile(ORIGIN), 'utf8')).not.toContain('"ar"');
    expect(read.profiles['profile-b'].verifications!['site.language'].at).toBe(T2);
    expect(read.profiles['profile-a'].verifications!['site.language']).toBeDefined();
  });
});
