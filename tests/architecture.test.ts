import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Architectural fitness functions (audit 5.3).
 *
 * The layering of the server was an agreement nobody enforced: a wrong import
 * passed review because nothing checked it. These functions read the real
 * import graph and fail the build when a boundary is crossed, so the agreement
 * became a rule. `eslint.config.js` carries the same boundaries as lint rules
 * (fast feedback in the editor); this file is the exhaustive proof, because it
 * sees every import, not only the ones a pattern happens to name.
 *
 * The two layers MUST agree: a boundary that only one of them knows about is
 * a boundary nobody enforces.
 */

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

/** Every import specifier of a file: static imports, re-exports and dynamic imports. */
function importSpecifiers(relativePath: string): string[] {
  const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
  return [...source.matchAll(/(?:from|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/gu)].map((match) => match[1]);
}

/**
 * The files of one layer. The layer must still hold sources: a boundary proved
 * over an empty directory would pass for the wrong reason.
 */
function layerFiles(layer: string): string[] {
  const files = sourceFiles(`mcp-server/src/${layer}`, '.ts');
  expect(files.length, `mcp-server/src/${layer}/ must still hold source files`).toBeGreaterThan(0);
  return files;
}

/** An import of a layer, as the pair that has to be reported when it is illegal. */
interface Crossing {
  file: string;
  specifier: string;
}

/** Every import these files make that starts with the given prefix. */
function crossings(files: string[], prefix: string): Crossing[] {
  const hits: Crossing[] = [];
  for (const file of files) {
    for (const specifier of importSpecifiers(file)) {
      if (specifier.startsWith(prefix)) hits.push({ file, specifier });
    }
  }
  return hits;
}

/** The crossings as readable lines, so a failure names the file and the import. */
function describeCrossings(crossingList: Crossing[]): string[] {
  return crossingList.map(({ file, specifier }) => `${file} imports ${specifier}`);
}

describe('architectural layering', () => {
  it('enforces the core allowlist in ESLint for new layers and external packages', async () => {
    const eslint = new ESLint({ cwd: ROOT });
    const filePath = path.join(ROOT, 'mcp-server/src/core/boundary-check.ts');
    for (const specifier of ['../session/new.js', '../daemon.js', 'some-package']) {
      const [result] = await eslint.lintText(`import '${specifier}';`, { filePath });
      expect(result.messages.some((message) => message.ruleId === 'no-restricted-imports'), specifier).toBe(true);
    }
    for (const specifier of ['node:fs/promises', './logger.js', '../core/logger.js']) {
      const [result] = await eslint.lintText(`import '${specifier}';`, { filePath });
      expect(result.messages.some((message) => message.ruleId === 'no-restricted-imports'), specifier).toBe(false);
    }
  });
  it('keeps core/ neutral: it depends on nobody but node builtins and core/ siblings', () => {
    const violations: Crossing[] = [];
    for (const file of layerFiles('core')) {
      for (const specifier of importSpecifiers(file)) {
        if (specifier.startsWith('node:')) continue;
        if (specifier.startsWith('./')) continue;
        if (specifier.startsWith('../core/')) continue;
        violations.push({ file, specifier });
      }
    }
    expect(describeCrossings(violations)).toEqual([]);
  });

  it('keeps the vault independent of the memory layer', () => {
    expect(describeCrossings(crossings(layerFiles('vault'), '../memory/'))).toEqual([]);
  });

  it('keeps the memory layer independent of the vault, except for the shared daemon route', () => {
    // The daemon route is the one documented crossing: it is the plumbing the
    // daemon hands a routed call through, not a dependency of the memory
    // subsystem on the vault.
    const allowed = '../vault/daemon-routing.js';
    const violations = crossings(layerFiles('memory'), '../vault/').filter(({ specifier }) => specifier !== allowed);
    expect(describeCrossings(violations)).toEqual([]);
  });

  it('keeps the wire contract free of the tools, memory and vault layers', () => {
    const files = layerFiles('protocol');
    const violations = [
      ...crossings(files, '../tools/'),
      ...crossings(files, '../memory/'),
      ...crossings(files, '../vault/'),
    ];
    expect(describeCrossings(violations)).toEqual([]);
  });

  it('keeps the tools layer free of the wire/transport layer', () => {
    const files = layerFiles('tools');
    const violations = [
      ...crossings(files, '../protocol/'),
      ...crossings(files, '../bridge'),
      ...crossings(files, '../daemon'),
    ];
    expect(describeCrossings(violations)).toEqual([]);
  });

  it('keeps the tools dependency one-way: memory/ and vault/ never import tools/', () => {
    const violations = [
      ...crossings(layerFiles('memory'), '../tools/'),
      ...crossings(layerFiles('vault'), '../tools/'),
    ];
    expect(describeCrossings(violations)).toEqual([]);
  });

  it('keeps the generated tool names in the wire layer, so nothing has to import the registry', () => {
    // The registry is the tools layer, so the wire layer may not read it. The
    // generated list in protocol/ is what the transport checks a tool name
    // against instead; without it the transport would need the registry, and
    // the dependency would point the wrong way.
    const generated = 'mcp-server/src/protocol/tool-names.ts';
    expect(fs.existsSync(path.join(ROOT, generated)), `${generated} must exist`).toBe(true);
    const source = fs.readFileSync(path.join(ROOT, generated), 'utf8');
    expect(source, generated).toContain('export const TOOL_NAMES');
    expect(describeCrossings(crossings(layerFiles('protocol'), '../tools/'))).toEqual([]);
  });
});
