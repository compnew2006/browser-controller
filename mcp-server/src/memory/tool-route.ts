import type { RoutedCallResult } from '../vault/daemon-routing.js';

/** The tab-context action the daemon sends to the extension; see DAEMON_ONLY_WIRE_TOOLS in wire-tools.ts. */
const CONTEXT_ACTION = 'browser_memory_internal_context';
const KINDS = new Set(['all', 'facts', 'visits']);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export interface MemoryToolBridge {
  callTool(tool: string, params: Record<string, unknown>, sessionId: string, signal: AbortSignal, agentName: string): Promise<unknown>;
}

/** What the daemon hands MemoryService.handleTool besides the validated agent arguments. */
export interface MemoryToolContext {
  /** The tab's siteContext from the extension, or null when it sent none. Never agent-supplied. */
  siteContext: unknown;
}

export interface MemoryToolHost {
  handleTool(tool: string, params: Record<string, unknown>, sessionId: string, context: MemoryToolContext): Promise<unknown>;
}

const fail = (error: string): RoutedCallResult => ({ success: false, error });

/** Validates the agent's arguments; IPC clients other than the MCP server skip the zod schema. */
function parseArguments(params: Record<string, unknown>): { tabId: number; kind?: string; cursor?: string } | string {
  const unknown = Object.keys(params).filter((key) => key !== 'tabId' && key !== 'kind' && key !== 'cursor');
  if (unknown.length) return 'INVALID_ARGUMENT: browser_memory takes tabId, kind and cursor only';
  const { tabId, kind, cursor } = params;
  if (typeof tabId !== 'number' || !Number.isInteger(tabId) || tabId < 0) return 'INVALID_ARGUMENT: tabId must be a non-negative integer';
  if (kind !== undefined && (typeof kind !== 'string' || !KINDS.has(kind))) return 'INVALID_ARGUMENT: kind must be all, facts or visits';
  if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 64)) return 'INVALID_ARGUMENT: cursor must be a string of at most 64 characters';
  return { tabId, ...(kind !== undefined ? { kind } : {}), ...(cursor !== undefined ? { cursor } : {}) };
}

/** Failure text for a refused or failed context read. Only the code survives; no page text. */
function contextFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/^TAB_LOCKED\b/.test(message)) return message.slice(0, 300);
  if (/Unknown tool/i.test(message)) return 'MEMORY_NOT_SUPPORTED: the browser extension does not support website memory';
  return 'MEMORY_UNAVAILABLE: website memory could not read the tab';
}

/**
 * `browser_memory`: read the tab's context from the extension under the normal tab lock (AC-12),
 * then let MemoryService answer. The agent's own arguments never carry the context. `sanitize` is the
 * vault's output scrub, applied to the answer like any other tool result.
 */
export async function routeMemoryTool(
  memory: MemoryToolHost,
  bridge: MemoryToolBridge,
  sessionId: string,
  agentName: string,
  params: Record<string, unknown>,
  signal: AbortSignal,
  sanitize: (value: unknown) => Promise<unknown> = async (value) => value,
): Promise<RoutedCallResult> {
  const args = parseArguments(params);
  if (typeof args === 'string') return fail(args);
  let raw: unknown;
  try {
    raw = await bridge.callTool(CONTEXT_ACTION, { tabId: args.tabId }, sessionId, signal, agentName);
  } catch (error) {
    return fail(contextFailure(error));
  }
  const siteContext = isRecord(raw) ? raw.siteContext ?? null : null;
  try {
    const answer = await memory.handleTool('browser_memory', args, sessionId, { siteContext });
    if (!isRecord(answer)) return fail('MEMORY_UNAVAILABLE: website memory returned no answer');
    if (answer.success === false) return fail(typeof answer.error === 'string' ? answer.error : 'MEMORY_UNAVAILABLE: website memory failed');
    return { success: true, result: await sanitize(answer) };
  } catch {
    return fail('MEMORY_UNAVAILABLE: website memory failed');
  }
}
