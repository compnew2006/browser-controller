import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let stateDir: string;
let config: typeof import('../mcp-server/src/daemon-config.js');

beforeEach(async () => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-secrets-'));
  vi.stubEnv('BC_STATE_DIR', stateDir);
  vi.resetModules();
  config = await import('../mcp-server/src/daemon-config.js');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe('daemon secrets', () => {
  it.skipIf(process.platform === 'win32')('protects existing state and secret files without rotating credentials', () => {
    const file = path.join(stateDir, 'token.json');
    fs.writeFileSync(file, JSON.stringify({ token: 'existing-token', createdAt: 1 }));
    fs.chmodSync(stateDir, 0o755);
    fs.chmodSync(file, 0o644);

    expect(config.loadOrCreateToken().token).toBe('existing-token');
    expect(fs.statSync(stateDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('keeps the credential published by a competing first starter', () => {
    const file = path.join(stateDir, 'token.json');
    const randomBytes = crypto.randomBytes.bind(crypto);
    vi.spyOn(crypto, 'randomBytes').mockImplementation(((size: number) => {
      fs.writeFileSync(file, JSON.stringify({ token: 'winner-token', createdAt: 1 }), { mode: 0o600 });
      return randomBytes(size);
    }) as typeof crypto.randomBytes);

    expect(config.loadOrCreateToken().token).toBe('winner-token');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).token).toBe('winner-token');
  });

  it.skipIf(process.platform === 'win32')('refuses a credential symlink without changing its target', () => {
    const target = path.join(stateDir, 'other.json');
    fs.writeFileSync(target, JSON.stringify({ secret: 'existing', createdAt: 1 }), { mode: 0o644 });
    fs.chmodSync(target, 0o644);
    fs.symlinkSync(target, path.join(stateDir, 'enrollment.json'));
    expect(() => config.loadOrCreateEnrollment()).toThrow();
    expect(fs.statSync(target).mode & 0o777).toBe(0o644);
  });

  it.skipIf(process.platform === 'win32')('does not change permissions of a multiply linked credential', () => {
    const target = path.join(stateDir, 'other.json');
    fs.writeFileSync(target, JSON.stringify({ token: 'existing', createdAt: 1 }));
    fs.chmodSync(target, 0o644);
    fs.linkSync(target, path.join(stateDir, 'token.json'));
    expect(() => config.loadOrCreateToken()).toThrow();
    expect(fs.statSync(target).mode & 0o777).toBe(0o644);
  });

  it('refuses corrupt credentials without replacing them', () => {
    const file = path.join(stateDir, 'enrollment.json');
    fs.writeFileSync(file, '{invalid', { mode: 0o600 });
    expect(() => config.loadOrCreateEnrollment()).toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe('{invalid');
  });
});
