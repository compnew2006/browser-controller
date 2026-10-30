import { z } from "zod";
import { explainNoWindow, isNoWindow } from "./browser-selection.js";

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
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  isError?: boolean;
}

/**
 * Reusable `tabId` schema fields. Plan task 1.1: every page-interaction tool
 * MUST target a specific tab (the agent gets the id from `browser_tabs list`)
 * so the active tab the user is looking at never gets hijacked.
 */
// Integer checked by refine, not .int(): .int() publishes ±2^53 bounds in the
// JSON schema of all 34 tools that take a tabId (~850 tokens per tools/list).
export const tabIdParam = z
  .number()
  .refine(Number.isInteger, "tabId must be an integer");

/** Backward-compatible locator: the existing string grammar or an exact role/name match. */
export const targetParam = z.union([
  z.string(),
  z.object({
    role: z.string().min(1).max(80),
    name: z.string().min(1).max(500),
    // Integer checked by refine, not .int(), for the same reason as tabId above.
    nth: z.number().refine(Number.isInteger, "nth must be an integer").min(0).optional()
      .describe("Zero-based index when several exact matches exist"),
  }).strict(),
]).describe("Locator string or exact accessible role/name object; name matching is case-insensitive and nth is zero-based.");

export interface ToolDefinition {
  name: string;
  /** One-line summary (10-80 chars), kept with each definition for registry checks and docs. */
  summary: string;
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  handler: (
    host: ToolHost,
    params: Record<string, unknown>,
  ) => Promise<ToolResult>;
  /**
   * Whether re-running this tool with the same params has no side effects.
   * Drives the bridge's retry-on-timeout policy. Default `false` — a click must
   * never fire twice. Tools that only read (snapshot/text/screenshot/inspect_element)
   * opt in here, NOT in a separate string set that can drift.
   *
   * NOTE: `browser_logs` mutates state when `clear:true`, so it is `false`
   * despite "looking" like a read.
   */
  idempotent?: boolean;
  /**
   * Per-tool transport timeout in ms (bridge → extension round-trip). Falls
   * back to the bridge default (30s) when omitted. Co-located with `idempotent`
   * so the tool registry is the single source of transport policy. A tool the
   * server runs itself (browser_batch) never reaches the bridge: its value is
   * the tool's own time budget, not a transport timeout.
   */
  timeoutMs?: number;
  /**
   * Reads names an agent brings from other browser tools (Playwright's `text`, a screenshot
   * `scale`) as this tool's own, before validation. Returns the params to validate and the
   * note lines the result carries, so the agent learns the 3.0 form without a failed call.
   */
  normalize?: (params: Record<string, unknown>) => { params: Record<string, unknown>; notes: string[] };
}

export function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

/** A failed call: the text is `CODE: message`, and the MCP result has isError set. */
export function failureResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * 2.x parameter names that 3.0 removed or renamed, with what to use instead.
 * One map for every tool: an unknown key found here gets its replacement in
 * the error. No 3.0 tool takes any of these names (tests/tools/schema-strict.test.ts).
 * Each hint is a plain phrase, so the caller can wrap it in parentheses or after a colon.
 */
const UNKNOWN_PARAMETER_HINTS = new Map<string, string>([
  ["ref", "use target with the ref from browser_snapshot"],
  ["selector", "use target with a CSS selector"],
  ["toElement", "use target"],
  ["x", 'use target as "x,y" in viewport CSS px'],
  ["y", 'use target as "x,y" in viewport CSS px'],
  ["doubleClick", "use count: 2"],
  ["clickCount", "use count"],
  ["trusted", "input is always trusted, so drop it"],
  ["direction", "use dy or dx in px"],
  ["amount", "use dy or dx in px"],
  ["delay", "use ms"],
  ["urlIncludes", "use url"],
  ["maxLength", "use maxChars"],
  ["fullPage", "screenshots cover the viewport, so use region to crop"],
  ["format", "screenshots are always JPEG"],
  ["quality", "screenshots are always JPEG"],
  ["scale", "not a 3.0 option"],
  ["maxWidth", "not a 3.0 option"],
  ["include", "use rules and/or listeners"],
  ["fullUrls", "removed in 3.0"],
  ["bypassCache", 'use browser_navigate with url "reload"'],
  ["continueOnError", 'use onError:"continue" (a batch stops at its first failing step by default)'],
  ["captureBodies", "use bodies with requestId"],
  ["pattern", "use filter, a substring"],
  ["urlPattern", "use filter, a substring"],
  ["level", "use errors"],
  ["failed", "use errors"],
  ["mockStatus", "use status"],
  ["mockBody", "use body"],
]);

/** The 3.0 replacement for a removed 2.x parameter name, or undefined for any other name. */
export function unknownParameterHint(name: string): string | undefined {
  return UNKNOWN_PARAMETER_HINTS.get(name);
}

const CODED_MESSAGE = /^[A-Z][A-Z0-9_]+: /;

/**
 * The `CODE: message` text of a thrown error. A message that already carries a
 * code passes through; anything else is INTERNAL_ERROR. Used for failed tool
 * results and for each step of a batch, so both read the same way.
 */
export function codedMessageOf(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return CODED_MESSAGE.test(message) ? message : `INTERNAL_ERROR: ${message}`;
}

/**
 * The in-band failure payload attached to a rejection by the bridge/daemon
 * chain (unified error channel), if any. Used by forwardHandler, so both
 * failure shapes surface identically.
 */
export function payloadOf(err: unknown): unknown {
  return (err as { result?: unknown })?.result;
}

/** The extension's own result object behind each forwarded ToolResult (tabId, url, ...). Never sent to the agent. */
const rawResults = new WeakMap<ToolResult, unknown>();

/** Machine fields of a forwarded result, for the batch's tabId propagation. */
export function rawResultOf(result: ToolResult): Record<string, unknown> | undefined {
  const raw = rawResults.get(result);
  return raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
}

/** The result with note lines added to its last text; its machine fields stay attached. */
export function withNotes(result: ToolResult, notes: string[]): ToolResult {
  if (!notes.length) return result;
  const last = result.content.map((item) => item.type).lastIndexOf("text");
  const content: ToolResult["content"] = last < 0
    ? [...result.content, { type: "text", text: notes.join("\n") }]
    : result.content.map((item, i) => (i === last && item.type === "text" ? { ...item, text: `${item.text}\n${notes.join("\n")}` } : item));
  const next: ToolResult = { ...result, content };
  if (rawResults.has(result)) rawResults.set(next, rawResults.get(result));
  return next;
}

/**
 * Wire form of an extension result. Success: its `text` is the one text the
 * agent reads (JSON when there is no text), plus `image` when present.
 * Failure ({success:false}): isError, and the text is its `CODE: message`.
 * Extra fields are machine data and stay out of the content.
 */
export function outcomeOf(raw: unknown): ToolResult {
  if (raw === null || typeof raw !== "object") {
    return textResult(typeof raw === "string" ? raw : JSON.stringify(raw) ?? "");
  }
  const { image, ...fields } = raw as Record<string, unknown>;
  const failed = fields.success === false;
  const text = failed
    ? typeof fields.error === "string" ? fields.error : JSON.stringify(fields)
    : typeof fields.text === "string" ? fields.text : JSON.stringify(fields);
  const picture = image as { data?: unknown; mimeType?: unknown } | undefined;
  const content: ToolResult["content"] = [];
  if (!failed && picture && typeof picture.data === "string") {
    content.push({
      type: "image",
      data: picture.data,
      mimeType: typeof picture.mimeType === "string" ? picture.mimeType : "image/jpeg",
    });
  }
  content.push({ type: "text", text });
  const result: ToolResult = failed ? { content, isError: true } : { content };
  rawResults.set(result, raw);
  return result;
}

/**
 * Shared passthrough handler for extension-backed tools (DRY audit item #1:
 * this body was previously copy-pasted across nearly every tool file). Forwards
 * to the host and maps the result with outcomeOf.
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
export function forwardHandler(name: string) {
  const handler = async (
    host: ToolHost,
    params: Record<string, unknown>,
  ): Promise<ToolResult> => {
    try {
      return outcomeOf(await host.callTool(name, params));
    } catch (err) {
      const payload = payloadOf(err);
      if (payload !== undefined) {
        const raw = payload as Record<string, unknown>;
        const error = typeof raw.error === 'string' ? raw.error : '';
        if (isNoWindow(error)) return outcomeOf({ ...raw, error: await explainNoWindow(host, error) });
        return outcomeOf(payload);
      }
      const message = err instanceof Error ? err.message : String(err);
      if (isNoWindow(message)) return outcomeOf({ success: false, error: await explainNoWindow(host, message) });
      throw err;
    }
  };
  (handler as { toolName?: string }).toolName = name;
  return handler;
}
