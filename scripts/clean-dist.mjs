import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'mcp-server', 'dist');

/**
 * Removes the build output before a compile.
 *
 * `tsc` overwrites the files it produces and leaves the files of sources that
 * no longer exist. When a module moves — `protocol.ts` became `protocol/` —
 * the old `dist/protocol.js` stays next to the new `dist/protocol/index.js`,
 * and a stale copy of a module can be loaded instead of the current one. The
 * symptom is a failure that looks like a product defect but is really an old
 * artifact: a script that imports `dist/protocol/index.js` finds nothing, or
 * two halves of the program end up talking different protocol versions.
 *
 * Removing the directory first makes the output describe exactly the sources
 * that were compiled.
 */
fs.rmSync(DIST, { recursive: true, force: true });
