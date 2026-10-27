import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error -- plain ESM script without type declarations
import { rotate } from '../scripts/pairing.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'pairing.mjs');
const OLD_SECRET = 'synthetic-old-enrollment-secret-0001';
const OLD_TOKEN = 'synthetic-old-daemon-token-0002';

let root: string;
let stateDir: string;

const readJson = (name: string) => JSON.parse(fs.readFileSync(path.join(stateDir, name), 'utf8'));
const mode = (name: string) => fs.statSync(path.join(stateDir, name)).mode & 0o777;
const allText = () => fs.readdirSync(stateDir).map((f) => fs.readFileSync(path.join(stateDir, f), 'utf8')).join('\n');

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-rotate-'));
  stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir, { mode: 0o700 });
  fs.writeFileSync(path.join(stateDir, 'enrollment.json'), JSON.stringify({ secret: OLD_SECRET, createdAt: 1 }), { mode: 0o600 });
  fs.writeFileSync(path.join(stateDir, 'token.json'), JSON.stringify({ token: OLD_TOKEN, createdAt: 1 }), { mode: 0o600 });
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('pairing rotate', () => {
  it('replaces the enrollment secret and the daemon token with fresh random values', () => {
    const r = rotate({ stateDir });
    expect(r).toEqual({ secretRotated: true, tokenRotated: true });
    const secret = readJson('enrollment.json');
    const token = readJson('token.json');
    expect(secret.secret).toMatch(/^[0-9a-f]{48}$/);
    expect(token.token).toMatch(/^[0-9a-f]{48}$/);
    expect(secret.secret).not.toBe(token.token);
    expect(typeof secret.createdAt).toBe('number');
    expect(secret.createdAt).toBeGreaterThan(1);
  });

  it('keeps 0600 files, leaves no temp files, and no trace of the old values', () => {
    rotate({ stateDir });
    expect(mode('enrollment.json')).toBe(0o600);
    expect(mode('token.json')).toBe(0o600);
    expect(fs.readdirSync(stateDir).sort()).toEqual(['enrollment.json', 'token.json']);
    expect(allText()).not.toContain(OLD_SECRET);
    expect(allText()).not.toContain(OLD_TOKEN);
  });

  it('rotates only the secret when no token file exists yet', () => {
    fs.rmSync(path.join(stateDir, 'token.json'));
    expect(rotate({ stateDir })).toEqual({ secretRotated: true, tokenRotated: false });
    expect(fs.existsSync(path.join(stateDir, 'token.json'))).toBe(false);
  });

  it('CLI prints neither the old nor the new values and names the restart step', () => {
    const res = spawnSync(process.execPath, [SCRIPT, 'rotate'], { env: { ...process.env, BC_STATE_DIR: stateDir }, encoding: 'utf8' });
    expect(res.status).toBe(0);
    const out = res.stdout + res.stderr;
    const fresh = readJson('enrollment.json').secret as string;
    const freshToken = readJson('token.json').token as string;
    for (const v of [OLD_SECRET, OLD_TOKEN, fresh, freshToken]) expect(out).not.toContain(v);
    expect(out).toContain('npm run daemon:restart');
    expect(out).toMatch(/MCP clients re-read the new token/);
  });

  it('fails clearly and creates nothing when the state dir is missing', () => {
    const missing = path.join(root, 'nope');
    expect(() => rotate({ stateDir: missing })).toThrow(/state directory.*not found/i);
    expect(fs.existsSync(missing)).toBe(false);
    const res = spawnSync(process.execPath, [SCRIPT, 'rotate'], { env: { ...process.env, BC_STATE_DIR: missing }, encoding: 'utf8' });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/not found/i);
    expect(fs.existsSync(missing)).toBe(false);
  });

  it('fails clearly and changes nothing when there is no enrollment secret to rotate', () => {
    fs.rmSync(path.join(stateDir, 'enrollment.json'));
    expect(() => rotate({ stateDir })).toThrow(/no enrollment secret/i);
    expect(fs.readdirSync(stateDir)).toEqual(['token.json']);
    expect(readJson('token.json').token).toBe(OLD_TOKEN);
  });
});
