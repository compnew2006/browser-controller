import { buildSiteContext, captureTabUrl } from '../lib/site-context.js';

/**
 * Daemon-only action behind browser_memory: the tab's siteContext now. It runs through the normal
 * tab mutex and lock (router), so a tab another session holds gives TAB_LOCKED. Read-only.
 */
export async function handleMemoryContext(params) {
  const tabId = params?.tabId;
  if (!Number.isInteger(tabId) || tabId < 0) return { success: false, error: 'INVALID_ARGUMENT: tabId must be a non-negative integer' };
  const urlBefore = await captureTabUrl(tabId).catch(() => null);
  if (urlBefore === null) return { success: false, error: `TAB_NOT_FOUND: no tab ${tabId}` };
  return { success: true, siteContext: await buildSiteContext(tabId, { urlBefore }) };
}
