import { z } from 'zod';
import { requireTabId, textResult } from './types.js';
export const pressKeyTool = {
    name: 'browser_press_key',
    summary: 'Press a keyboard key (Enter, Tab, Escape, etc.)', description: 'Press a keyboard key or combination (Enter, Escape, Tab, ArrowDown, etc). Supports modifiers like Ctrl+A, Cmd+C.',
    inputSchema: z.object({
        tabId: requireTabId(),
        key: z.string().describe('Key name (e.g. "Enter", "Escape", "Tab", "ArrowDown", "a")'),
        modifiers: z
            .array(z.enum(['ctrl', 'alt', 'shift', 'meta']))
            .optional()
            .describe('Modifier keys to hold'),
        ref: z.string().optional().describe('Element ref to focus before pressing'),
        selector: z.string().optional().describe('CSS selector to focus before pressing'),
    }),
    async handler(bridge, params) {
        const result = await bridge.callTool('browser_press_key', params);
        return textResult(JSON.stringify(result));
    },
};
//# sourceMappingURL=press-key.js.map