import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, textResult } from './types.js';

export const consoleTool: ToolDefinition = {
  name: 'browser_console',
  description: 'Read console messages (log, warn, error) captured from a specific tab',
  inputSchema: z.object({
    tabId: requireTabId(),
    clear: z.boolean().optional().default(false).describe('Clear this tab\'s messages after reading'),
  }),
  // NOT idempotent: `clear:true` mutates the buffer. A timeout-retry would
  // return an empty buffer (first call already cleared it) and silently lose
  // the original messages. See audit M2.
  idempotent: false,
  async handler(bridge, params) {
    const result = await bridge.callTool('browser_console', params);
    return textResult(JSON.stringify(result, null, 2));
  },
};
