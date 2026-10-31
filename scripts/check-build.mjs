import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'mcp-server', 'src');
const DIST = path.join(ROOT, 'mcp-server', 'dist');

/**
 * Fails when the build output does not describe the current sources.
 *
 * Some tests start the compiled daemon (`mcp-server/dist/daemon.js`), so a
 * stale build is a test that exercises yesterday's code. The symptom is
 * misleading: a module that moved is simply missing from the old output, and
 * the failure looks like a product defect rather than an old artifact. This
 * check turns that into one clear sentence.
 *
 * It only reads timestamps and never writes, so two test runs can happen at
 * the same time without one of them removing the other's build.
 */

function newestMtime(dir, extensions) {
  let newest = 0;
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!extensions.includes(path.extname(entry.name))) continue;
      const { mtimeMs } = fs.statSync(full);
      if (mtimeMs > newest) newest = mtimeMs;
    }
  };
  walk(dir);
  return newest;
}

function oldestMtime(dir) {
  let oldest = Number.POSITIVE_INFINITY;
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const { mtimeMs } = fs.statSync(full);
      if (mtimeMs < oldest) oldest = mtimeMs;
    }
  };
  walk(dir);
  return oldest;
}

if (!fs.existsSync(DIST)) {
  console.error('mcp-server/dist is missing — run `npm run build` before running the tests.');
  process.exit(1);
}

const newestSource = newestMtime(SRC, ['.ts', '.js', '.mjs']);
const oldestOutput = oldestMtime(DIST);

if (!Number.isFinite(oldestOutput)) {
  console.error('mcp-server/dist is empty — run `npm run build` before running the tests.');
  process.exit(1);
}

if (newestSource > oldestOutput) {
  console.error('mcp-server/dist is older than mcp-server/src — run `npm run build` before running the tests.');
  console.error('A stale build makes the tests exercise code that is no longer in the tree.');
  process.exit(1);
}
