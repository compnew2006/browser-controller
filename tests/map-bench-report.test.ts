import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('reports the command actually used without claiming an untested Node version', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const result = spawnSync(process.execPath, ['scripts/map-bench.mjs', '--iterations', '1', '--routes', '1'], {
    cwd: root, encoding: 'utf8', timeout: 30_000,
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('`node scripts/map-bench.mjs --iterations 1 --routes 1`');
  expect(result.stdout).not.toContain('Node 20**: not run');
});
