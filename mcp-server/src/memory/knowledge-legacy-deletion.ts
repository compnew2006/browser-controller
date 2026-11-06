import fs from 'node:fs/promises';
import path from 'node:path';
import type { MemoryAdminRequest, MemoryAdminResult } from '../daemon-config.js';
import { ERROR_CODES, formatError } from '../core/error-codes.js';
import { runAdminCommand, type AdminContext } from './admin.js';
import { KnowledgeDeletionCoordinator } from './knowledge-deletion-coordinator.js';
import { canonicalOrigin } from './policy.js';
import { siteFileName } from './store.js';

async function entries(dir: string): Promise<string[]> {
  try { return await fs.readdir(dir); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function hasKnowledgeState(root: string): Promise<boolean> {
  for (const name of ['knowledge', 'knowledge-delete-journal.json']) {
    try { await fs.lstat(path.join(root, name)); return true; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return false;
}

async function verifyLegacy(root: string, context: AdminContext, origin: string): Promise<boolean> {
  const sites = await entries(path.join(root, 'sites'));
  const site = origin === '*' ? '' : siteFileName(origin);
  if (sites.some((name) => origin === '*' || name === site || name.startsWith(`${site}.corrupt-`) || name.endsWith('.tmp'))) return false;
  const maps = await context.map.store.listMaps();
  if (maps.some((map) => origin === '*' || map.origin === origin || map.entrances?.some((entry) => entry.origin === origin))) return false;
  // A quarantined map cannot be inspected for a reference to the deleted site.
  const mapsDir = path.join(root, 'maps');
  for (const dir of await entries(mapsDir)) {
    const stat = await fs.lstat(path.join(mapsDir, dir));
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    if ((await entries(path.join(mapsDir, dir))).some((name) => name.includes('.corrupt-') || name.endsWith('.tmp'))) return false;
  }
  return origin === '*' ? (await entries(mapsDir)).length === 0 : true;
}

/** Extends the existing owner delete action only when knowledge state exists. */
export async function runKnowledgeAwareAdmin(root: string, context: AdminContext, request: MemoryAdminRequest): Promise<MemoryAdminResult> {
  if (request.command !== 'delete') return runAdminCommand(context, request);
  const origin = request.all === true ? '*' : request.origin === undefined ? null : canonicalOrigin(request.origin);
  if (!origin) return runAdminCommand(context, request);
  try {
    if (!await hasKnowledgeState(root)) return runAdminCommand(context, request);
    let legacyResult: MemoryAdminResult | undefined;
    const coordinator = new KnowledgeDeletionCoordinator(root, {
      deleteLegacy: async () => {
        legacyResult = await runAdminCommand(context, request);
        if (!legacyResult.success) throw new Error('Legacy deletion failed');
      },
      verifyLegacy: (scope) => verifyLegacy(root, context, scope),
    });
    const result = await coordinator.run(origin, () => true);
    if (!result.success) return { kind: 'memory-admin-result', id: request.id, success: false, error: result.error };
    if (legacyResult) return legacyResult;
    throw new Error('Legacy deletion did not complete');
  } catch {
    return { kind: 'memory-admin-result', id: request.id, success: false, error: formatError(ERROR_CODES.MEMORY_UNAVAILABLE, 'Deletion could not be verified.') };
  }
}
