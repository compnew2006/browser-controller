import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { MAP_ALLOWLIST, MAP_LIMITS } from '../mcp-server/src/memory/map-allowlist.js';

const contract = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'specs', '004-site-navigation-map', 'contracts', 'map-allowlist.json'), 'utf8')) as Record<string, unknown>;

/** Drop `$comment` keys at every level: they document the contract and are not rules. */
function rules(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rules);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => key !== '$comment').map(([key, entry]) => [key, rules(entry)]));
  }
  return value;
}

describe('map allowlist parity (T003, owner gate 3)', () => {
  it('mirrors contracts/map-allowlist.json exactly', () => {
    expect(rules(MAP_ALLOWLIST)).toEqual(rules(contract));
  });

  it('keeps the reviewed limits the plan names', () => {
    expect(MAP_LIMITS).toMatchObject({ nameChars: 80, titleChars: 120, pathChars: 200, pagesPerOrigin: 500, controlsPerPage: 60, mapFileBytes: 1_048_576, mapFilesPerProfile: 1_000, mapTotalBytes: 67_108_864, excludedPrefixesPerOrigin: 32 });
  });

  it('records links in main and page areas never (content pages are not structure)', () => {
    expect(MAP_ALLOWLIST.eligibleRoles.main).not.toContain('link');
    expect(MAP_ALLOWLIST.eligibleRoles.page).not.toContain('link');
    expect(MAP_ALLOWLIST.areas.menubar).toBe('nav');
    expect(MAP_ALLOWLIST.areas.menu).toBe('menu');
  });

  it('compiles every masking pattern as a Unicode regex', () => {
    for (const rule of MAP_ALLOWLIST.masking.rules) expect(() => new RegExp(rule.pattern, 'gu')).not.toThrow();
  });
});
