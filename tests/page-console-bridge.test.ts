import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');

describe('page console bridge', () => {
  it('loads exactly one MAIN-world console capture at document_start, plus the isolated relay', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension/manifest.json'), 'utf8'));
    const main = manifest.content_scripts.filter((c: any) => c.world === 'MAIN');
    expect(main).toHaveLength(1);
    expect(main[0]).toMatchObject({ js: ['console-main.js'], run_at: 'document_start' });
    expect(manifest.content_scripts.some((c: any) => c.js.includes('content.js') && !c.world)).toBe(true);
    expect(fs.existsSync(path.join(root, 'extension/page-console.js'))).toBe(false);
  });

  it('uses a private DOM event (not window.postMessage, which page message listeners would see)', () => {
    const page = fs.readFileSync(path.join(root, 'extension/console-main.js'), 'utf8');
    const relay = fs.readFileSync(path.join(root, 'extension/content.js'), 'utf8');
    expect(page).toContain("'__bc_console_entry'");
    expect(page).not.toContain('postMessage');
    expect(relay).toContain("addEventListener('__bc_console_entry'");
  });
});
