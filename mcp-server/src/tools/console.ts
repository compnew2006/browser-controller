import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, forwardHandler } from './types.js';

export const consoleTool: ToolDefinition = {
  name: 'browser_console',
  summary: 'Read console messages from a tab',  description: 'Read console messages (log, info, warn, error, debug, uncaught errors) the page produced in a specific tab. Filter with pattern (regex) / level, and keep only the latest with limit.',
  inputSchema: z.object({
    tabId: requireTabId(),
    clear: z.boolean().optional().default(false).describe('Clear this tab\'s messages after reading'),
    pattern: z.string().optional().describe('Case-insensitive regex the message text must match, e.g. "error|fail"'),
    level: z.union([z.enum(['log', 'info', 'warn', 'error', 'debug']), z.array(z.enum(['log', 'info', 'warn', 'error', 'debug']))]).optional().describe('Only these levels'),
    limit: z.number().int().min(1).max(200).optional().describe('Return only the most recent N matching messages'),
  }),
  // NOT idempotent: `clear:true` mutates the buffer. A timeout-retry would
  // return an empty buffer (first call already cleared it) and silently lose
  // the original messages. See audit M2.
  idempotent: false,
  timeoutMs: 5_000,
  handler: forwardHandler('browser_console'),
};
