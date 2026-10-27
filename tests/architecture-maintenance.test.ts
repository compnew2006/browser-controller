import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(relativePath: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

/** Lines as an editor counts them: the newline that ends the last line does not start another. */
function sourceLineCount(relativePath: string): number {
  const lines = fs.readFileSync(path.join(ROOT, relativePath), 'utf8').split(/\r?\n/);
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

/** Source files under a directory, recursively, by extension (node_modules skipped). */
function sourceFiles(relativeDir: string, extension: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const relativePath = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(relativePath);
      else if (entry.name.endsWith(extension)) found.push(relativePath);
    }
  };
  walk(relativeDir);
  return found.sort();
}

/** Production modules allowed past the 600-line boundary, each with the one reason it is not split. */
const OVERSIZED_EXCEPTIONS: Record<string, string> = {
  'extension/lib/page-dom.js': 'one function serialized into the page (PAGE_DOM_INSTALL), so it cannot be split',
};

describe('maintenance quality gates', () => {
  it('keeps every production module below the agreed 600-line boundary', () => {
    const production = [...sourceFiles('extension', '.js'), ...sourceFiles('mcp-server/src', '.ts')];
    expect(production).toEqual(expect.arrayContaining(['extension/handlers/inspection.js', 'mcp-server/src/bridge.ts']));
    const oversized = Object.fromEntries(
      production
        .filter((file) => !(file in OVERSIZED_EXCEPTIONS))
        .map((file) => [file, sourceLineCount(file)] as const)
        .filter(([, lines]) => lines > 600),
    );
    expect(oversized).toEqual({});
  });

  it('lists an exception only while it is still over the boundary', () => {
    for (const file of Object.keys(OVERSIZED_EXCEPTIONS)) {
      expect(sourceLineCount(file), file).toBeGreaterThan(600);
    }
  });

  it('keeps website memory local: no network, process or socket API is imported under mcp-server/src/memory/ (R-16)', () => {
    const files = sourceFiles('mcp-server/src/memory', '.ts');
    expect(files.length).toBeGreaterThan(8);
    const allowedBuiltins = new Set(['node:fs', 'node:fs/promises', 'node:path', 'node:crypto']);
    const allowedSiblings = new Set(['../protocol.js', '../daemon-config.js', '../bridge-frames.js', '../vault/daemon-routing.js']);
    const banned = /\b(?:net|http|https|http2|dns|dgram|tls|child_process|cluster|worker_threads|ws|undici|node-fetch)\b/u;
    for (const file of files) {
      const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
      const specifiers = [...source.matchAll(/(?:from|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/gu)].map((match) => match[1]);
      for (const specifier of specifiers) {
        if (specifier.startsWith('./')) continue;
        if (specifier.startsWith('../')) expect(allowedSiblings.has(specifier), `${file} imports ${specifier}`).toBe(true);
        else expect(allowedBuiltins.has(specifier), `${file} imports ${specifier}`).toBe(true);
        expect(banned.test(specifier.replace(/^node:/u, '')), `${file} imports ${specifier}`).toBe(false);
      }
      expect(source, file).not.toMatch(/\bfetch\s*\(|new\s+WebSocket\b|XMLHttpRequest|\bglobalThis\.fetch\b/u);
    }
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
