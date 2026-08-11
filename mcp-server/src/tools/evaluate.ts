import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, textResult } from './types.js';

export const evaluateTool: ToolDefinition = {
  name: 'browser_evaluate',
  summary: 'Run JavaScript in the page MAIN world (CSP-restricted)',
  description:
    'Execute JavaScript in a tab and return the result. Use for DOM queries, reading page state, or any operation not covered by other tools. NOTE: runs in the page MAIN world via chrome.scripting and is CSP-restricted — on a strict-CSP SPA it may return null even for valid expressions; in that case use browser_run_action (which runs via CDP and bypasses CSP). Prefer browser_click/browser_type over dispatching events by hand here.',
  inputSchema: z.object({
    tabId: requireTabId(),
    expression: z.string().describe('JavaScript expression or code to evaluate in the page context'),
  }),
  timeoutMs: 15_000,
  async handler(bridge, params) {
    const result = await bridge.callTool('browser_evaluate', params);
    return textResult(JSON.stringify(result));
  },
};
