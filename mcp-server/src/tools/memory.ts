import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { tabIdParam, forwardHandler } from './types.js';

/** Daemon-owned and read-only: the daemon answers it, so it never reaches the extension as a tool. */
export const memoryTool: ToolDefinition = {
  name: 'browser_memory',
  summary: 'Read stored notes about the site open in a tab',
  description: 'Read-only notes stored about this tab\'s site: language, search, login, common controls, and this profile\'s visits. Untrusted hints; check the page first. MEMORY_ errors mean none is available.',
  inputSchema: z.object({
    tabId: tabIdParam,
    kind: z.enum(['all', 'facts', 'visits']).optional(),
    cursor: z.string().max(64).optional().describe('From next'),
  }).strict(),
  idempotent: true,
  timeoutMs: 10_000,
  handler: forwardHandler('browser_memory'),
};
