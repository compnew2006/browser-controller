import { z } from 'zod';
import { requireTabId, textResult } from './types.js';
export const selectTool = {
    name: 'browser_select',
    summary: 'Select an option in a dropdown element', description: 'Select an option from a dropdown/select element',
    inputSchema: z.object({
        tabId: requireTabId(),
        ref: z.string().optional().describe('Element reference from snapshot'),
        selector: z.string().optional().describe('CSS selector for the select element'),
        value: z.string().optional().describe('Option value to select'),
        label: z.string().optional().describe('Option label text to select'),
        index: z.number().optional().describe('Option index to select (0-based)'),
    }),
    async handler(bridge, params) {
        const result = await bridge.callTool('browser_select', params);
        return textResult(JSON.stringify(result));
    },
};
//# sourceMappingURL=select.js.map