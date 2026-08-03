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
    content: Array<{
        type: 'text';
        text: string;
    } | {
        type: 'image';
        data: string;
        mimeType: string;
    }>;
    isError?: boolean;
}
/**
 * Reusable `tabId` schema fields. Plan task 1.1: every page-interaction tool
 * MUST target a specific tab (the agent gets the id from `browser_tabs list`)
 * so the active tab the user is looking at never gets hijacked.
 */
export declare const tabIdParam: z.ZodNumber;
/** Mandatory tabId (click/type/snapshot/…). */
export declare function requireTabId(): z.ZodNumber;
/** Optional tabId — for tools like navigate where "active tab" is still acceptable. */
export declare function optionalTabId(): z.ZodOptional<z.ZodNumber>;
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
export declare function textResult(text: string): ToolResult;
export declare function errorResult(message: string): ToolResult;
export declare function imageResult(base64: string, mimeType?: string): ToolResult;
//# sourceMappingURL=types.d.ts.map