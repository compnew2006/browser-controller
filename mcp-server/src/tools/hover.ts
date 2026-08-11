import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, textResult } from './types.js';

export const hoverTool: ToolDefinition = {
  name: 'browser_hover',
  summary: 'Hover over an element',  description: 'Hover over an element to trigger tooltips, dropdown menus, or hover states',
  inputSchema: z.object({
    tabId: requireTabId(),
    ref: z.string().optional().describe('Element reference from snapshot'),
    selector: z.string().optional().describe('CSS selector for the element'),
  }),
  timeoutMs: 5_000,
  async handler(bridge, params) {
    const result = await bridge.callTool('browser_hover', params);
    return textResult(JSON.stringify(result));
  },
};
