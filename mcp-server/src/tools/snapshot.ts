import { z } from 'zod';
import type { ToolDefinition, ToolResult } from './types.js';
import { requireTabId, textResult, jsonError, payloadOf } from './types.js';

/** Snapshot lines go to the model as plain text: JSON would escape every quote and newline. */
export function snapshotText(r: { url?: string; title?: string; snapshot?: string; truncated?: boolean; hint?: string; query?: string }): string {
  const head = r.query !== undefined ? `Matches for "${r.query}":` : `Page: ${r.title || ''} (${r.url || ''})`;
  return [head, r.snapshot || '(nothing visible)', ...(r.hint ? [`[${r.hint}]`] : [])].join('\n');
}

export const snapshotTool: ToolDefinition = {
  name: 'browser_snapshot',
  description:
    'The page\'s controls, landmarks and headings as indented lines `role "name" [ref]` (with state, value, and row text for look-alikes; "+" marks what is new since the last snapshot). Refs work with every ref tool. query:"save button" returns only the best matches; links:true adds each link\'s target. Capped at maxChars (default 12000).',
  inputSchema: z.object({
    tabId: requireTabId(),
    query: z.string().optional().describe('Describe the element(s) to find'),
    selector: z.string().optional().describe('Only this element\'s subtree'),
    ref: z.string().optional().describe('Only this ref\'s subtree'),
    links: z.boolean().optional(),
    maxChars: z.number().int().min(500).max(200_000).optional(),
  }),
  // Read-only (refs are deterministic given a stable DOM): safe to retry.
  idempotent: true,
  timeoutMs: 15_000,
  async handler(host, params): Promise<ToolResult> {
    let r: Record<string, unknown>;
    try {
      r = await host.callTool('browser_snapshot', params) as Record<string, unknown>;
    } catch (err) {
      const payload = payloadOf(err);
      if (payload !== undefined) return jsonError(payload);
      throw err;
    }
    if (r?.success === false) return jsonError(r);
    return textResult(snapshotText(r));
  },
};
(snapshotTool.handler as { toolName?: string }).toolName = 'browser_snapshot';
