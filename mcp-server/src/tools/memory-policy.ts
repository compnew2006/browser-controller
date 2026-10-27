import { z } from 'zod';
import type { ToolDefinition, ToolHost, ToolResult } from './types.js';
import { failureResult, forwardHandler, payloadOf, tabIdParam } from './types.js';
import { requestOwnerConfirmation } from './action-support.js';

const NAME = 'browser_memory_policy';
const ACTIONS = ['enable', 'disable', 'exclude', 'include', 'inspect', 'export', 'delete'] as const;
type Action = (typeof ACTIONS)[number];
const SCOPED: ReadonlySet<Action> = new Set(['exclude', 'include', 'inspect', 'export', 'delete']);
const forward = forwardHandler(NAME);

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

function invalid(message: string): ToolResult {
  return failureResult(`INVALID_ARGUMENT: ${message}`);
}

/**
 * The daemon refuses a request without the owner's confirmation and says which origin the tab resolves to.
 * That origin comes from the browser through the daemon, never from the agent.
 */
async function previewOrigin(host: ToolHost, params: Record<string, unknown>): Promise<{ origin: string } | ToolResult> {
  try {
    await host.callTool(NAME, params);
  } catch (error) {
    const payload = payloadOf(error) as { ownerConfirmationRequired?: unknown; origin?: unknown } | undefined;
    if (payload?.ownerConfirmationRequired !== true) throw error;
    const origin = canonicalOrigin(payload.origin);
    return origin ? { origin } : failureResult('MEMORY_SCOPE_UNKNOWN: the tab\'s site could not be verified, so nothing was changed.');
  }
  // The daemon never succeeds without a confirmation; a success here is not a state to act on.
  return failureResult('MEMORY_UNAVAILABLE: the daemon did not ask for confirmation, so nothing was changed.');
}

/** An injected agent could ask on every turn; after this many unconfirmed requests the prompt stops for a while (review F-11). */
const MAX_UNCONFIRMED = 3;
const UNCONFIRMED_WINDOW_MS = 10 * 60_000;
const unconfirmed = new WeakMap<ToolHost, number[]>();

async function handler(host: ToolHost, params: Record<string, unknown>): Promise<ToolResult> {
  // ownerConfirmed and confirmedOrigin are set below, only after the owner approves; a supplied value is dropped.
  const { ownerConfirmed: _ownerConfirmed, confirmedOrigin: _confirmedOrigin, ...supplied } = params;
  const action = supplied.action as Action;
  if (!ACTIONS.includes(action)) return invalid('action must be enable, disable, exclude, include, inspect, export or delete');
  const keys = Object.keys(supplied).filter((key) => key !== 'action' && key !== 'tabId');
  if (keys.length) return invalid(`${NAME} takes action and tabId only`);
  const recent = (unconfirmed.get(host) ?? []).filter((at) => Date.now() - at < UNCONFIRMED_WINDOW_MS);
  unconfirmed.set(host, recent);
  if (recent.length >= MAX_UNCONFIRMED) {
    return failureResult('ACTION_NOT_CONFIRMED: too many recent requests were not confirmed, so no prompt is shown for now; nothing was changed.');
  }
  const scoped = SCOPED.has(action);
  if (scoped && (typeof supplied.tabId !== 'number' || !Number.isInteger(supplied.tabId) || supplied.tabId < 0)) {
    return invalid(`${action} needs a tabId; the site is taken from that tab`);
  }
  if (!scoped && supplied.tabId !== undefined) return invalid(`${action} covers all sites and takes no tabId`);
  const request: Record<string, unknown> = scoped ? { action, tabId: supplied.tabId } : { action };

  let origin: string | undefined;
  if (scoped) {
    const preview = await previewOrigin(host, request);
    if ('content' in preview) return preview;
    origin = preview.origin;
  }

  const answer = await requestOwnerConfirmation(host, NAME, `Allow ${action} of website memory for ${origin ?? 'all sites'}?`);
  if (answer === 'unavailable') {
    return failureResult('CLIENT_CONFIRMATION_UNAVAILABLE: this MCP client cannot ask the owner for confirmation; nothing was changed.');
  }
  if (answer !== 'approved') {
    recent.push(Date.now());
    return failureResult('ACTION_NOT_CONFIRMED: the owner declined or did not answer; nothing was changed.');
  }
  return forward(host, { ...request, ownerConfirmed: true, ...(origin ? { confirmedOrigin: origin } : {}) });
}
(handler as { toolName?: string }).toolName = NAME;

/** Daemon-owned. Kept apart from the read-only browser_memory so a client can allow reads and still prompt on policy changes. */
export const memoryPolicyTool: ToolDefinition = {
  name: NAME,
  summary: 'Request a website-memory change; the owner confirms it',
  description: 'Request a change to website memory. It applies only if the owner confirms it in this client. tabId picks the site for site-scoped actions.',
  inputSchema: z.object({
    action: z.enum(ACTIONS),
    tabId: tabIdParam.optional(),
  }).strict(),
  timeoutMs: 10_000,
  handler,
};
