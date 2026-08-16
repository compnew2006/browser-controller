import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, forwardHandler } from './types.js';

export const textTool: ToolDefinition = {
  name: 'browser_text',
  summary: 'Extract raw text content from a page',  description: 'Extract raw text content from the page or a specific element',
  inputSchema: z.object({
    tabId: requireTabId(),
    selector: z.string().optional().describe('CSS selector to scope text extraction'),
    maxLength: z.number().optional().default(5000).describe('Max text length to return (default 5000 chars ≈ 1250 tokens; raise only when you need more)'),
  }),
  // Read-only: safe to retry on timeout. (Fixes prior wire-name drift — C1.)
  idempotent: true,
  timeoutMs: 15_000,
  handler: forwardHandler('browser_text'),
};
