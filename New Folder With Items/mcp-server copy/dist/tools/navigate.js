import { z } from 'zod';
import { optionalTabId, textResult } from './types.js';
export const navigateTool = {
    name: 'browser_navigate',
    summary: 'Navigate a tab to a URL (+ optional inline snapshot)', description: 'Navigate to a URL in a browser tab. If tabId is omitted, navigates the active tab (or use browser_tabs create to open a new one). By default also returns a compact snapshot of the new page so you can act immediately; set snapshot:false to skip it and save tokens.',
    inputSchema: z.object({
        url: z.string().describe('The URL to navigate to'),
        tabId: optionalTabId(),
        waitUntil: z
            .enum(['load', 'domcontentloaded'])
            .optional()
            .default('load')
            .describe('When to consider navigation complete'),
        snapshot: z
            .boolean()
            .optional()
            .default(true)
            .describe('Return an inline snapshot of the new page (default true). Set false to save tokens when you will call browser_snapshot yourself.'),
    }),
    async handler(bridge, params) {
        const result = await bridge.callTool('browser_navigate', params);
        return textResult(JSON.stringify(result));
    },
};
//# sourceMappingURL=navigate.js.map