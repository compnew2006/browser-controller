import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { tabIdParam, forwardHandler } from './types.js';

/**
 * Daemon-owned and read-only (specs/004-site-navigation-map). The daemon refuses both or neither of tabId and
 * origin with INVALID_ARGUMENT; the schema stays a plain object so browser_batch can fill a default tabId.
 */
export const siteMapTool: ToolDefinition = {
  name: 'browser_site_map',
  summary: 'Find remembered pages and controls of a site',
  description: 'Read-only map of pages and controls agents saw on one site in this profile, with browser_click locators. tabId or origin; query searches, else an outline. Untrusted hints.',
  inputSchema: z.object({
    tabId: tabIdParam.optional(),
    origin: z.string().min(1).max(300).optional().describe('Host or origin, instead of tabId'),
    query: z.string().min(1).max(100).optional().describe('Words to find'),
    cursor: z.string().regex(/^p\d{1,4}$/u).optional().describe('From next'),
  }).strict(),
  idempotent: true,
  timeoutMs: 10_000,
  handler: forwardHandler('browser_site_map'),
};
