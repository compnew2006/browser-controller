import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, forwardHandler } from './types.js';

export const clickTextTool: ToolDefinition = {
  name: 'browser_click_text',
  summary: 'Click an element by its visible text',  description:
    'Click an element by its visible text content (case-insensitive, CSS text-transform does not matter). Matches accessible names, aria-label/title and composed text including shadow DOM and same-origin iframes, then clicks the control that owns the text (e.g. the <button> around a <span>) with a real (trusted) mouse click. Works on React dropdowns, portals, and overlays that may not appear in snapshots. CSP-safe (no eval).',
  inputSchema: z.object({
    tabId: requireTabId(),
    text: z.string().describe('Text to match against the element name or visible text'),
    index: z.number().int().min(0).optional().describe('Which match to click if multiple (0-based, default 0)'),
    exact: z.boolean().optional().describe('Require the whole text to match (case-insensitive) instead of a substring (default false)'),
    trusted: z.boolean().optional().describe('Real CDP mouse click (default true). false = synthetic DOM events.'),
  }),
  timeoutMs: 10_000,
  handler: forwardHandler('browser_click_text'),
};
