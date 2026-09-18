import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, forwardHandler } from './types.js';

export const observeTool: ToolDefinition = {
  name: 'browser_observe',
  summary: 'Observe compact actionable state for one tab',
  description:
    'Capture one atomic, compact semantic observation with snapshot ownership, document version, geometry, element state, and allowed actions. Use its snapshotId and refs with browser_act.',
  inputSchema: z.object({
    tabId: requireTabId(),
    mode: z.enum(['compact']).optional().default('compact')
      .describe('Observation mode. Phase 1 supports compact; the field is versioned for future modes.'),
    maxElements: z.number().int().min(1).max(1000).optional().default(500)
      .describe('Maximum actionable elements returned.'),
  }),
  idempotent: true,
  timeoutMs: 10_000,
  handler: forwardHandler('browser_observe'),
};
