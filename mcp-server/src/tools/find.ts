import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, forwardHandler } from './types.js';

export const findTool: ToolDefinition = {
  name: 'browser_find',
  summary: 'Find elements by natural language description',  description:
    'Find elements on the page using natural language (e.g. "login button", "search input"). Returns refs you can use with click/type.',
  inputSchema: z.object({
    tabId: requireTabId(),
    query: z.string().describe('Natural language description of what to find'),
    limit: z.number().optional().default(10).describe('Max matches to return'),
  }),
  // Read-only: safe to retry on timeout. (Fixes the prior wire-name drift where
  // callTool('find') disagreed with .name 'browser_find' and silently disabled
  // this retry — see audit C1.)
  idempotent: true,
  timeoutMs: 15_000,
  handler: forwardHandler('browser_find'),
};
