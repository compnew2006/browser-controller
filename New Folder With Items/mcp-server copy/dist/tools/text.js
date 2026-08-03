import { z } from 'zod';
import { requireTabId, textResult } from './types.js';
export const textTool = {
    name: 'browser_text',
    summary: 'Extract raw text content from a page', description: 'Extract raw text content from the page or a specific element',
    inputSchema: z.object({
        tabId: requireTabId(),
        selector: z.string().optional().describe('CSS selector to scope text extraction'),
        maxLength: z.number().optional().default(5000).describe('Max text length to return (default 5000 chars ≈ 1250 tokens; raise only when you need more)'),
    }),
    // Read-only: safe to retry on timeout. (Fixes prior wire-name drift — C1.)
    idempotent: true,
    async handler(bridge, params) {
        const result = await bridge.callTool('browser_text', params);
        return textResult(JSON.stringify(result));
    },
};
//# sourceMappingURL=text.js.map