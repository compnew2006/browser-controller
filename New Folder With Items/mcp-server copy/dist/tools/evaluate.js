import { z } from 'zod';
import { requireTabId, textResult } from './types.js';
export const evaluateTool = {
    name: 'browser_evaluate',
    summary: 'Run JavaScript in the page MAIN world (CSP-restricted)', description: 'Execute JavaScript in a tab and return the result. Use for DOM queries, reading page state, or any operation not covered by other tools.',
    inputSchema: z.object({
        tabId: requireTabId(),
        expression: z.string().describe('JavaScript expression or code to evaluate in the page context'),
    }),
    async handler(bridge, params) {
        const result = await bridge.callTool('browser_evaluate', params);
        return textResult(JSON.stringify(result));
    },
};
//# sourceMappingURL=evaluate.js.map