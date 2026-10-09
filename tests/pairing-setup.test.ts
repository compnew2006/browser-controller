import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error -- plain ESM script without type declarations
import { HOST_NAME, install, status, uninstall, unpackedExtensionId } from '../scripts/pairing.mjs';

let home: string;
let repoRoot: string;
const ID = 'abcdefghijklmnopabcdefghijklmnop';

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-pairing-'));
  home = path.join(root, 'home');
  repoRoot = path.join(root, 'repo');
  fs.mkdirSync(path.join(repoRoot, 'mcp-server', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'mcp-server', 'dist', 'native-host.js'), '// host');
});

const macChrome = () => path.join(home, 'Library', 'Application Support', 'Google', 'Chrome');

describe('unpacked extension ID', () => {
  it("matches Chrome's ID scheme (SHA-256, first 128 bits, hex digits mapped to a-p)", () => {
    // Chromium crx_file::id_util test vector: GenerateId("test").
    expect(unpackedExtensionId('test', 'linux')).toBe('jpignaibiiemhngfjkcpokkamffknabf');
    expect(unpackedExtensionId('/Users/me/browser-controller/extension', 'darwin')).toMatch(/^[a-p]{32}$/);
  });

  it('on Windows hashes the UTF-16 path with an upper-case drive letter', () => {
    expect(unpackedExtensionId('c:\\bc\\extension', 'win32')).toBe(unpackedExtensionId('C:\\bc\\extension', 'win32'));
    expect(unpackedExtensionId('C:\\bc\\extension', 'win32')).not.toBe(unpackedExtensionId('C:\\bc\\extension', 'linux'));
  });
});

describe('setup:pairing installer', () => {
  it('registers only with the browsers that exist, via a launcher pinned to this node', () => {
    fs.mkdirSync(macChrome(), { recursive: true });
    const r = install({ platform: 'darwin', home, repoRoot, nodePath: '/opt/homebrew/bin/node', extensionIds: [ID] });

    expect(r.installed).toEqual(['Google Chrome']);
    expect(r.skipped).toContain('Brave');
    const manifestPath = path.join(macChrome(), 'NativeMessagingHosts', `${HOST_NAME}.json`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    expect(manifest).toMatchObject({ name: HOST_NAME, type: 'stdio', path: r.wrapperPath, allowed_origins: [`chrome-extension://${ID}/`] });
    expect(fs.existsSync(path.join(home, 'Library', 'Application Support', 'BraveSoftware'))).toBe(false);

    const launcher = fs.readFileSync(r.wrapperPath, 'utf8');
    expect(launcher.startsWith('#!/bin/sh\n')).toBe(true);
    expect(launcher).toContain(`exec '/opt/homebrew/bin/node' '${path.join(repoRoot, 'mcp-server', 'dist', 'native-host.js')}' "$@"`);
    expect(fs.statSync(r.wrapperPath).mode & 0o111).not.toBe(0);
  });

  it('carries a custom BC_STATE_DIR into the launcher (Chrome does not see the shell env)', () => {
    fs.mkdirSync(macChrome(), { recursive: true });
    const r = install({ platform: 'darwin', home, repoRoot, nodePath: '/usr/bin/node', stateDir: "/tmp/it's state", extensionIds: [ID] });
    expect(fs.readFileSync(r.wrapperPath, 'utf8')).toContain(`export BC_STATE_DIR='/tmp/it'\\''s state'`);
  });

  it('uses ~/.config (or XDG_CONFIG_HOME) on Linux', () => {
    const xdg = path.join(home, 'xdg');
    fs.mkdirSync(path.join(xdg, 'chromium'), { recursive: true });
    const r = install({ platform: 'linux', home, xdgConfigHome: xdg, repoRoot, nodePath: '/usr/bin/node', extensionIds: [ID] });
    expect(r.installed).toEqual(['Chromium']);
    expect(fs.existsSync(path.join(xdg, 'chromium', 'NativeMessagingHosts', `${HOST_NAME}.json`))).toBe(true);
  });

  it('on Windows writes the manifest next to a .bat launcher and registers it under HKCU', () => {
    const calls: string[][] = [];
    const r = install({ platform: 'win32', home, repoRoot, nodePath: 'C:\\node\\node.exe', extensionIds: [ID], reg: (a: string[]) => { calls.push(a); } });
    expect(r.wrapperPath.endsWith('.bat')).toBe(true);
    expect(fs.readFileSync(r.wrapperPath, 'utf8')).toContain(`"C:\\node\\node.exe" "${path.join(repoRoot, 'mcp-server', 'dist', 'native-host.js')}" %*`);
    expect(calls[0]).toEqual(['add', `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`, '/ve', '/t', 'REG_SZ', '/d', path.join(repoRoot, '.native-host', `${HOST_NAME}.json`), '/f']);
    expect(r.installed).toEqual(['Google Chrome', 'Chromium', 'Microsoft Edge', 'Brave']);
  });

  it('refuses to register a host that has not been built', () => {
    fs.rmSync(path.join(repoRoot, 'mcp-server', 'dist', 'native-host.js'));
    expect(() => install({ platform: 'darwin', home, repoRoot, extensionIds: [ID] })).toThrow(/npm run build/);
  });

  it('status reports registrations without revealing the secret; uninstall removes them', () => {
    fs.mkdirSync(macChrome(), { recursive: true });
    const stateDir = path.join(home, '.browser-controller');
    fs.mkdirSync(stateDir, { recursive: true });
    const marker = 'do-not-print'; // fake fixture value: status must never echo it
    fs.writeFileSync(path.join(stateDir, 'enrollment.json'), JSON.stringify({ secret: marker }));
    install({ platform: 'darwin', home, repoRoot, nodePath: '/usr/bin/node', extensionIds: [ID] });

    const s = status({ platform: 'darwin', home, repoRoot, stateDir });
    expect(s).toMatchObject({ hostBuilt: true, enrollment: true, browsers: [{ name: 'Google Chrome', allowedOrigins: [`chrome-extension://${ID}/`] }] });
    expect(JSON.stringify(s)).not.toContain(marker);

    expect(uninstall({ platform: 'darwin', home, repoRoot }).removed).toEqual(['Google Chrome']);
    expect(status({ platform: 'darwin', home, repoRoot, stateDir })).toMatchObject({ wrapperPath: null, browsers: [] });
  });
});
