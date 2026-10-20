import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(relativePath: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

function sourceLineCount(relativePath: string): number {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8').split(/\r?\n/).length;
}

describe('maintenance quality gates', () => {
  it('keeps production modules below the agreed 600-line boundary', () => {
    const files = ['extension', 'extension/lib', 'extension/handlers', 'extension/utils', 'mcp-server/src', 'mcp-server/src/tools']
      .flatMap((dir) => fs.readdirSync(path.join(ROOT, dir))
        .filter((f) => /\.(js|ts)$/.test(f))
        .map((f) => `${dir}/${f}`));
    const oversized = Object.fromEntries(
      files
        .map((file) => [file, sourceLineCount(file)] as const)
        .filter(([, lines]) => lines > 600),
    );
    expect(oversized).toEqual({});
  });

  it('exposes repeatable lint, coverage, and production-audit commands', () => {
    const pkg = readJson('package.json');
    expect(pkg.scripts).toEqual(expect.objectContaining({
      lint: expect.any(String),
      'test:coverage': expect.any(String),
      'security:audit': expect.any(String),
    }));
  });

  it('enforces the quality and security commands in CI', () => {
    const ci = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toContain('npm run lint');
    expect(ci).toContain('npm run test:coverage');
    expect(ci).toContain('npm run security:audit');
  });
});
