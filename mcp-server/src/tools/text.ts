import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, forwardHandler } from './types.js';

export const textTool: ToolDefinition = {
  name: 'browser_text',
  summary: 'Extract raw text content from a page',  description: 'Extract raw text content from the page or a specific element. Includes shadow-DOM (web component) content. mode:"article" returns only the main content (skips nav, header, footer, sidebars). Page long texts with offset.',
  inputSchema: z.object({
    tabId: requireTabId(),
    selector: z.string().optional().describe('CSS selector to scope text extraction'),
    maxLength: z.number().int().min(1).max(100_000).optional().default(5000).describe('Max text length to return (default 5000 chars ≈ 1250 tokens; raise only when you need more, max 100000)'),
    mode: z.enum(['all', 'article']).optional().describe('"all" (default): all visible text. "article": main content only (article/main), without navigation, headers, footers, sidebars and banners.'),
    offset: z.number().int().min(0).optional().describe('Start at this character (use nextOffset from a truncated result to read the next page).'),
  }),
  // Read-only: safe to retry on timeout. (Fixes prior wire-name drift — C1.)
  idempotent: true,
  timeoutMs: 15_000,
  handler: forwardHandler('browser_text'),
};
