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
  /**
   * One-line summary (max ~60 chars) used by progressive disclosure: the
   * `browser_tools` meta tool returns this instead of the full description
   * when listing/searching. Must be concise enough that 22 of them fit in
   * ~400 tokens (vs ~4200 for full definitions). Example: "Click an element by ref or CSS selector".
   */
  summary: string;
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

/**
 * JSON-body error result: same parseable body as textResult(JSON.stringify(…))
 * but flagged isError:true, so clients can detect failure uniformly (the same
 * contract wrapHandler enforces for thrown errors). Used by the meta tool.
 */
export function jsonError(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: true };
}

export function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

/**
 * Shared passthrough handler for extension-backed tools (DRY audit item #1:
 * this body was copy-pasted in 21 of 22 tool files). Forwards to the host and
 * JSON-wraps the result.
 *
 * Unified error channel: when the extension reports an in-band failure
 * ({success:false, ...}), the bridge/daemon reject with the payload attached
 * (`.result`); this handler surfaces that payload as an isError result so the
 * agent gets uniform failure detection AND the body (e.g. REF_GONE
 * freshRefs). Transport errors without a payload re-throw for wrapHandler.
 *
 * The returned function is tagged with its wire name — the registry's
 * drift-guard test reads the tag instead of scraping handler source (the
 * factory closes over the name, so a source regex can't see it).
 */
/**
 * The in-band failure payload attached to a rejection by the bridge/daemon
 * chain (unified error channel), if any. Shared by forwardHandler and the
 * custom screenshot handler so both surface payloads identically.
 */
export function payloadOf(err: unknown): unknown {
  return (err as { result?: unknown })?.result;
}

export function forwardHandler(name: string) {
  const handler = async (host: ToolHost, params: Record<string, unknown>): Promise<ToolResult> => {
    try {
      const result = await host.callTool(name, params);
      return textResult(JSON.stringify(result));
    } catch (err) {
      const payload = payloadOf(err);
      if (payload !== undefined) return jsonError(payload);
      throw err;
    }
  };
  (handler as { toolName?: string }).toolName = name;
  return handler;
}

export function imageResult(base64: string, mimeType = 'image/png'): ToolResult {
  return { content: [{ type: 'image', data: base64, mimeType }] };
}
