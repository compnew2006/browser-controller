import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, forwardHandler } from './types.js';

export const inspectElementTool: ToolDefinition = {
  name: 'browser_inspect_element',
  summary: 'Inspect an element: computed styles, matching CSS rules, event listeners',
  description: 'Why an element looks and behaves the way it does, like the DevTools Elements panel. Returns the element (tag, id, classes, text, viewport box) plus: styles — computed values (by default the layout/visual ones that differ from their default; properties picks exact ones, ["*"] = all); rules — the author CSS rules that match it, highest priority first (element.style on top), each with its source file:line, media, declarations and overridden (lost the cascade) / invalid names, plus inherited declarations from ancestors and ::before/::after rules; listeners — event listeners on the element (type, capture/passive/once, handler source, line) and, under delegated, the event types its ancestors, the document and the window listen to. rules and listeners use the debugger (yellow banner); include:["styles"] does not.',
  inputSchema: z.object({
    tabId: requireTabId(),
    ref: z.string().optional().describe('Element ref from browser_snapshot / browser_find / browser_observe'),
    selector: z.string().optional().describe('CSS selector (first visible match) when there is no ref'),
    include: z.array(z.enum(['styles', 'rules', 'listeners'])).min(1).optional().describe('What to return (default all three)'),
    properties: z.array(z.string().min(1).max(64)).max(100).optional().describe('Computed properties to return, e.g. ["display","z-index"]; ["*"] = all of them'),
  }),
  // Read-only: safe to retry.
  idempotent: true,
  timeoutMs: 15_000,
  handler: forwardHandler('browser_inspect_element'),
};
