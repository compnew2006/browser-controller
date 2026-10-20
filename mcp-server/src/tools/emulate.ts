import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { tabIdParam, forwardHandler } from './types.js';

export const emulateTool: ToolDefinition = {
  name: 'browser_emulate',
  summary: 'Emulate viewport, network, CPU, location, theme or user agent',
  description: 'Emulate in one tab: viewport (never resizes the window), network, cpuThrottling, geolocation, colorScheme, reducedMotion, userAgent. reset:true clears all.',
  inputSchema: z.object({
    tabId: tabIdParam,
    viewport: z.object({
      width: z.number().int().min(100).max(10_000),
      height: z.number().int().min(100).max(10_000),
      deviceScaleFactor: z.number().min(0.1).max(4).optional(),
      mobile: z.boolean().optional(),
    }).strict().optional(),
    network: z.enum(['offline', 'slow-3g', 'fast-3g', 'none']).optional(),
    cpuThrottling: z.number().min(1).max(20).optional().describe('1 = off, 4 = 4x slower'),
    geolocation: z.object({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      accuracy: z.number().positive().optional(),
    }).strict().nullable().optional().describe('null clears'),
    colorScheme: z.enum(['light', 'dark', 'none']).optional(),
    reducedMotion: z.enum(['reduce', 'none']).optional(),
    userAgent: z.string().max(1000).optional(),
    reset: z.boolean().optional(),
  }).strict(),
  // Side effects on the page's environment: never auto-retried.
  idempotent: false,
  timeoutMs: 10_000,
  handler: forwardHandler('browser_emulate'),
};
