import { z } from 'zod';
import type { ToolDefinition, ToolHost, ToolResult } from './types.js';
import { tabIdParam, forwardHandler } from './types.js';
import { enforceActionSafety, summaryOf, withReceipt } from './action-support.js';

const forwardEvaluate = forwardHandler('browser_evaluate');

// Page code cannot be classified, so with safety mode on it follows the tab's site action (siteRules, else default).
const handler = async (host: ToolHost, params: Record<string, unknown>): Promise<ToolResult> => {
  const blocked = await enforceActionSafety(host, 'browser_evaluate', params);
  if (blocked) return withReceipt(blocked, 'browser_evaluate', { status: 'not_dispatched', summary: summaryOf(blocked) }, false);
  return forwardEvaluate(host, params);
};
(handler as { toolName?: string }).toolName = 'browser_evaluate';

export const evaluateTool: ToolDefinition = {
  name: 'browser_evaluate',
  summary: 'Run JavaScript in the page (top-level await)',
  description: 'Run JavaScript in the tab; expressions return values, statements use return. Top-level await works. Uses CDP, then scripting if needed. Prefer click/type; browser_safety applies the site\'s rule.',
  inputSchema: z.object({
    tabId: tabIdParam,
    expression: z.string(),
    // The handler floors the budget at 1000 ms (extension/handlers/evaluate.js), so 1000 is the smallest honest value.
    timeout: z.number().int().min(1000).max(30_000).optional(),
  }).strict(),
  // Arbitrary page code: never retried.
  idempotent: false,
  // Must exceed the largest `timeout` so the page-side budget decides.
  timeoutMs: 35_000,
  handler,
};
