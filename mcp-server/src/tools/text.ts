import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, forwardHandler } from './types.js';

export const textTool: ToolDefinition = {
  name: 'browser_text',
  summary: 'Extract raw text content from a page',  description: 'Visible text of the page or of selector matches (shadow DOM included) — the cheapest read. mode:"article" = main content only; read long text on with offset = nextOffset.',
  inputSchema: z.object({
    tabId: requireTabId(),
    selector: z.string().optional().describe('CSS selector: every visible match, in page order (matches counts them when more than one). Only hidden matches return ELEMENT_HIDDEN.'),
    maxLength: z.number().int().min(1).max(100_000).optional().default(5000).describe('Max text length to return (default 5000 chars ≈ 1250 tokens; raise only when you need more, max 100000)'),
    mode: z.enum(['all', 'article']).optional().describe('"all" (default): all visible text. "article": main content only (article/main), without navigation, headers, footers, sidebars and banners.'),
    offset: z.number().int().min(0).max(100_000_000).optional().describe('Start at this character (use nextOffset from a truncated result to read the next page).'),
  }),
  // Read-only: safe to retry on timeout. (Fixes prior wire-name drift — C1.)
  idempotent: true,
  timeoutMs: 15_000,
  handler: forwardHandler('browser_text'),
};
