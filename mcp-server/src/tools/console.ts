import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, forwardHandler } from './types.js';

export const consoleTool: ToolDefinition = {
  name: 'browser_console',
  summary: 'Read console messages from a tab',
  description: "Console messages and uncaught errors (with stacks) of the tab's current page, read through the debugger; filtered by pattern (regex), level and limit. browser:true adds what Chrome itself reported (failed loads, deprecations) and DevTools Issues.",
  inputSchema: z.object({
    tabId: requireTabId(),
    browser: z.boolean().optional(),
    clear: z.boolean().optional().default(false).describe('Discard the messages after reading'),
    pattern: z.string().optional().describe('Case-insensitive regex'),
    level: z.union([z.enum(['log', 'info', 'warn', 'error', 'debug']), z.array(z.enum(['log', 'info', 'warn', 'error', 'debug']))]).optional(),
    limit: z.number().int().min(1).max(200).optional().describe('Latest N'),
  }),
  // NOT idempotent: `clear:true` discards the messages. A timeout-retry would
  // return an empty buffer (first call already cleared it) and silently lose
  // the original messages. See audit M2.
  idempotent: false,
  timeoutMs: 10_000, // attaches the debugger first
  handler: forwardHandler('browser_console'),
};
