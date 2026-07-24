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
