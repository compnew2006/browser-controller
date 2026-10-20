import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, forwardHandler } from './types.js';

export const clickTextTool: ToolDefinition = {
  name: 'browser_click_text',
  summary: 'Click an element by its visible text',  description:
    'Click the control whose visible text or accessible name matches (case-insensitive; shadow DOM, same-origin iframes, portals), with a real mouse click. A hidden, disabled or covered match fails with ELEMENT_HIDDEN / ELEMENT_DISABLED / ELEMENT_COVERED and nothing is clicked.',
  inputSchema: z.object({
    tabId: requireTabId(),
    text: z.string(),
    index: z.number().int().min(0).max(1000).optional().describe('Which match (0-based)'),
    exact: z.boolean().optional().describe('Whole-text match'),
    trusted: z.boolean().optional(),
  }),
  timeoutMs: 10_000,
  handler: forwardHandler('browser_click_text'),
};
