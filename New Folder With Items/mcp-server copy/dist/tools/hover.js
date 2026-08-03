import { z } from 'zod';
import { requireTabId, textResult } from './types.js';
export const hoverTool = {
    name: 'browser_hover',
    summary: 'Hover over an element', description: 'Hover over an element to trigger tooltips, dropdown menus, or hover states',
    inputSchema: z.object({
        tabId: requireTabId(),
        ref: z.string().optional().describe('Element reference from snapshot'),
        selector: z.string().optional().describe('CSS selector for the element'),
    }),
    async handler(bridge, params) {
        const result = await bridge.callTool('browser_hover', params);
        return textResult(JSON.stringify(result));
    },
};
//# sourceMappingURL=hover.js.map