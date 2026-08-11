import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, textResult } from './types.js';

export const runActionTool: ToolDefinition = {
  name: 'browser_run_action',
  summary: 'Run arbitrary JS via CDP (bypasses CSP)',
  description:
    'Run a self-contained JavaScript action object in the page context via CDP. The code must be an expression that evaluates to an object with an execute(params) method. Returns the action result directly. Bypasses CSP restrictions. USE THIS (not browser_evaluate) when you must read/write DOM, call an internal API (fetch), or read cookies on a strict-CSP SPA where browser_evaluate returns null. Shows a yellow "is being debugged" banner — if you must avoid it, try browser_evaluate first. Prefer the dedicated tools (browser_click/browser_type/browser_snapshot) over hand-written JS for those specific tasks.',
  inputSchema: z.object({
    tabId: requireTabId(),
    code: z
      .string()
      .describe(
        'JavaScript expression that evaluates to an action object with an execute(params) function. E.g. ({ name: "my-action", execute: function(p) { return { content: [{ type: "text", text: document.title }] }; } })',
      ),
    actionParams: z
      .record(z.string(), z.unknown())
      .optional()
      .default({})
      .describe('Parameters to pass to the action execute() function'),
  }),
  timeoutMs: 30_000,
  async handler(bridge, params) {
    const result = await bridge.callTool('browser_run_action', params);
    return textResult(JSON.stringify(result));
  },
};
