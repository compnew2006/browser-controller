import { randomUUID } from 'node:crypto';
import type { RoutedCallResult } from '../vault/daemon-routing.js';
import type { MemoryAdminCommand, MemoryAdminRequest, MemoryAdminResult } from '../daemon-config.js';
import { canonicalOrigin } from './policy.js';
import {
  CONTEXT_ACTION,
  contextFailure,
  fail,
  isRecord,
  routeMemoryTool,
  type MemoryToolBridge,
  type MemoryToolHost,
} from './tool-route.js';

const ACTIONS = ['enable', 'disable', 'exclude', 'include', 'inspect', 'export', 'delete'] as const;
type Action = (typeof ACTIONS)[number];
const SCOPED: ReadonlySet<Action> = new Set(['exclude', 'include', 'inspect', 'export', 'delete']);
const TEXT_MAX = 4_000;

/** The slice of MemoryService this route uses. `admin` is the one writer of policy, shared with the owner CLI. */
export interface PolicyToolHost extends MemoryToolHost {
  admin(request: MemoryAdminRequest): Promise<MemoryAdminResult>;
}

interface PolicyArguments {
  action: Action;
  tabId?: number;
  ownerConfirmed: boolean;
  confirmedOrigin?: string;
}

/** Validates the arguments; IPC clients other than the MCP server skip the zod schema. */
function parseArguments(params: Record<string, unknown>): PolicyArguments | string {
  const unknown = Object.keys(params).filter((key) => !['action', 'tabId', 'ownerConfirmed', 'confirmedOrigin'].includes(key));
  if (unknown.length) return 'INVALID_ARGUMENT: browser_memory_policy takes action and tabId only';
  const action = ACTIONS.find((candidate) => candidate === params.action);
  if (!action) return 'INVALID_ARGUMENT: action must be enable, disable, exclude, include, inspect, export or delete';
  const { tabId, ownerConfirmed, confirmedOrigin } = params;
  if (ownerConfirmed !== undefined && typeof ownerConfirmed !== 'boolean') return 'INVALID_ARGUMENT: ownerConfirmed must be a boolean';
  if (confirmedOrigin !== undefined && (typeof confirmedOrigin !== 'string' || confirmedOrigin.length > 300)) return 'INVALID_ARGUMENT: confirmedOrigin must be a string';
  if (SCOPED.has(action)) {
    if (typeof tabId !== 'number' || !Number.isInteger(tabId) || tabId < 0) return `INVALID_ARGUMENT: ${action} needs a tabId`;
  } else if (tabId !== undefined) {
    return `INVALID_ARGUMENT: ${action} covers all sites and takes no tabId`;
  }
  return {
    action,
    ...(typeof tabId === 'number' ? { tabId } : {}),
    ownerConfirmed: ownerConfirmed === true,
    ...(typeof confirmedOrigin === 'string' ? { confirmedOrigin } : {}),
  };
}

const unknownScope = (reason: string): RoutedCallResult => fail(`MEMORY_SCOPE_UNKNOWN: ${reason}`);

/**
 * The tab's canonical origin, read from the browser under the normal tab lock. A private tab, a frame that is
 * not the top document or a non-http page has no origin to act on. The agent never supplies an origin.
 */
async function resolveTab(
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

const COMMANDS: Record<Exclude<Action, 'inspect' | 'export'>, MemoryAdminCommand> = {
  enable: 'enable',
  disable: 'disable',
  exclude: 'exclude',
  include: 'include',
  delete: 'delete',
};

function confirmationText(action: Exclude<Action, 'inspect' | 'export'>, origin: string | undefined): string {
  switch (action) {
    case 'enable': return 'Website memory is on.';
    case 'disable': return 'Website memory is off.';
    case 'exclude': return `Website memory is off for ${origin}.`;
    case 'include': return `Website memory is allowed again for ${origin}.`;
    case 'delete': return `Stored notes for ${origin} were deleted.`;
  }
}

/**
 * `browser_memory_policy`: a policy change an agent asked for. The daemon refuses it unless the MCP
 * server marks it `ownerConfirmed`, which that process sets only after the owner approved a prompt built
 * from the action and the origin the tab resolved to. The confirmed call names that origin again
 * (`confirmedOrigin`), so a tab that moved while the owner decided changes nothing.
 */
export async function routeMemoryPolicyTool(
  memory: PolicyToolHost,
  bridge: MemoryToolBridge,
  sessionId: string,
  agentName: string,
  params: Record<string, unknown>,
  signal: AbortSignal,
  sanitize: (value: unknown) => Promise<unknown> = async (value) => value,
): Promise<RoutedCallResult> {
  const args = parseArguments(params);
  if (typeof args === 'string') return fail(args);
  const { action } = args;

  let origin: string | undefined;
  let siteContext: unknown = null;
  if (SCOPED.has(action)) {
    const tab = await resolveTab(bridge, sessionId, agentName, args.tabId as number, signal);
    if ('success' in tab) return tab;
    ({ origin, siteContext } = tab);
  }

  if (!args.ownerConfirmed) {
    return {
      ...fail('ACTION_NOT_CONFIRMED: the owner has not confirmed this change; nothing was changed.'),
      result: { ownerConfirmationRequired: true, action, ...(origin ? { origin } : {}) },
    };
  }
  if (origin !== undefined && args.confirmedOrigin !== origin) {
    return unknownScope('the tab changed while the owner was deciding, so nothing was changed.');
  }

  try {
    if (action === 'inspect' || action === 'export') {
      // The requesting profile's view of this one origin: the same answer browser_memory gives, never the owner's full records.
      const answer = await memory.handleTool('browser_memory', { tabId: args.tabId, kind: 'all' }, sessionId, { siteContext });
      if (!isRecord(answer)) return fail('MEMORY_UNAVAILABLE: website memory returned no answer');
      if (answer.success === false) return fail(typeof answer.error === 'string' ? answer.error : 'MEMORY_UNAVAILABLE: website memory failed');
      const text = typeof answer.text === 'string' ? answer.text.slice(0, TEXT_MAX) : '';
      return { success: true, result: await sanitize({ success: true, action, origin, text }) };
    }
    const request: MemoryAdminRequest = {
      kind: 'memory-admin',
      id: `policy-${randomUUID()}`,
      command: COMMANDS[action],
      ...(origin ? { origin } : {}),
    };
    const outcome = await memory.admin(request);
    if (!outcome.success) return fail(outcome.error ?? 'MEMORY_UNAVAILABLE: website memory failed');
    return { success: true, result: await sanitize({ success: true, action, ...(origin ? { origin } : {}), text: confirmationText(action, origin) }) };
  } catch {
    return fail('MEMORY_UNAVAILABLE: website memory failed');
  }
}

export function isMemoryTool(tool: string): boolean {
  return tool === 'browser_memory' || tool === 'browser_memory_policy';
}

/** The daemon's one entry for both memory tools. */
export function routeMemoryToolCall(
  tool: string,
  memory: PolicyToolHost,
  bridge: MemoryToolBridge,
  sessionId: string,
  agentName: string,
  params: Record<string, unknown>,
  signal: AbortSignal,
  sanitize?: (value: unknown) => Promise<unknown>,
): Promise<RoutedCallResult> {
  return tool === 'browser_memory_policy'
    ? routeMemoryPolicyTool(memory, bridge, sessionId, agentName, params, signal, sanitize)
    : routeMemoryTool(memory, bridge, sessionId, agentName, params, signal, sanitize);
}
