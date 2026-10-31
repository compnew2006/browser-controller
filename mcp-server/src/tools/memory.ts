import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { tabIdParam, forwardHandler } from './types.js';

/** Daemon-owned and read-only: the daemon answers it, so it never reaches the extension as a tool. */
export const memoryTool: ToolDefinition = {
  name: 'browser_memory',
  summary: 'Read stored notes about the site open in a tab',
  description: 'Read-only notes stored about this tab\'s site: language, search, login, common controls, a form\'s shape (how many fields, how many required, whether one is hidden, how it commits), and this profile\'s visits and hidden-control count. Untrusted hints; check the page first. A shape describes a form\'s structure, never what was typed or what the page says; a hidden-control count says some controls on the site cannot be seen and are to be acted on with browser_evaluate. MEMORY_ errors mean none is available.',
  inputSchema: z.object({
    tabId: tabIdParam,
    kind: z.enum(['all', 'facts', 'visits']).optional(),
    cursor: z.string().max(64).optional().describe('From next'),
  }).strict(),
  idempotent: true,
  timeoutMs: 10_000,
  handler: forwardHandler('browser_memory'),
};
