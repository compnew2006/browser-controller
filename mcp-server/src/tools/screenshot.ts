import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, imageResult, jsonError, payloadOf } from './types.js';

export const screenshotTool: ToolDefinition = {
  name: 'browser_screenshot',
  summary: 'Capture a screenshot of a tab',
  description: 'Capture a screenshot of a tab over CDP. Use maxWidth / scale and format:"jpeg" to shrink the image (far fewer tokens); fullPage captures the whole scrollable page; region zooms into a rectangle. The result says how image pixels map to the x/y that click/hover/scroll take. A background tab is shown for a moment and the user\'s tab is switched straight back (Chrome does not paint hidden tabs). The agent\'s blue control frame is never in the picture.',
  inputSchema: z.object({
    tabId: requireTabId(),
    format: z.enum(['png', 'jpeg']).optional().default('png'),
    quality: z.number().min(0).max(100).optional().default(80).describe('JPEG quality (ignored for PNG)'),
    scale: z.number().min(0.05).max(4).optional().describe('Downscale factor, e.g. 0.5 = half size (max 1 for the viewport/page; up to 4 to zoom into a region, default 2 there)'),
    region: z.object({
      x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive(),
    }).optional().describe('Capture only this viewport rectangle (CSS px, the same coordinates click/hover/scroll x/y use) — zoom in on small UI'),
    maxWidth: z.number().int().min(100).max(4000).optional().describe('Cap the image width in pixels (keeps aspect ratio), e.g. 1024'),
    fullPage: z.boolean().optional().default(false).describe('Capture the whole scrollable page, not just the viewport'),
  }),
  // Read-only: safe to retry.
  idempotent: true,
  timeoutMs: 15_000,
  async handler(bridge, params) {
    let result;
    try {
      result = await bridge.callTool('browser_screenshot', params) as {
        success: boolean;
        format: string;
        data?: string;
        width?: number;
        height?: number;
        frame?: { scale: number; origin: [number, number]; viewport: [number, number]; page?: boolean };
      };
    } catch (err) {
      // Unified error channel: surface a payload-carrying rejection intact.
      const payload = payloadOf(err);
      if (payload !== undefined) return jsonError(payload);
      throw err;
    }
    if (result.data) {
      const mimeType = result.format === 'jpeg' ? 'image/jpeg' : 'image/png';
      const image = imageResult(result.data, mimeType);
      // Coordinate frame so a point seen in the image maps to click/hover/scroll x/y.
      if (result.frame) {
        const f = result.frame;
        const map = f.page
          ? `page coords = imagePx / ${f.scale} (scroll first; viewport y = pageY - ${(f as { scrollY?: number }).scrollY ?? 0})`
          : `x = ${f.origin[0]} + imageX / ${f.scale}, y = ${f.origin[1]} + imageY / ${f.scale}`;
        image.content.push({ type: 'text', text: JSON.stringify({ image: [result.width, result.height], viewport: f.viewport, toViewport: map }) });
      }
      return image;
    }
    // "Captured but no data" is a failure — the agent must not treat an
    // empty screenshot as success (audit: misleading success-shaped error).
    return jsonError({ success: false, error: 'Screenshot captured but no image data returned' });
  },
};
