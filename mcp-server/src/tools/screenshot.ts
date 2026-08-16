import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, imageResult, jsonError, payloadOf } from './types.js';

export const screenshotTool: ToolDefinition = {
  name: 'browser_screenshot',
  summary: 'Capture a screenshot of a tab',  description: 'Capture a screenshot of a tab. Note: Chrome screenshots the tab\'s window, so the tab must be the active one in its window; if it is not, the tool activates it first.',
  inputSchema: z.object({
    tabId: requireTabId(),
    format: z.enum(['png', 'jpeg']).optional().default('png'),
    quality: z.number().min(0).max(100).optional().default(80).describe('JPEG quality (ignored for PNG)'),
  }),
  // Read-only: safe to retry.
  idempotent: true,
  timeoutMs: 10_000,
  async handler(bridge, params) {
    let result;
    try {
      result = await bridge.callTool('browser_screenshot', params) as {
        success: boolean;
        format: string;
        data?: string;
      };
    } catch (err) {
      // Unified error channel: surface a payload-carrying rejection intact.
      const payload = payloadOf(err);
      if (payload !== undefined) return jsonError(payload);
      throw err;
    }
    if (result.data) {
      const mimeType = result.format === 'jpeg' ? 'image/jpeg' : 'image/png';
      return imageResult(result.data, mimeType);
    }
    // "Captured but no data" is a failure — the agent must not treat an
    // empty screenshot as success (audit: misleading success-shaped error).
    return jsonError({ success: false, error: 'Screenshot captured but no image data returned' });
  },
};
