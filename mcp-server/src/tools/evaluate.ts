import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { tabIdParam, forwardHandler } from './types.js';

export const evaluateTool: ToolDefinition = {
  name: 'browser_evaluate',
  summary: 'Run JavaScript in the page (top-level await)',
  description: 'Run JavaScript in the tab: one expression is the result; several statements need `return` (`const x = 2; return x * 21`). Top-level await works. Over CDP; via: scripting if the debugger cannot attach. Prefer click and type.',
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
  handler: forwardHandler('browser_evaluate'),
};
