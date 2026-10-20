import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, forwardHandler } from './types.js';

export const observeTool: ToolDefinition = {
  name: 'browser_observe',
  description:
    'Compact list of actionable elements (ref, role, name, state, bbox, allowedActions) plus a snapshotId for browser_act. Capped at maxChars (default 20000, then truncated:true).',
  inputSchema: z.object({
    tabId: requireTabId(),
    mode: z.enum(['compact']).optional().default('compact'),
    maxElements: z.number().int().min(1).max(1000).optional().default(500),
    maxChars: z.number().int().min(500).max(200_000).optional().describe('Cap on the elements JSON (default 20000)'),
  }),
  idempotent: true,
  timeoutMs: 10_000,
  handler: forwardHandler('browser_observe'),
};
