import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { tabIdParam, forwardHandler } from './types.js';

export const mockTool: ToolDefinition = {
  name: 'browser_mock',
  summary: 'Block or fake network responses for one tab',
  description: 'Set request rules by URL glob/substring: block, or reply with status, body and headers. rules replaces all; [] clears. Limit: 50.',
  inputSchema: z.object({
    tabId: tabIdParam,
    rules: z.array(z.object({
      match: z.string(),
      block: z.boolean().optional(),
      status: z.number().int().min(100).max(599).optional().describe('Default 200'),
      body: z.string().max(20_000).optional(),
      headers: z.record(z.string(), z.string()).optional(),
    }).strict()).max(50).optional(),
  }).strict(),
  // Changes the tab's network behaviour: never auto-retried.
  idempotent: false,
  timeoutMs: 10_000,
  handler: forwardHandler('browser_mock'),
};
