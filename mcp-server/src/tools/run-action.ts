import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, forwardHandler } from './types.js';

export const runActionTool: ToolDefinition = {
  name: 'browser_run_action',
  summary: 'Run arbitrary JS via CDP (bypasses CSP)',
  description:
    'Run a self-contained JavaScript action object in the page context via CDP. code is an expression that evaluates to an object with an execute(params) method (called with actionParams), or a plain expression whose value is returned. Returns the action result directly. Always runs over the debugger, so page CSP does not apply and it never falls back to chrome.scripting; shows a yellow "is being debugged" banner. For plain one-off JS, browser_evaluate (also CDP by default, console-style) is simpler. Prefer the dedicated tools (browser_click/browser_type/browser_snapshot) over hand-written JS for those specific tasks.',
  inputSchema: z.object({
    tabId: requireTabId(),
    code: z
      .string()
      .describe(
        'JavaScript expression that evaluates to an action object with an execute(params) function, or a plain expression such as document.title. E.g. ({ name: "my-action", execute: function(p) { return { content: [{ type: "text", text: document.title }] }; } })',
      ),
    actionParams: z
      .record(z.string(), z.unknown())
      .optional()
      .default({})
      .describe('Parameters to pass to the action execute() function'),
  }),
  timeoutMs: 30_000,
  handler: forwardHandler('browser_run_action'),
};
