import { z } from 'zod';
import type { ToolDefinition, ToolResult } from './types.js';
import { optionalTabId, textResult, jsonError, payloadOf } from './types.js';

export const navigateTool: ToolDefinition = {
  name: 'browser_navigate',
  description: 'Go to a URL (or "back" / "forward") in a tab and return the URL it landed on and a compact snapshot (snapshot:false skips it). httpStatus appears for 4xx/5xx; a network error fails; a download or 204 returns status "not-navigated". Without tabId the active tab is used.',
  inputSchema: z.object({
    url: z.string().describe('URL, or "back" / "forward"'),
    tabId: optionalTabId(),
    waitUntil: z
      .enum(['load', 'domcontentloaded'])
      .optional()
      .default('load'),
    snapshot: z
      .boolean()
      .optional()
      .default(true)
      .describe('Inline snapshot of the new page (default true)'),
  }),
  timeoutMs: 60_000,
  async handler(host, params): Promise<ToolResult> {
    let r: Record<string, unknown>;
    try {
      r = await host.callTool('browser_navigate', params) as Record<string, unknown>;
    } catch (err) {
      const payload = payloadOf(err);
      if (payload !== undefined) return jsonError(payload);
      throw err;
    }
    if (r?.success === false) return jsonError(r);
    // The page's lines go as plain text after the status (JSON would escape every quote).
    const { snapshot, hint, ...status } = r;
    return textResult(typeof snapshot === 'string' ? [JSON.stringify(status), snapshot, ...(hint ? [`[${hint}]`] : [])].join('\n') : JSON.stringify(r));
  },
};
(navigateTool.handler as { toolName?: string }).toolName = 'browser_navigate';
