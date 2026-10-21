import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { setSafetySettings, type SafetyAction } from './action-support.js';

const action = z.enum(['allow', 'ask', 'block']);
const HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/i;

export const safetyTool: ToolDefinition = {
  name: 'browser_safety',
  summary: 'Configure session rules for submit, delete and upload actions',
  description: 'Session policy for submit, delete and upload actions; ask requires client elicitation.',
  inputSchema: z.object({
    enabled: z.boolean(),
    defaultAction: action.optional(),
    siteRules: z.record(z.string().trim().min(1).max(253), action).optional(),
  }).strict().superRefine((settings, ctx) => {
    const seen = new Set<string>();
    const rules = settings.siteRules ?? {};
    for (const site of Object.keys(rules)) {
      const key = site.toLowerCase();
      if (!HOSTNAME.test(site)) ctx.addIssue({ code: 'custom', path: ['siteRules', site], message: 'site must be a hostname without a scheme or port' });
      if (seen.has(key)) ctx.addIssue({ code: 'custom', path: ['siteRules', site], message: `duplicate site rule for ${key}` });
      seen.add(key);
    }
    if (Object.keys(rules).length > 100) ctx.addIssue({ code: 'custom', path: ['siteRules'], message: 'siteRules supports at most 100 hosts' });
  }),
  timeoutMs: 10_000,
  async handler(host, params) {
    const settings = {
      enabled: params.enabled as boolean,
      defaultAction: (params.defaultAction ?? 'ask') as SafetyAction,
      siteRules: Object.entries((params.siteRules ?? {}) as Record<string, SafetyAction>).map(([site, ruleAction]) => ({ site: site.toLowerCase(), action: ruleAction })),
    };
    setSafetySettings(host, settings);
    return {
      content: [{ type: 'text', text: settings.enabled
        ? `safety mode enabled; default: ${settings.defaultAction}; site rules: ${settings.siteRules.length}`
        : 'safety mode disabled' }],
      structuredContent: { success: true, settings },
    };
  },
};
