import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { tabIdParam, targetParam, forwardHandler } from './types.js';

export const snapshotTool: ToolDefinition = {
  name: 'browser_snapshot',
  summary: 'Accessibility tree of the page with element refs',
  description: 'Accessibility tree with element refs (e12). Scope with target or query. Cut at maxChars with a note. Passwords are masked.',
  inputSchema: z.object({
    tabId: tabIdParam,
    target: targetParam.optional(),
    query: z.string().optional(),
    maxChars: z.number().int().min(200).max(50_000).optional().describe('Default 8000'),
  }).strict(),
  // Read-only (refs are deterministic given a stable DOM): safe to retry.
  idempotent: true,
  timeoutMs: 15_000,
  handler: forwardHandler('browser_snapshot'),
};
