import { randomUUID } from 'node:crypto';
import type { RoutedCallResult } from '../vault/daemon-routing.js';
import type { MemoryAdminCommand, MemoryAdminRequest, MemoryAdminResult } from '../daemon-config.js';
import { routeMapPolicyTool, type MapPolicyHost } from './map-policy-route.js';
import { routeSiteMapTool } from './map-tool-route.js';
import { MEMORY_POLICY_ACTIONS, SITE_SCOPED_ACTIONS, isMapPolicyAction, type MemoryPolicyAction } from './policy-actions.js';
import {
  fail,
  isRecord,
  resolveTab,
  routeMemoryTool,
  unknownScope,
  type MemoryToolBridge,
  type MemoryToolHost,
} from './tool-route.js';

const ACTIONS = MEMORY_POLICY_ACTIONS;
type Action = MemoryPolicyAction;
const SCOPED = SITE_SCOPED_ACTIONS;
const TEXT_MAX = 4_000;

/** The slice of MemoryService this route uses. `admin` is the one writer of policy, shared with the owner CLI. */
export interface PolicyToolHost extends MemoryToolHost, MapPolicyHost {
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
  if (!action) return 'INVALID_ARGUMENT: action must be enable, disable, exclude, include, inspect, export, delete or a map_ action';
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
  if (isMapPolicyAction(params.action)) return routeMapPolicyTool(memory, bridge, sessionId, agentName, params.action, params, signal, sanitize);
  const args = parseArguments(params);
  if (typeof args === 'string') return fail(args);
  const { action } = args;

  let origin: string | undefined;
  let siteContext: unknown = null;
  let connectionIdBefore: string | null = null;
  if (SCOPED.has(action)) {
    const prepared = memory.prepareTool(sessionId, 'policy');
    if ('error' in prepared) return fail(prepared.error);
    connectionIdBefore = prepared.connectionId;
    const tab = await resolveTab(bridge, sessionId, agentName, args.tabId as number, signal);
    if ('success' in tab) return tab;
    ({ origin, siteContext } = tab);
  }

  if (!args.ownerConfirmed) {
    return {
      ...fail('ACTION_NOT_CONFIRMED: the owner has not confirmed this change; nothing was changed.'),
      result: { success: false, ownerConfirmationRequired: true, action, ...(origin ? { origin } : {}) },
    };
  }
  if (origin !== undefined && args.confirmedOrigin !== origin) {
    return unknownScope('the tab changed while the owner was deciding, so nothing was changed.');
  }

  try {
    if (action === 'inspect' || action === 'export') {
      // The requesting profile's view of this one origin: the same answer browser_memory gives, never the owner's full records.
      const answer = await memory.handleTool('browser_memory', { tabId: args.tabId, kind: 'all' }, sessionId, { siteContext, connectionIdBefore });
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
  return tool === 'browser_memory' || tool === 'browser_memory_policy' || tool === 'browser_site_map';
}

/** The daemon's one entry for the memory tools. */
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
  if (tool === 'browser_site_map') return routeSiteMapTool(memory, bridge, sessionId, agentName, params, signal, sanitize);
  return tool === 'browser_memory_policy'
    ? routeMemoryPolicyTool(memory, bridge, sessionId, agentName, params, signal, sanitize)
    : routeMemoryTool(memory, bridge, sessionId, agentName, params, signal, sanitize);
}
