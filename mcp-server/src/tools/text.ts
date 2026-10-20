import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, forwardHandler } from './types.js';

export const textTool: ToolDefinition = {
  name: 'browser_text',
  description: 'Visible text of the page or of selector matches (shadow DOM and same-origin iframes included) — the cheapest read. Read long text on with offset = nextOffset.',
  inputSchema: z.object({
    tabId: requireTabId(),
    selector: z.string().optional().describe('Every visible match, in page order'),
    maxLength: z.number().int().min(1).max(100_000).optional().default(5000).describe('Default 5000'),
    offset: z.number().int().min(0).max(100_000_000).optional(),
  }),
  // Read-only: safe to retry on timeout. (Fixes prior wire-name drift — C1.)
  idempotent: true,
  timeoutMs: 15_000,
  handler: forwardHandler('browser_text'),
};
