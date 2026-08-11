import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, textResult } from './types.js';

export const dialogTool: ToolDefinition = {
  name: 'browser_handle_dialog',
  summary: 'Handle or dismiss browser dialogs (alert/confirm/prompt)',  description: 'Handle JavaScript dialogs (alert, confirm, prompt). Dialogs block page interaction until handled.',
  inputSchema: z.object({
    tabId: requireTabId(),
    action: z.enum(['accept', 'dismiss']).describe('Accept or dismiss the dialog'),
    promptText: z.string().optional().describe('Text to enter for prompt() dialogs'),
  }),
  timeoutMs: 5_000,
  async handler(bridge, params) {
    const result = await bridge.callTool('browser_handle_dialog', params);
    return textResult(JSON.stringify(result));
  },
};
