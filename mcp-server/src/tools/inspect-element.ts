import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { tabIdParam, targetParam, forwardHandler } from './types.js';

export const inspectElementTool: ToolDefinition = {
  name: 'browser_inspect_element',
  summary: 'Computed styles, matching CSS rules and event listeners',
  description: 'Why an element looks or behaves as it does: computed styles that differ from defaults; properties picks some ("*" = all); rules and listeners use the debugger.',
  inputSchema: z.object({
    tabId: tabIdParam,
    target: targetParam,
    properties: z.array(z.string().min(1).max(64)).max(100).optional(),
    rules: z.boolean().optional(),
    listeners: z.boolean().optional(),
  }).strict(),
  // Read-only: safe to retry.
  idempotent: true,
  timeoutMs: 15_000,
  handler: forwardHandler('browser_inspect_element'),
};
