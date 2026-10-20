import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, imageResult, jsonError, payloadOf } from './types.js';

export const screenshotTool: ToolDefinition = {
  name: 'browser_screenshot',
  summary: 'Capture a screenshot of a tab',
  description: 'Screenshot a tab. The active tab is read from the screen (no debugger, no tab switch); a background tab is captured over CDP without switching to it, and shown briefly only if CDP cannot capture it. fullPage and zoomed regions use the debugger. maxWidth / scale and format:"jpeg" cut tokens; region (a viewport rectangle) or ref/selector (one element, scrolled into view). The longest side is capped at 1568 px and the image stays under 1 MB (note says when that changed the picture). The result maps image pixels to click/hover/scroll x/y. The agent\'s blue control frame is never in the picture.',
  inputSchema: z.object({
    tabId: requireTabId(),
    format: z.enum(['png', 'jpeg']).optional().default('png'),
    quality: z.number().min(0).max(100).optional().default(80).describe('JPEG only'),
    scale: z.number().min(0.05).max(4).optional().describe('Up to 1 (a region: up to 4, default 2)'),
    region: z.object({
      x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive(),
    }).optional(),
    maxWidth: z.number().int().min(100).max(4000).optional().describe('Max image width (px)'),
    fullPage: z.boolean().optional().default(false),
    ref: z.string().optional(),
    selector: z.string().optional(),
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
        element?: { clipped: boolean };
        note?: string;
        cdpFallback?: string;
      };
    } catch (err) {
      // Unified error channel: surface a payload-carrying rejection intact.
      const payload = payloadOf(err);
      if (payload !== undefined) return jsonError(payload);
      throw err;
    }
    // An element the page could not find (or that has no box) is the real error.
    if (result.success === false) return jsonError(result);
    if (result.data) {
      const mimeType = result.format === 'jpeg' ? 'image/jpeg' : 'image/png';
      const image = imageResult(result.data, mimeType);
      const meta: Record<string, unknown> = {
        image: [result.width, result.height],
        ...(result.element ? { element: result.element } : {}),
        ...(result.note ? { note: result.note } : {}),
        ...(result.cdpFallback ? { cdpFallback: result.cdpFallback } : {}),
      };
      // Coordinate frame so a point seen in the image maps to click/hover/scroll x/y.
      if (result.frame) {
        const f = result.frame;
        meta.viewport = f.viewport;
        meta.toViewport = f.page
          ? `page coords = imagePx / ${f.scale} (scroll first; viewport y = pageY - ${(f as { scrollY?: number }).scrollY ?? 0})`
          : `x = ${f.origin[0]} + imageX / ${f.scale}, y = ${f.origin[1]} + imageY / ${f.scale}`;
      }
      if (result.frame || result.note || result.cdpFallback) image.content.push({ type: 'text', text: JSON.stringify(meta) });
      return image;
    }
    // "Captured but no data" is a failure — the agent must not treat an
    // empty screenshot as success (audit: misleading success-shaped error).
    return jsonError({ success: false, error: 'Screenshot captured but no image data returned' });
  },
};
