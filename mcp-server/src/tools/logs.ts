import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { tabIdParam, forwardHandler } from './types.js';

export const logsTool: ToolDefinition = {
  name: 'browser_logs',
  summary: 'Console messages and network requests of a tab',
  description: 'Console messages and network requests of the current page. filter, errors, since, all, requestId and bodies narrow it; clear empties it, and cannot combine with requestId.',
  inputSchema: z.object({
    tabId: tabIdParam,
    kind: z.enum(['console', 'network']).optional(),
    filter: z.string().optional(),
    errors: z.boolean().optional(),
    limit: z.number().int().min(1).max(200).optional().describe('Default 50'),
    since: z.string().optional().describe('Request id: only later ones'),
    all: z.boolean().optional().describe('Earlier pages too'),
    clear: z.boolean().optional(),
    requestId: z.string().optional(),
    bodies: z.boolean().optional().describe('Response body, with requestId'),
  }).strict(),
  // clear mutates the buffer, so a read with clear is not safe to retry.
  idempotent: false,
  timeoutMs: 10_000,
  handler: forwardHandler('browser_logs'),
};
