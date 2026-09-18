import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, forwardHandler } from './types.js';

export const actTool: ToolDefinition = {
  name: 'browser_act',
  summary: 'Safely act on a browser_observe snapshot ref',
  description:
    'Run a freshness-, semantics-, geometry-, visibility-, and occlusion-validated action against an immutable browser_observe snapshot. Call browser_observe again after stale/document errors.',
  inputSchema: z.object({
    tabId: requireTabId(),
    snapshotId: z.string().min(1).describe('snapshotId returned by browser_observe'),
    action: z.enum(['click', 'type', 'select', 'hover', 'scroll', 'keypress', 'focus', 'upload']),
    ref: z.string().min(1).optional().describe('Element ref from the named observation. Optional only for page scroll.'),
    text: z.string().optional().describe('Text for action:type'),
    clear: z.boolean().optional().default(false).describe('Clear the field before typing'),
    value: z.string().optional().describe('Option value for action:select'),
    label: z.string().optional().describe('Option label for action:select'),
    index: z.number().int().min(0).optional().describe('Option index for action:select'),
    key: z.string().min(1).optional().describe('Key for action:keypress'),
    modifiers: z.array(z.enum(['ctrl', 'alt', 'shift', 'meta'])).optional(),
    deltaX: z.number().optional().describe('Horizontal scroll delta'),
    deltaY: z.number().optional().describe('Vertical scroll delta; defaults to 500 when neither delta is supplied'),
    filePath: z.string().min(1).optional().describe('Local path for action:upload'),
    files: z.array(z.string().min(1)).min(1).optional().describe('Local paths for a multiple-file upload'),
  }),
  idempotent: false,
  timeoutMs: 15_000,
  handler: forwardHandler('browser_act'),
};
