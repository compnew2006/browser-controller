import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, forwardHandler } from './types.js';

export const findTool: ToolDefinition = {
  name: 'browser_find',
  description:
    'Find elements by description ("search input", "Save button"); a control in a table row also matches the row\'s words. Returns refs; cheaper than a snapshot.',
  inputSchema: z.object({
    tabId: requireTabId(),
    query: z.string(),
    limit: z.number().optional().default(10),
    role: z.string().optional().describe('Only this ARIA role'),
  }),
  // Read-only: safe to retry on timeout. (Fixes the prior wire-name drift where
  // callTool('find') disagreed with .name 'browser_find' and silently disabled
  // this retry — see audit C1.)
  idempotent: true,
  timeoutMs: 15_000,
  handler: forwardHandler('browser_find'),
};
