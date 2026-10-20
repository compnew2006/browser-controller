import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, forwardHandler } from './types.js';

export const runActionTool: ToolDefinition = {
  name: 'browser_run_action',
  summary: 'Run arbitrary JS via CDP (bypasses CSP)',
  description:
    'Run code over CDP: an expression that evaluates to { execute(params) } (called with actionParams), or a plain expression whose value is returned. Always via the debugger; for plain JS browser_evaluate is simpler.',
  inputSchema: z.object({
    tabId: requireTabId(),
    code: z
      .string(),
    actionParams: z
      .record(z.string(), z.unknown())
      .optional()
      .default({})
      .describe('Passed to execute()'),
  }),
  timeoutMs: 30_000,
  handler: forwardHandler('browser_run_action'),
};
