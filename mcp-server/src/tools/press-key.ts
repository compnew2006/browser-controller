import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, forwardHandler } from './types.js';

export const pressKeyTool: ToolDefinition = {
  name: 'browser_press_key',
  description:
    'Press a key, a combo ("ctrl+a") or a space-separated sequence ("ArrowDown ArrowDown Enter"), repeat times. Real key events: Tab moves focus, Enter submits, arrows drive autocomplete.',
  inputSchema: z.object({
    tabId: requireTabId(),
    key: z.string(),
    repeat: z.number().int().min(1).max(100).optional(),
    modifiers: z
      .array(z.enum(['ctrl', 'alt', 'shift', 'meta']))
      .optional(),
    ref: z.string().optional().describe('Focus this element first'),
    selector: z.string().optional().describe('Focus this element first'),
    trusted: z.boolean().optional(),
  }),
  timeoutMs: 5_000,
  handler: forwardHandler('browser_press_key'),
};
