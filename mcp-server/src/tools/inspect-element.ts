import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, forwardHandler } from './types.js';

export const inspectElementTool: ToolDefinition = {
  name: 'browser_inspect_element',
  summary: 'Inspect an element: computed styles, matching CSS rules, event listeners',
  description: 'Why an element looks/behaves as it does: computed styles (non-default ones; properties picks), the CSS rules that match it, highest priority first, with file:line and overridden names, inherited and ::before/::after rules, and event listeners (own + delegated to ancestors). rules and listeners use the debugger.',
  inputSchema: z.object({
    tabId: requireTabId(),
    ref: z.string().optional(),
    selector: z.string().optional(),
    include: z.array(z.enum(['styles', 'rules', 'listeners'])).min(1).optional().describe('Default all three'),
    properties: z.array(z.string().min(1).max(64)).max(100).optional().describe('["*"] = all'),
  }),
  // Read-only: safe to retry.
  idempotent: true,
  timeoutMs: 15_000,
  handler: forwardHandler('browser_inspect_element'),
};
