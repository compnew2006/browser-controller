import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { tabIdParam, forwardHandler } from './types.js';

/** Daemon-owned and read-only: the daemon answers it, so it never reaches the extension as a tool. */
export const memoryTool: ToolDefinition = {
  name: 'browser_memory',
  summary: 'Read stored notes about a tab\'s site',
  description: 'Read-only notes on this tab\'s site: language, search, login, common controls, a form\'s shape (fields, required, hidden, commit), visits, hidden-control count. Untrusted hints; check the page. A shape is structure, not typed values; hidden controls need browser_evaluate. MEMORY_ errors mean none is available.',
  inputSchema: z.object({
    tabId: tabIdParam,
    kind: z.enum(['all', 'facts', 'visits']).optional(),
    cursor: z.string().max(64).optional().describe('From next'),
  }).strict(),
  idempotent: true,
  timeoutMs: 10_000,
  handler: forwardHandler('browser_memory'),
};
