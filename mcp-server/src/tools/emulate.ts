import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, forwardHandler } from './types.js';

export const emulateTool: ToolDefinition = {
  name: 'browser_emulate',
  summary: 'Emulate network, CPU, location, color scheme or user agent in a tab',
  description:
    'Emulate conditions in one tab through its debugger session: network ("offline", "slow-3g", "fast-3g", "none"), cpuThrottling (1 = off, 4 = 4× slower), geolocation {latitude, longitude, accuracy} (null clears; the page still needs location permission), colorScheme / reducedMotion (the prefers-color-scheme / prefers-reduced-motion media features), userAgent ("" clears). Settings merge with what is already active and last while the session stays attached (yellow debugger banner); reset:true clears them all. With no setting it only reports what is active.',
  inputSchema: z.object({
    tabId: requireTabId(),
    network: z.enum(['offline', 'slow-3g', 'fast-3g', 'none']).optional().describe('Network throttling preset; "none" removes it'),
    cpuThrottling: z.number().min(1).max(20).optional().describe('CPU slowdown factor; 1 removes it'),
    geolocation: z.object({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      accuracy: z.number().positive().optional(),
    }).nullable().optional().describe('Position the page sees (needs location permission); null clears'),
    colorScheme: z.enum(['light', 'dark', 'none']).optional().describe('prefers-color-scheme; "none" removes it'),
    reducedMotion: z.enum(['reduce', 'none']).optional().describe('prefers-reduced-motion; "none" removes it'),
    userAgent: z.string().max(1000).optional().describe('User-Agent override; "" clears'),
    reset: z.boolean().optional().describe('Clear every override (detaches the debugger session)'),
  }),
  // Side effects on the page's environment: never auto-retried.
  idempotent: false,
  timeoutMs: 10_000,
  handler: forwardHandler('browser_emulate'),
};
