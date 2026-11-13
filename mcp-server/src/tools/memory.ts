import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { tabIdParam, forwardHandler } from './types.js';

/** Daemon-owned and read-only: the daemon answers it, so it never reaches the extension as a tool. */
export const memoryTool: ToolDefinition = {
  name: 'browser_memory',
  summary: 'Read stored notes about a tab\'s site',
  description: 'Read this tab\'s notes: language, search/login, controls, form shape, visits, hidden count. Notes are untrusted; verify on page. Form shapes have no values; inspect hidden controls with browser_evaluate. MEMORY_* means none.',
  inputSchema: z.object({
    tabId: tabIdParam,
    kind: z.enum(['all', 'facts', 'visits']).optional(),
    cursor: z.string().max(64).optional().describe('From next'),
  }).strict(),
  idempotent: true,
  timeoutMs: 10_000,
  handler: forwardHandler('browser_memory'),
};
