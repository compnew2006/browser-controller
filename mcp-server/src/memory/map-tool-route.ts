import type { RoutedCallResult } from '../vault/daemon-routing.js';
import { CONTEXT_ACTION, contextFailure, fail, type MemoryToolBridge, type MemoryToolHost } from './tool-route.js';
import { isRecord } from '../core/guards.js';
import { ERROR_CODES, formatError } from '../core/error-codes.js';

const CURSOR = /^p\d{1,4}$/u;

/** Validates the agent's arguments; IPC clients other than the MCP server skip the zod schema. */
function parseArguments(params: Record<string, unknown>): { tabId?: number; origin?: string; query?: string; cursor?: string } | string {
  const unknown = Object.keys(params).filter((key) => !['tabId', 'origin', 'query', 'cursor'].includes(key));
  if (unknown.length) return formatError(ERROR_CODES.INVALID_ARGUMENT, 'browser_site_map takes tabId or origin, query and cursor only');
  const { tabId, origin, query, cursor } = params;
  if ((tabId === undefined) === (origin === undefined)) return formatError(ERROR_CODES.INVALID_ARGUMENT, 'give exactly one of tabId and origin');
  if (tabId !== undefined && (typeof tabId !== 'number' || !Number.isInteger(tabId) || tabId < 0)) return formatError(ERROR_CODES.INVALID_ARGUMENT, 'tabId must be a non-negative integer');
  if (origin !== undefined && (typeof origin !== 'string' || origin.length === 0 || origin.length > 300)) return formatError(ERROR_CODES.INVALID_ARGUMENT, 'origin must be a string of at most 300 characters');
  if (query !== undefined && (typeof query !== 'string' || query.trim().length === 0 || query.length > 100)) return formatError(ERROR_CODES.INVALID_ARGUMENT, 'query must be 1-100 characters');
  if (cursor !== undefined && (typeof cursor !== 'string' || !CURSOR.test(cursor))) return formatError(ERROR_CODES.INVALID_ARGUMENT, 'cursor is not valid');
  return {
    ...(typeof tabId === 'number' ? { tabId } : {}),
    ...(typeof origin === 'string' ? { origin } : {}),
    ...(typeof query === 'string' ? { query } : {}),
    ...(typeof cursor === 'string' ? { cursor } : {}),
  };
}

/**
 * `browser_site_map` (specs/004-site-navigation-map R-16). With `tabId` it refuses first while memory is off or
 * unsupported, so nothing is read from the tab; otherwise it reads the tab's context under the normal tab lock,
 * as browser_memory does. With `origin` nothing is read from the browser: MemoryService takes the profile from
 * the session's connection. `sanitize` is the vault's output scrub.
 */
export async function routeSiteMapTool(
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
  let siteContext: unknown = null;
  let connectionIdBefore: string | null = null;
  if (args.tabId !== undefined) {
    const prepared = memory.prepareTool(sessionId, 'read');
    if ('error' in prepared) return fail(prepared.error);
    connectionIdBefore = prepared.connectionId;
    try {
      const raw = await bridge.callTool(CONTEXT_ACTION, { tabId: args.tabId }, sessionId, signal, agentName);
      siteContext = isRecord(raw) ? raw.siteContext ?? null : null;
    } catch (error) {
      return fail(contextFailure(error));
    }
  }
  try {
    const answer = await memory.handleTool('browser_site_map', args, sessionId, { siteContext, connectionIdBefore });
    if (!isRecord(answer)) return fail(formatError(ERROR_CODES.MAP_UNAVAILABLE, 'the site map returned no answer'));
    if (answer.success === false) return fail(typeof answer.error === 'string' ? answer.error : formatError(ERROR_CODES.MAP_UNAVAILABLE, 'the site map failed'));
    return { success: true, result: await sanitize(answer) };
  } catch {
    return fail(formatError(ERROR_CODES.MAP_UNAVAILABLE, 'the site map failed'));
  }
}
