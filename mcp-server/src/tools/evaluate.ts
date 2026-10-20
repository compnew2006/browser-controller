import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, forwardHandler } from './types.js';

export const evaluateTool: ToolDefinition = {
  name: 'browser_evaluate',
  summary: 'Run JavaScript in the page (top-level await, last value returned)',
  description:
    'Execute JavaScript in a tab and return the result. Write code as in the DevTools console: top-level `await` works, several statements are fine and the value of the LAST expression is returned (no IIFE / return needed), DOM nodes come back as readable descriptions, a returned promise is awaited. Runs over CDP, so page CSP does not block it. mode:"scripting" uses chrome.scripting instead (no debugger banner, CSP-restricted, no top-level await). The result says which path ran in `via` ("cdp" or "scripting"); a page that runs past `timeout` returns TIMEOUT. Prefer browser_click/browser_type over dispatching events by hand here.',
  inputSchema: z.object({
    tabId: requireTabId(),
    expression: z.string().describe('JavaScript to run, e.g. `const r = await fetch("/api"); (await r.json()).items.length`'),
    timeout: z.number().int().min(1000).max(120_000).optional().default(30_000).describe('Max ms to wait for the result (awaits included), default 30000'),
    mode: z.enum(['cdp', 'scripting']).optional().default('cdp').describe('cdp (default) or scripting (banner-free, CSP-bound)'),
  }),
  // Must exceed the largest `timeout` so the page-side budget decides.
  timeoutMs: 125_000,
  handler: forwardHandler('browser_evaluate'),
};
