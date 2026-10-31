import type { RoutedCallResult } from '../vault/daemon-routing.js';
import { canonicalOrigin } from './policy.js';
import { isRecord } from '../core/guards.js';
import { ERROR_CODES, formatError } from '../core/error-codes.js';

/** The tab-context action the daemon sends to the extension; see DAEMON_ONLY_WIRE_TOOLS in wire-tools.ts. */
export const CONTEXT_ACTION = 'browser_memory_internal_context';
const KINDS = new Set(['all', 'facts', 'visits']);

export interface MemoryToolBridge {
  callTool(tool: string, params: Record<string, unknown>, sessionId: string, signal: AbortSignal, agentName: string): Promise<unknown>;
}

/** What the daemon hands MemoryService.handleTool besides the validated agent arguments. */
export interface MemoryToolContext {
  /** The tab's siteContext from the extension, or null when it sent none. Never agent-supplied. */
  siteContext: unknown;
  /** The session's extension connection when the tab read started; handleTool compares it with the one after (R-04). */
  connectionIdBefore: string | null;
}

/** `prepareTool` purposes: `read` is browser_memory and refuses while memory is off; `policy` only takes the connection. */
export type MemoryToolPurpose = 'read' | 'policy';

export interface MemoryToolHost {
  /**
   * Runs before any tab read. A refusal (`CODE: message`) means the extension is not called at all: no tab lock,
   * no shield, no probe. Otherwise it gives the connection the read starts on.
   */
  prepareTool(sessionId: string, purpose: MemoryToolPurpose): { connectionId: string | null } | { error: string };
  handleTool(tool: string, params: Record<string, unknown>, sessionId: string, context: MemoryToolContext): Promise<unknown>;
}

export const fail = (error: string): RoutedCallResult => ({ success: false, error });

/** Validates the agent's arguments; IPC clients other than the MCP server skip the zod schema. */
function parseArguments(params: Record<string, unknown>): { tabId: number; kind?: string; cursor?: string } | string {
  const unknown = Object.keys(params).filter((key) => key !== 'tabId' && key !== 'kind' && key !== 'cursor');
  if (unknown.length) return formatError(ERROR_CODES.INVALID_ARGUMENT, 'browser_memory takes tabId, kind and cursor only');
  const { tabId, kind, cursor } = params;
  if (typeof tabId !== 'number' || !Number.isInteger(tabId) || tabId < 0) return formatError(ERROR_CODES.INVALID_ARGUMENT, 'tabId must be a non-negative integer');
  if (kind !== undefined && (typeof kind !== 'string' || !KINDS.has(kind))) return formatError(ERROR_CODES.INVALID_ARGUMENT, 'kind must be all, facts or visits');
  if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 64)) return formatError(ERROR_CODES.INVALID_ARGUMENT, 'cursor must be a string of at most 64 characters');
  return { tabId, ...(kind !== undefined ? { kind } : {}), ...(cursor !== undefined ? { cursor } : {}) };
}

/** Failure text for a refused or failed context read. Only the code survives; no page text. */
export function contextFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith(`${ERROR_CODES.TAB_LOCKED}:`)) return message.slice(0, 300);
  if (/Unknown tool/i.test(message)) return formatError(ERROR_CODES.MEMORY_NOT_SUPPORTED, 'the browser extension does not support website memory');
  return formatError(ERROR_CODES.MEMORY_UNAVAILABLE, 'website memory could not read the tab');
}

/**
 * `browser_memory`: refuse first while memory is off or unsupported, so nothing is read from the tab; otherwise
 * read the tab's context from the extension under the normal tab lock (AC-12), then let MemoryService answer. The agent's own arguments never carry the context. `sanitize` is the
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
  const prepared = memory.prepareTool(sessionId, 'read');
  if ('error' in prepared) return fail(prepared.error);
  let raw: unknown;
  try {
    raw = await bridge.callTool(CONTEXT_ACTION, { tabId: args.tabId }, sessionId, signal, agentName);
  } catch (error) {
    return fail(contextFailure(error));
  }
  const siteContext = isRecord(raw) ? raw.siteContext ?? null : null;
  try {
    const answer = await memory.handleTool('browser_memory', args, sessionId, { siteContext, connectionIdBefore: prepared.connectionId });
    if (!isRecord(answer)) return fail(formatError(ERROR_CODES.MEMORY_UNAVAILABLE, 'website memory returned no answer'));
    if (answer.success === false) return fail(typeof answer.error === 'string' ? answer.error : formatError(ERROR_CODES.MEMORY_UNAVAILABLE, 'website memory failed'));
    return { success: true, result: await sanitize(answer) };
  } catch {
    return fail(formatError(ERROR_CODES.MEMORY_UNAVAILABLE, 'website memory failed'));
  }
}

export const unknownScope = (reason: string): RoutedCallResult => fail(formatError(ERROR_CODES.MEMORY_SCOPE_UNKNOWN, reason));

/**
 * The tab's canonical origin, read from the browser under the normal tab lock. A private tab, a frame that is
 * not the top document or a non-http page has no origin to act on. The agent never supplies an origin.
 */
export async function resolveTab(
  bridge: MemoryToolBridge,
  sessionId: string,
  agentName: string,
  tabId: number,
  signal: AbortSignal,
): Promise<{ origin: string; siteContext: unknown } | RoutedCallResult> {
  let raw: unknown;
  try {
    raw = await bridge.callTool(CONTEXT_ACTION, { tabId }, sessionId, signal, agentName);
  } catch (error) {
    return fail(contextFailure(error));
  }
  const siteContext = isRecord(raw) ? raw.siteContext ?? null : null;
  if (!isRecord(siteContext) || typeof siteContext.url !== 'string') return unknownScope("this tab's site could not be verified, so nothing was changed.");
  if (siteContext.incognito !== false) return unknownScope('a private tab has no website memory, so nothing was changed.');
  if (siteContext.topLevel !== true) return unknownScope('the page is not a top-level document, so nothing was changed.');
  const origin = canonicalOrigin(siteContext.url);
  return origin ? { origin, siteContext } : unknownScope('the page is not an http or https site, so nothing was changed.');
}
