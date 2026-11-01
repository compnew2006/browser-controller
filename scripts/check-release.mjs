#!/usr/bin/env node
// Read only the annotated tag and its parent; the working tree is never used for release notes.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function validateRelease({ tag, tagType, version, manifestVersion, serverVersion, packageVersions, parentVersion, changelog }) {
  const errors = [];
  if (!/^v\d+\.\d+\.\d+$/u.test(tag) || tag.slice(1) !== version) errors.push('tag must match the package version');
  if (tagType !== 'tag') errors.push('release tag must be annotated');
  if (manifestVersion !== version) errors.push('extension manifest version differs');
  if (serverVersion !== version) errors.push('server version differs');
  if (!packageVersions.length || packageVersions.some((item) => item !== version)) errors.push('registry package version differs');
  if (parentVersion === version) errors.push('parent already has this version; tag must point to the version-setting commit');
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const section = changelog.match(new RegExp(`^##\\s+\\[?${escaped}\\]?(?:\\s.*)?$([\\s\\S]*?)(?=^##\\s|$(?![\\s\\S]))`, 'mu'));
  if (!section || !section[1].trim()) errors.push('release notes are missing or empty in tagged CHANGELOG.md');
  return errors;
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function main(tag) {
  if (!/^v\d+\.\d+\.\d+$/u.test(tag ?? '')) throw new Error('usage: npm run release:check -- vX.Y.Z');
  const ref = `refs/tags/${tag}`;
  const tagType = git('cat-file', '-t', ref);
  const commit = git('rev-parse', '--verify', `${ref}^{commit}`);
  const read = (file) => git('show', `${commit}:${file}`);
  const pkg = JSON.parse(read('package.json'));
  const manifest = JSON.parse(read('extension/manifest.json'));
  const server = JSON.parse(read('server.json'));
  const parent = JSON.parse(git('show', `${commit}^:package.json`));
  const errors = validateRelease({ tag, tagType, version: pkg.version, manifestVersion: manifest.version,
    serverVersion: server.version, packageVersions: (server.packages ?? []).filter((item) => item.registryType === 'npm').map((item) => item.version),
    parentVersion: parent.version, changelog: read('CHANGELOG.md') });
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(`${tag}: annotated tag, version files, version-setting commit and tagged notes verified`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv[2]); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
