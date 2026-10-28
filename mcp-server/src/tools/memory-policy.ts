import { z } from 'zod';
import type { ToolDefinition, ToolHost, ToolResult } from './types.js';
import { failureResult, forwardHandler, payloadOf, tabIdParam } from './types.js';
import { requestOwnerConfirmation } from './action-support.js';
import {
  POLICY_ACTIONS,
  SITE_SCOPED_ACTIONS,
  isMapPolicyAction,
  mapActionArgsProblem,
  type MapPolicyAction,
  type MemoryPolicyAction,
  type PolicyAction,
} from '../memory/policy-actions.js';

const NAME = 'browser_memory_policy';
const forward = forwardHandler(NAME);
/** Control and format characters (bidi overrides among them) never reach an owner prompt. */
const UNSAFE_TEXT = /\p{C}/u;

/** An origin the owner may be shown: exactly what `new URL(...).origin` gives for an http(s) URL. */
function canonicalOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 300) return null;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value ? value : null;
  } catch {
    return null;
  }
}

/** Daemon-supplied text for a prompt: bounded, and without control or format characters. */
function promptSafe(value: unknown, max: number, pattern?: RegExp): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || UNSAFE_TEXT.test(value)) return null;
  return pattern && !pattern.test(value) ? null : value;
}

function invalid(message: string): ToolResult {
  return failureResult(`INVALID_ARGUMENT: ${message}`);
}

/**
 * The daemon refuses a request without the owner's confirmation and says what it would act on: the origin the tab
 * resolves to and, for map actions, the canonical path and the session's verified profile. These come from the
 * browser and the daemon, never from the agent.
 */
async function preview(host: ToolHost, params: Record<string, unknown>): Promise<Record<string, unknown> | ToolResult> {
  try {
    await host.callTool(NAME, params);
  } catch (error) {
    const payload = payloadOf(error) as Record<string, unknown> | undefined;
    if (payload?.ownerConfirmationRequired !== true) throw error;
    return payload;
  }
  // The daemon never succeeds without a confirmation; a success here is not a state to act on.
  return failureResult('MEMORY_UNAVAILABLE: the daemon did not ask for confirmation, so nothing was changed.');
}

/** The owner prompts from specs/004-site-navigation-map/contracts/README.md. */
function mapPrompt(action: MapPolicyAction, label: string, origin: string | undefined, path: string | undefined): string {
  const site = origin ?? 'all sites';
  switch (action) {
    case 'map_enable': return `Allow enabling the site map for browser profile "${label}"? The map records the addresses of pages agents visit in this browser profile, including signed-in pages.`;
    case 'map_disable': return `Allow disabling the site map for browser profile "${label}"? Existing map data is kept until it is deleted.`;
    case 'map_exclude_path': return `Allow excluding ${path} and the pages under it from the site map for ${origin}? Existing entries under it are deleted.`;
    case 'map_include_path': return `Allow including ${path} in the site map for ${origin} again?`;
    case 'map_inspect': return `Allow showing the site map of ${site} for browser profile "${label}"?`;
    case 'map_export': return `Allow exporting the site map of ${site} for browser profile "${label}"?`;
    case 'map_delete': return path ? `Allow deleting the site map entry ${path} of ${origin} for browser profile "${label}"?` : `Allow deleting the site map of ${site} for browser profile "${label}"?`;
  }
}

/** What the confirmed call names again, so the daemon can refuse a request whose scope moved while the owner decided. */
interface Confirmed {
  message: string;
  fields: Record<string, string>;
}

async function memoryConfirmation(host: ToolHost, action: MemoryPolicyAction, request: Record<string, unknown>): Promise<Confirmed | ToolResult> {
  if (!SITE_SCOPED_ACTIONS.has(action)) return { message: `Allow ${action} of website memory for all sites?`, fields: {} };
  const answer = await preview(host, request);
  if ('content' in answer) return answer as ToolResult;
  const origin = canonicalOrigin(answer.origin);
  if (!origin) return failureResult('MEMORY_SCOPE_UNKNOWN: the tab\'s site could not be verified, so nothing was changed.');
  return { message: `Allow ${action} of website memory for ${origin}?`, fields: { confirmedOrigin: origin } };
}

async function mapConfirmation(host: ToolHost, action: MapPolicyAction, request: Record<string, unknown>): Promise<Confirmed | ToolResult> {
  const answer = await preview(host, request);
  if ('content' in answer) return answer as ToolResult;
  const unverified = failureResult('MEMORY_SCOPE_UNKNOWN: the site, path or browser profile could not be verified, so nothing was changed.');
  const profile = promptSafe(answer.profile, 200);
  const label = promptSafe(answer.profileLabel, 100);
  const origin = answer.origin === undefined ? undefined : canonicalOrigin(answer.origin);
  const path = answer.path === undefined ? undefined : promptSafe(answer.path, 200, /^\/[^?#\s]*$/u);
  if (!profile || !label || origin === null || path === null) return unverified;
  if ((request.tabId !== undefined) !== (origin !== undefined) || (request.path !== undefined) !== (path !== undefined)) return unverified;
  return {
    message: mapPrompt(action, label, origin, path),
    fields: { confirmedProfile: profile, ...(origin ? { confirmedOrigin: origin } : {}), ...(path ? { confirmedPath: path } : {}) },
  };
}

/** An injected agent could ask on every turn; after this many unconfirmed requests the prompt stops for a while (review F-11). */
const MAX_UNCONFIRMED = 3;
const UNCONFIRMED_WINDOW_MS = 10 * 60_000;
const unconfirmed = new WeakMap<ToolHost, number[]>();

async function handler(host: ToolHost, params: Record<string, unknown>): Promise<ToolResult> {
  // The confirmation fields are set below, only after the owner approves; supplied values are dropped.
  const { ownerConfirmed: _o, confirmedOrigin: _co, confirmedPath: _cp, confirmedProfile: _cr, ...supplied } = params;
  const action = supplied.action as PolicyAction;
  if (!POLICY_ACTIONS.includes(action)) return invalid('action must be enable, disable, exclude, include, inspect, export, delete or a map_ action');
  const map = isMapPolicyAction(action);
  const keys = Object.keys(supplied).filter((key) => key !== 'action' && key !== 'tabId' && !(map && key === 'path'));
  if (keys.length) return invalid(map ? `${NAME} takes action, tabId and path only` : `${NAME} takes action and tabId only`);
  const recent = (unconfirmed.get(host) ?? []).filter((at) => Date.now() - at < UNCONFIRMED_WINDOW_MS);
  unconfirmed.set(host, recent);
  if (recent.length >= MAX_UNCONFIRMED) {
    return failureResult('ACTION_NOT_CONFIRMED: too many recent requests were not confirmed, so no prompt is shown for now; nothing was changed.');
  }

  let request: Record<string, unknown>;
  if (map) {
    const problem = mapActionArgsProblem(action, supplied.tabId, supplied.path);
    if (problem) return invalid(problem);
    request = { action, ...(supplied.tabId !== undefined ? { tabId: supplied.tabId } : {}), ...(supplied.path !== undefined ? { path: supplied.path } : {}) };
  } else {
    const scoped = SITE_SCOPED_ACTIONS.has(action);
    if (scoped && (typeof supplied.tabId !== 'number' || !Number.isInteger(supplied.tabId) || supplied.tabId < 0)) {
      return invalid(`${action} needs a tabId; the site is taken from that tab`);
    }
    if (!scoped && supplied.tabId !== undefined) return invalid(`${action} covers all sites and takes no tabId`);
    request = scoped ? { action, tabId: supplied.tabId } : { action };
  }

  const confirmation = map ? await mapConfirmation(host, action, request) : await memoryConfirmation(host, action as MemoryPolicyAction, request);
  if ('content' in confirmation) return confirmation as ToolResult;
  const answer = await requestOwnerConfirmation(host, NAME, confirmation.message);
  if (answer === 'unavailable') {
    return failureResult('CLIENT_CONFIRMATION_UNAVAILABLE: this MCP client cannot ask the owner for confirmation; nothing was changed.');
  }
  if (answer !== 'approved') {
    recent.push(Date.now());
    return failureResult('ACTION_NOT_CONFIRMED: the owner declined or did not answer; nothing was changed.');
  }
  return forward(host, { ...request, ownerConfirmed: true, ...confirmation.fields });
}
(handler as { toolName?: string }).toolName = NAME;

/** Daemon-owned. Kept apart from the read-only browser_memory so a client can allow reads and still prompt on policy changes. */
export const memoryPolicyTool: ToolDefinition = {
  name: NAME,
  summary: 'Request a website-memory change; the owner confirms it',
  description: 'Request a website-memory or site-map (map_*) change; it applies only if the owner confirms it in this client. tabId picks the site; path a page or prefix.',
  inputSchema: z.object({
    action: z.enum(POLICY_ACTIONS),
    tabId: tabIdParam.optional(),
    path: z.string().min(1).max(200).regex(/^\/[^?#]*$/u).optional().describe('map_*: page or prefix'),
  }).strict(),
  timeoutMs: 10_000,
  handler,
};
