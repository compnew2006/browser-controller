import { z } from 'zod';
import { textResult } from './types.js';
export const tabsTool = {
    name: 'browser_tabs',
    summary: 'List, create, close, focus, lock, or unlock tabs', description: 'Manage browser tabs: list, create, close, focus, or lock. list requires no tabId. lock/unlock claim a tab for the calling agent so other agents queue behind it instead of racing (see browser_tabs lock).',
    inputSchema: z.object({
        action: z
            .enum(['list', 'create', 'close', 'focus', 'lock', 'unlock'])
            .describe('Tab action'),
        tabId: z.number().optional().describe('Tab ID (required for close/focus/lock/unlock)'),
        url: z.string().optional().describe('URL for create action'),
    }),
    async handler(bridge, params) {
        const result = await bridge.callTool('browser_tabs', params);
        return textResult(JSON.stringify(result));
    },
};
//# sourceMappingURL=tabs.js.map