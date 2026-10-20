import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, forwardHandler } from './types.js';

export const evaluateTool: ToolDefinition = {
  name: 'browser_evaluate',
  description:
    'Run JavaScript in a tab like the DevTools console: top-level await, the last expression\'s value is returned. Over CDP, so page CSP does not block it; mode:"scripting" = no debugger, CSP-bound, no top-level await. Prefer browser_click/browser_type for input.',
  inputSchema: z.object({
    tabId: requireTabId(),
    expression: z.string(),
    timeout: z.number().int().min(1000).max(120_000).optional().default(30_000).describe('ms (default 30000)'),
    mode: z.enum(['cdp', 'scripting']).optional().default('cdp'),
  }),
  // Must exceed the largest `timeout` so the page-side budget decides.
  timeoutMs: 125_000,
  handler: forwardHandler('browser_evaluate'),
};
