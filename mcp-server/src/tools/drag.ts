import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, forwardHandler } from './types.js';

export const dragTool: ToolDefinition = {
  name: 'browser_drag',
  description:
    'Drag from an element (startRef/startSelector) or point (startX/startY) to another, with real mouse events.',
  inputSchema: z.object({
    tabId: requireTabId(),
    startRef: z.string().optional(),
    startSelector: z.string().optional(),
    endRef: z.string().optional(),
    endSelector: z.string().optional(),
    startX: z.number().optional(),
    startY: z.number().optional(),
    endX: z.number().optional(),
    endY: z.number().optional(),
    steps: z.number().int().min(1).max(200).optional().default(10).describe('Intermediate mouse moves'),
  }),
  timeoutMs: 10_000,
  handler: forwardHandler('browser_drag'),
};
