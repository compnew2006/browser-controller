import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, forwardHandler } from './types.js';

export const emulateTool: ToolDefinition = {
  name: 'browser_emulate',
  summary: 'Emulate network, CPU, location, color scheme or user agent in a tab',
  description:
    'Emulate in one tab: network preset, cpuThrottling, geolocation (the page still needs location permission), colorScheme, reducedMotion, userAgent. Settings merge and last while the debugger stays attached; "none" / 1 / null / "" clears one, reset:true all. If the banner is dismissed or DevTools opens, Chrome drops the overrides: the next call reports them under lost and does not re-apply them. With no setting it only reports what is active.',
  inputSchema: z.object({
    tabId: requireTabId(),
    network: z.enum(['offline', 'slow-3g', 'fast-3g', 'none']).optional(),
    cpuThrottling: z.number().min(1).max(20).optional().describe('1 = off, 4 = 4× slower'),
    geolocation: z.object({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      accuracy: z.number().positive().optional(),
    }).nullable().optional().describe('Needs location permission; null clears'),
    colorScheme: z.enum(['light', 'dark', 'none']).optional(),
    reducedMotion: z.enum(['reduce', 'none']).optional(),
    userAgent: z.string().max(1000).optional(),
    reset: z.boolean().optional(),
  }),
  // Side effects on the page's environment: never auto-retried.
  idempotent: false,
  timeoutMs: 10_000,
  handler: forwardHandler('browser_emulate'),
};
