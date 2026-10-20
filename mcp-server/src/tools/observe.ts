import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, forwardHandler } from './types.js';

export const observeTool: ToolDefinition = {
  name: 'browser_observe',
  summary: 'Observe compact actionable state for one tab',
  description:
    'Capture one atomic, compact semantic observation with snapshot ownership, document version, geometry, element state, and allowed actions. Look-alike controls (same role+name, e.g. an Edit button per table row) carry their row text as context. Use its snapshotId and refs with browser_act. An observation expires after 60 s (OBSERVATION_EXPIRED): observe again.',
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
