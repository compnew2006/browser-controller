import { z } from 'zod';
import { requireTabId, textResult } from './types.js';
export const snapshotTool = {
    name: 'browser_snapshot',
    summary: 'Get the accessibility tree with element refs', description: 'Get an accessibility tree snapshot of the page. Returns element refs you can use with click, type, and other tools. Use compact mode (default) for smaller output - only interactive elements.',
    inputSchema: z.object({
        tabId: requireTabId(),
        selector: z.string().optional().describe('CSS selector to scope the snapshot'),
        compact: z.boolean().optional().default(true).describe('When true (default), returns only interactive elements with minimal nesting. Set false for full tree.'),
    }),
    // Read-only (refs are deterministic given a stable DOM): safe to retry.
    idempotent: true,
    async handler(bridge, params) {
        const result = await bridge.callTool('browser_snapshot', params);
        return textResult(JSON.stringify(result));
    },
};
//# sourceMappingURL=snapshot.js.map