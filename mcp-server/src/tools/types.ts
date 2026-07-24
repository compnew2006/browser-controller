import { z } from 'zod';

/**
 * Minimal structural host a tool handler needs. Both {@link ExtensionBridge}
 * (used by the daemon, which owns the extension WS server) and the thin MCP
 * client's DaemonClient satisfy this, so the same tool definitions work in
 * either context.
 */
export interface ToolHost {
  callTool(tool: string, params: Record<string, unknown>): Promise<unknown>;
}

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
  isError?: boolean;
}

/**
 * Reusable `tabId` schema fields. Plan task 1.1: every page-interaction tool
 * MUST target a specific tab (the agent gets the id from `browser_tabs list`)
 * so the active tab the user is looking at never gets hijacked.
 */
export const tabIdParam = z
  .number()
  .int()
  .describe(
    'Target tab id (from browser_tabs list). Actions apply to THIS tab, not the active tab.',
  );

/** Mandatory tabId (click/type/snapshot/…). */
export function requireTabId() {
  return tabIdParam;
}

/** Optional tabId — for tools like navigate where "active tab" is still acceptable. */
export function optionalTabId() {
  return tabIdParam.optional().describe('Target tab id. If omitted, uses the active tab.');
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  handler: (host: ToolHost, params: Record<string, unknown>) => Promise<ToolResult>;
  /**
   * Whether re-running this tool with the same params has no side effects.
   * Drives the bridge's retry-on-timeout policy. Default `false` — a click must
   * never fire twice. Tools that only read (snapshot/screenshot/text/find/
   * console/network) opt in here, NOT in a separate string set that can drift.
   *
   * NOTE: `browser_console`/`browser_network` mutate state when `clear:true`,
   * so they are `false` despite "looking" like reads.
   */
  idempotent?: boolean;
  /**
   * Per-tool transport timeout in ms (bridge → extension round-trip). Falls
   * back to the bridge default (30s) when omitted. Co-located with `idempotent`
   * so the tool registry is the single source of transport policy.
   */
  timeoutMs?: number;
}

export function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

export function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

export function imageResult(base64: string, mimeType = 'image/png'): ToolResult {
  return { content: [{ type: 'image', data: base64, mimeType }] };
}
