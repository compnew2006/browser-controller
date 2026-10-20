import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, forwardHandler } from './types.js';

export const actTool: ToolDefinition = {
  name: 'browser_act',
  description:
    'Act on a browser_observe snapshot (snapshotId + ref). Refuses stale, hidden, disabled or covered targets: observe again on DOCUMENT_CHANGED / STALE_STATE / TARGET_OCCLUDED / ACTION_NOT_ALLOWED.',
  inputSchema: z.object({
    tabId: requireTabId(),
    snapshotId: z.string().min(1),
    action: z.enum(['click', 'type', 'select', 'hover', 'scroll', 'keypress', 'focus', 'upload']),
    ref: z.string().min(1).optional().describe('Optional only for page scroll'),
    text: z.string().optional().describe('type'),
    clear: z.boolean().optional().default(false),
    value: z.string().optional().describe('select'),
    label: z.string().optional().describe('select'),
    index: z.number().int().min(0).max(10_000).optional().describe('select'),
    key: z.string().min(1).optional().describe('keypress'),
    modifiers: z.array(z.enum(['ctrl', 'alt', 'shift', 'meta'])).optional(),
    deltaX: z.number().optional(),
    deltaY: z.number().optional().describe('Default 500 when no delta is given'),
    filePath: z.string().min(1).optional().describe('upload'),
    files: z.array(z.string().min(1)).min(1).optional().describe('upload'),
  }),
  idempotent: false,
  timeoutMs: 15_000,
  handler: forwardHandler('browser_act'),
};
