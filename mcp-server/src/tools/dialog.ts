import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, forwardHandler } from './types.js';

export const dialogTool: ToolDefinition = {
  name: 'browser_handle_dialog',
  summary: 'Handle or dismiss browser dialogs (alert/confirm/prompt)',  description: 'Handle JavaScript dialogs (alert, confirm, prompt). Dialogs block page interaction until handled.',
  inputSchema: z.object({
    tabId: requireTabId(),
    action: z.enum(['accept', 'dismiss']).describe('Accept or dismiss the dialog'),
    promptText: z.string().optional().describe('Text to enter for prompt() dialogs'),
  }),
  timeoutMs: 5_000,
  handler: forwardHandler('browser_handle_dialog'),
};
