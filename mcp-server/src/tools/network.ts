import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, forwardHandler } from './types.js';

export const networkTool: ToolDefinition = {
  name: 'browser_network',
  summary: 'Read network requests captured from a tab',  description: 'Read network requests made by a specific tab. Filter by URL pattern.',
  inputSchema: z.object({
    tabId: requireTabId(),
    filter: z.string().optional().describe('URL regex pattern to filter requests'),
    limit: z.number().int().min(1).max(200).optional().describe('Return only the most recent N requests (default: all buffered, up to 200)'),
    clear: z.boolean().optional().default(false).describe('Clear this tab\'s requests after reading'),
  }),
  // NOT idempotent: `clear:true` mutates the buffer (same reasoning as console — M2).
  idempotent: false,
  timeoutMs: 5_000,
  handler: forwardHandler('browser_network'),
};
