import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_EXCLUDED_ORIGINS,
  MemoryPolicyError,
  canonicalOrigin,
  defaultPolicy,
  disablePolicy,
  enablePolicy,
  excludeOrigin,
  includeOrigin,
  policyPath,
  pruneDeletions,
  readPolicy,
  recordDeletion,
  writePolicy,
  type MemoryPolicy,
} from '../mcp-server/src/memory/policy.js';

const T1 = '2026-10-27T10:00:00.000Z';
const T2 = '2026-10-27T11:00:00.000Z';
const T3 = '2026-10-27T12:00:00.000Z';
const posix = process.platform !== 'win32';

let root: string;
let dir: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-policy-'));
  dir = path.join(root, 'memory');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function putRaw(content: unknown): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(policyPath(dir), typeof content === 'string' ? content : JSON.stringify(content));
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof MemoryPolicyError ? error.code : `other:${String(error)}`;
  }
  return undefined;
}

async function asyncCodeOf(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
  } catch (error) {
    return error instanceof MemoryPolicyError ? error.code : `other:${String(error)}`;
  }
  return undefined;
}

describe('canonicalOrigin', () => {
  it('returns URL.origin for http and https', () => {
    expect(canonicalOrigin('https://Example.com')).toBe('https://example.com');
    expect(canonicalOrigin('https://example.com:443/a/b?q=1#f')).toBe('https://example.com');
    expect(canonicalOrigin('http://localhost:3000/x')).toBe('http://localhost:3000');
    expect(canonicalOrigin('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
  });

  it('treats a different port as a different origin', () => {
    expect(canonicalOrigin('http://127.0.0.1:8080')).not.toBe(canonicalOrigin('http://127.0.0.1:8081'));
  });

  it('drops userinfo', () => {
    expect(canonicalOrigin('https://user:secret@example.com/x')).toBe('https://example.com');
  });

  it('returns null for other schemes and junk', () => {
    for (const bad of ['ftp://example.com', 'file:///etc/passwd', 'javascript:alert(1)', 'about:blank', 'example.com', '', 'not a url']) {
      expect(canonicalOrigin(bad)).toBeNull();
    }
    expect(canonicalOrigin(undefined as unknown as string)).toBeNull();
  });
});

describe('readPolicy', () => {
  it('missing file → disabled defaults', () => {
    const policy = readPolicy(dir);
    expect(policy).toEqual(defaultPolicy());
    expect(policy.enabled).toBe(false);
    expect(policy.enabledAt).toBeNull();
    expect(policy.excluded).toEqual([]);
    expect(policy.deletions).toEqual({});
  });

  it('reading never creates the file or directory', () => {
    readPolicy(dir);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('missing fields → defaults, enabled false', () => {
    putRaw({ schemaVersion: 1 });
    const policy = readPolicy(dir);
    expect(policy.enabled).toBe(false);
    expect(policy.enabledAt).toBeNull();
    expect(policy.excluded).toEqual([]);
    expect(policy.deletions).toEqual({});
  });

  it('reads a full policy', () => {
    putRaw({
      schemaVersion: 1,
      enabled: true,
      enabledAt: T1,
      excluded: ['https://bank.example'],
      deletions: { '*': T2, 'https://a.example': T3 },
      updatedAt: T3,
    });
    expect(readPolicy(dir)).toEqual({
      schemaVersion: 1,
      enabled: true,
      enabledAt: T1,
      excluded: ['https://bank.example'],
      deletions: { '*': T2, 'https://a.example': T3 },
      updatedAt: T3,
    });
  });

  it('unknown or missing schemaVersion → MEMORY_CORRUPT', () => {
    putRaw({ schemaVersion: 2, enabled: true });
    expect(codeOf(() => readPolicy(dir))).toBe('MEMORY_CORRUPT');
    putRaw({ enabled: true });
    expect(codeOf(() => readPolicy(dir))).toBe('MEMORY_CORRUPT');
    putRaw({ schemaVersion: '1' });
    expect(codeOf(() => readPolicy(dir))).toBe('MEMORY_CORRUPT');
  });

  it('malformed JSON, arrays and empty files → MEMORY_CORRUPT', () => {
    for (const raw of ['{not json', '[]', 'null', '"x"', '']) {
      putRaw(raw);
      expect(codeOf(() => readPolicy(dir))).toBe('MEMORY_CORRUPT');
    }
  });

  it('wrongly typed fields fail closed instead of enabling memory', () => {
    for (const bad of [
      { schemaVersion: 1, enabled: 'true' },
      { schemaVersion: 1, enabled: 1 },
      { schemaVersion: 1, enabledAt: 5 },
      { schemaVersion: 1, enabledAt: 'yesterday' },
      { schemaVersion: 1, updatedAt: 'not a time' },
      { schemaVersion: 1, excluded: 'https://a.example' },
      { schemaVersion: 1, excluded: [5] },
      { schemaVersion: 1, deletions: [] },
      { schemaVersion: 1, deletions: { 'https://a.example': 'soon' } },
    ]) {
      putRaw(bad);
      expect(codeOf(() => readPolicy(dir)), JSON.stringify(bad)).toBe('MEMORY_CORRUPT');
    }
  });

  it('excluded entries must be canonical origins and unique', () => {
    for (const excluded of [
      ['https://Example.com'],
      ['https://example.com/'],
      ['https://example.com/path'],
      ['ftp://example.com'],
      ['https://a.example', 'https://a.example'],
    ]) {
      putRaw({ schemaVersion: 1, excluded });
      expect(codeOf(() => readPolicy(dir)), JSON.stringify(excluded)).toBe('MEMORY_CORRUPT');
    }
  });

  it('deletion keys must be "*" or canonical origins', () => {
    putRaw({ schemaVersion: 1, deletions: { 'https://Example.com': T1 } });
    expect(codeOf(() => readPolicy(dir))).toBe('MEMORY_CORRUPT');
    putRaw({ schemaVersion: 1, deletions: { all: T1 } });
    expect(codeOf(() => readPolicy(dir))).toBe('MEMORY_CORRUPT');
  });

  it('accepts exactly 5,000 excluded origins and rejects 5,001', () => {
    const make = (n: number) => Array.from({ length: n }, (_, i) => `https://site${i}.example`);
    putRaw({ schemaVersion: 1, excluded: make(MAX_EXCLUDED_ORIGINS) });
    expect(readPolicy(dir).excluded).toHaveLength(5000);
    putRaw({ schemaVersion: 1, excluded: make(MAX_EXCLUDED_ORIGINS + 1) });
    expect(codeOf(() => readPolicy(dir))).toBe('MEMORY_CORRUPT');
  });

  it('a directory in place of the file is MEMORY_UNAVAILABLE, not a silent default', () => {
    fs.mkdirSync(policyPath(dir), { recursive: true });
    expect(codeOf(() => readPolicy(dir))).toBe('MEMORY_UNAVAILABLE');
  });
});

describe('transitions', () => {
  it('enable sets enabledAt and updatedAt; re-enable keeps the original enabledAt', () => {
    const on = enablePolicy(defaultPolicy(), T1);
    expect(on.enabled).toBe(true);
    expect(on.enabledAt).toBe(T1);
    expect(on.updatedAt).toBe(T1);
    const again = enablePolicy(on, T2);
    expect(again.enabledAt).toBe(T1);
    expect(again.updatedAt).toBe(T2);
  });

  it('disable clears enabledAt; a later enable starts a new window', () => {
    const off = disablePolicy(enablePolicy(defaultPolicy(), T1), T2);
    expect(off.enabled).toBe(false);
    expect(off.enabledAt).toBeNull();
    expect(off.updatedAt).toBe(T2);
    expect(enablePolicy(off, T3).enabledAt).toBe(T3);
  });

  it('keeps exclusions and tombstones across enable and disable', () => {
    let policy = excludeOrigin(defaultPolicy(), 'https://a.example', T1);
    policy = recordDeletion(policy, '*', T1);
    const cycled = enablePolicy(disablePolicy(enablePolicy(policy, T2), T3), T3);
    expect(cycled.excluded).toEqual(['https://a.example']);
    expect(cycled.deletions).toEqual({ '*': T1 });
  });

  it('exclude canonicalizes, is idempotent, and include removes', () => {
    const one = excludeOrigin(defaultPolicy(), 'https://Example.com/some/path?q=1', T1);
    expect(one.excluded).toEqual(['https://example.com']);
    const twice = excludeOrigin(one, 'https://example.com', T2);
    expect(twice.excluded).toEqual(['https://example.com']);
    expect(includeOrigin(twice, 'https://example.com/other', T3).excluded).toEqual([]);
    expect(includeOrigin(defaultPolicy(), 'https://never.example', T3).excluded).toEqual([]);
  });

  it('exclude and include reject a non-http(s) or unparsable origin', () => {
    expect(codeOf(() => excludeOrigin(defaultPolicy(), 'ftp://a.example', T1))).toBe('INVALID_ARGUMENT');
    expect(codeOf(() => excludeOrigin(defaultPolicy(), '*', T1))).toBe('INVALID_ARGUMENT');
    expect(codeOf(() => includeOrigin(defaultPolicy(), 'nope', T1))).toBe('INVALID_ARGUMENT');
  });

  it('exclude refuses entry 5,001 with MEMORY_FULL and keeps the list', () => {
    const full: MemoryPolicy = {
      ...defaultPolicy(),
      excluded: Array.from({ length: MAX_EXCLUDED_ORIGINS }, (_, i) => `https://site${i}.example`),
    };
    expect(codeOf(() => excludeOrigin(full, 'https://extra.example', T1))).toBe('MEMORY_FULL');
    expect(excludeOrigin(full, 'https://site7.example', T1).excluded).toHaveLength(MAX_EXCLUDED_ORIGINS);
  });

  it('recordDeletion stores per-origin and "*" tombstones, newest time wins', () => {
    let policy = recordDeletion(defaultPolicy(), 'https://a.example/x', T1);
    policy = recordDeletion(policy, '*', T2);
    expect(policy.deletions).toEqual({ 'https://a.example': T1, '*': T2 });
    policy = recordDeletion(policy, 'https://a.example', T3);
    expect(policy.deletions['https://a.example']).toBe(T3);
    expect(codeOf(() => recordDeletion(defaultPolicy(), 'garbage', T1))).toBe('INVALID_ARGUMENT');
  });

  it('pruneDeletions removes tombstones older than the drained time', () => {
    let policy = recordDeletion(defaultPolicy(), 'https://a.example', T1);
    policy = recordDeletion(policy, 'https://b.example', T2);
    policy = recordDeletion(policy, '*', T3);
    const pruned = pruneDeletions(policy, '2026-10-27T11:30:00.000Z', T3);
    expect(pruned.deletions).toEqual({ '*': T3 });
    expect(pruned.updatedAt).toBe(T3);
    expect(pruneDeletions(policy, '2000-01-01T00:00:00.000Z', T3)).toBe(policy);
  });

  it('pruneDeletions keeps a tombstone from the drain\'s own millisecond, which still covers work enqueued then', () => {
    let policy = recordDeletion(defaultPolicy(), 'https://a.example', T1);
    policy = recordDeletion(policy, 'https://b.example', T2);
    expect(pruneDeletions(policy, T2, T3).deletions).toEqual({ 'https://b.example': T2 });
  });

  it('never mutates its input', () => {
    const base = Object.freeze({
      ...defaultPolicy(),
      excluded: Object.freeze(['https://a.example']) as unknown as string[],
      deletions: Object.freeze({ '*': T1 }) as unknown as Record<string, string>,
    });
    expect(() => {
      enablePolicy(base, T2);
      disablePolicy(base, T2);
      excludeOrigin(base, 'https://b.example', T2);
      includeOrigin(base, 'https://a.example', T2);
      recordDeletion(base, 'https://c.example', T2);
      pruneDeletions(base, T3, T3);
    }).not.toThrow();
    expect(base.excluded).toEqual(['https://a.example']);
  });
});

describe('writePolicy', () => {
  it('round-trips through the file', async () => {
    let policy = enablePolicy(defaultPolicy(), T1);
    policy = excludeOrigin(policy, 'https://bank.example', T2);
    policy = recordDeletion(policy, '*', T3);
    await writePolicy(dir, policy);
    expect(readPolicy(dir)).toEqual(policy);
    expect(JSON.parse(fs.readFileSync(policyPath(dir), 'utf8')).schemaVersion).toBe(1);
  });

  it('creates the directory 0o700 and the file 0o600 on POSIX', async () => {
    await writePolicy(dir, enablePolicy(defaultPolicy(), T1));
    if (!posix) return;
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(policyPath(dir)).mode & 0o777).toBe(0o600);
  });

  it('replaces atomically and leaves no temp files', async () => {
    await writePolicy(dir, enablePolicy(defaultPolicy(), T1));
    await writePolicy(dir, disablePolicy(enablePolicy(defaultPolicy(), T1), T2));
    expect(fs.readdirSync(dir)).toEqual(['policy.json']);
    expect(readPolicy(dir).enabled).toBe(false);
  });

  it('a file written over a loose-mode file ends up 0o600', async () => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(policyPath(dir), '{"schemaVersion":1}', { mode: 0o666 });
    await writePolicy(dir, enablePolicy(defaultPolicy(), T1));
    if (posix) expect(fs.statSync(policyPath(dir)).mode & 0o777).toBe(0o600);
  });

  it('concurrent writers leave one complete, valid file', async () => {
    const writes = Array.from({ length: 12 }, (_, i) =>
      writePolicy(dir, excludeOrigin(defaultPolicy(), `https://site${i}.example`, T1)),
    );
    await Promise.all(writes);
    expect(readPolicy(dir).excluded).toHaveLength(1);
    expect(fs.readdirSync(dir)).toEqual(['policy.json']);
  });

  it('refuses to write an invalid policy and leaves the old file', async () => {
    const good = enablePolicy(defaultPolicy(), T1);
    await writePolicy(dir, good);
    const bad = { ...good, excluded: ['https://Not-Canonical.example/path'] };
    expect(await asyncCodeOf(() => writePolicy(dir, bad))).toBe('INVALID_ARGUMENT');
    const tooMany = { ...good, excluded: Array.from({ length: MAX_EXCLUDED_ORIGINS + 1 }, (_, i) => `https://s${i}.example`) };
    expect(await asyncCodeOf(() => writePolicy(dir, tooMany))).toBe('MEMORY_FULL');
    expect(readPolicy(dir)).toEqual(good);
    expect(fs.readdirSync(dir)).toEqual(['policy.json']);
  });

  it('a failed rename keeps the old file, removes the temp file and reports MEMORY_UNAVAILABLE', async () => {
    const good = enablePolicy(defaultPolicy(), T1);
    await writePolicy(dir, good);
    const failure = Object.assign(new Error('cross-device'), { code: 'EXDEV' });
    const code = await asyncCodeOf(() =>
      writePolicy(dir, disablePolicy(good, T2), {
        rename: async () => {
          throw failure;
        },
      }),
    );
    expect(code).toBe('MEMORY_UNAVAILABLE');
    expect(readPolicy(dir)).toEqual(good);
    expect(fs.readdirSync(dir)).toEqual(['policy.json']);
  });

  it('win32: retries rename 3 times on EPERM/EBUSY/EACCES with back-off, then succeeds', async () => {
    const attempts: number[] = [];
    const codes = ['EPERM', 'EBUSY', 'EACCES'];
    const sleeps: number[] = [];
    await writePolicy(dir, enablePolicy(defaultPolicy(), T1), {
      platform: 'win32',
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      rename: async (from, to) => {
        attempts.push(attempts.length);
        if (attempts.length <= codes.length) throw Object.assign(new Error('locked'), { code: codes[attempts.length - 1] });
        fs.renameSync(from, to);
      },
    });
    expect(attempts).toHaveLength(4);
    expect(sleeps).toEqual([50, 50, 50]);
    expect(readPolicy(dir).enabled).toBe(true);
    expect(fs.readdirSync(dir)).toEqual(['policy.json']);
  });

  it('win32: gives up after the retries and cleans up', async () => {
    let calls = 0;
    const code = await asyncCodeOf(() =>
      writePolicy(dir, enablePolicy(defaultPolicy(), T1), {
        platform: 'win32',
        sleep: async () => {},
        rename: async () => {
          calls += 1;
          throw Object.assign(new Error('locked'), { code: 'EBUSY' });
        },
      }),
    );
    expect(code).toBe('MEMORY_UNAVAILABLE');
    expect(calls).toBe(4);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('non-win32 does not retry rename', async () => {
    let calls = 0;
    const code = await asyncCodeOf(() =>
      writePolicy(dir, enablePolicy(defaultPolicy(), T1), {
        platform: 'linux',
        rename: async () => {
          calls += 1;
          throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        },
      }),
    );
    expect(code).toBe('MEMORY_UNAVAILABLE');
    expect(calls).toBe(1);
  });
});
