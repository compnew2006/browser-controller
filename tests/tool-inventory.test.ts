import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toolMap } from '../mcp-server/src/tools/registry.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The AI-facing inventories that must not drift away from the registry. */
const INVENTORY_FILES = ['llms.txt', '.cursor/rules/project.mdc'];

/**
 * An inventory list line is a line that opens a tool list, in either of the two
 * shapes these files use:
 *   - a bullet whose first token is a tool name: "- browser_click (...)"
 *   - a category label, a colon, then a tool name: "Interaction: browser_click (...)"
 * Prose that merely mentions a tool elsewhere in the file is not an inventory
 * line, so only the names on these lines are compared with the registry.
 */
const INVENTORY_LINE = /^\s*(?:[-*+]\s+(browser_[a-z0-9_]+)|[^:\n]{1,60}:\s*(browser_[a-z0-9_]+))/u;
const TOOL_NAME = /browser_[a-z0-9_]+/gu;

/** The tool names a file lists, read from its inventory lines only. */
function inventoryNames(source: string): Set<string> {
  const names = new Set<string>();
  for (const line of source.split(/\r?\n/)) {
    if (!INVENTORY_LINE.test(line)) continue;
    for (const match of line.matchAll(TOOL_NAME)) names.add(match[0]);
  }
  return names;
}

/**
 * The numbers a file claims as the size of its tool inventory: "17 tools" and
 * "Tools (17)". A number in front of a singular "tool" ("50 tool calls") is
 * not a claim about the inventory, so it is not read as one.
 */
function countClaims(source: string): number[] {
  const claims: number[] = [];
  for (const match of source.matchAll(/(\d+)\s+tools\b/giu)) claims.push(Number(match[1]));
  for (const match of source.matchAll(/tools?\b[^.\n]{0,20}?\(\s*(\d+)/giu)) claims.push(Number(match[1]));
  return claims;
}

function read(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

describe('AI-facing tool inventories', () => {
  const registryNames = new Set(toolMap.keys());

  it('derives the expected tool names from the registry', () => {
    expect(registryNames.size).toBeGreaterThan(0);
  });

  for (const file of INVENTORY_FILES) {
    it(`lists every registered tool in ${file}`, () => {
      const names = inventoryNames(read(file));
      const missing = [...registryNames].filter((name) => !names.has(name));
      expect(missing, `${file} omits registered tools`).toEqual([]);
    });

    it(`lists no unknown tool in ${file}`, () => {
      const names = inventoryNames(read(file));
      const extra = [...names].filter((name) => !registryNames.has(name));
      expect(extra, `${file} lists tools the registry does not have`).toEqual([]);
    });

    it(`claims the real tool count in ${file}`, () => {
      const claims = countClaims(read(file));
      expect(claims.length, `${file} states no tool count`).toBeGreaterThan(0);
      const stale = claims.filter((count) => count !== registryNames.size);
      expect(stale, `${file} states a stale tool count`).toEqual([]);
    });
  }
});
