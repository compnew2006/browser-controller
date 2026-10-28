/**
 * The `map_*` actions of `browser_memory_policy` (specs/004-site-navigation-map research R-20). Every action is
 * scoped to the session's verified browser profile. Without the MCP server's `ownerConfirmed` the daemon changes
 * nothing and answers with a preview the owner prompt is built from: the action, the tab's origin, the canonical
 * path, and the profile id and label. The confirmed call names the origin, path and profile again, so a request
 * whose tab, path or session profile changed while the owner decided changes nothing.
 */
import { randomUUID } from 'node:crypto';
import type { MapAdminRequest, MemoryAdminRequest, MemoryAdminResult } from '../daemon-config.js';
import type { RoutedCallResult } from '../vault/daemon-routing.js';
import { buildMapOutline } from './map-output.js';
import type { MapRecord } from './map-record.js';
import { canonicalPagePath, canonicalPrefix } from './map-text.js';
import { mapActionArgsProblem, type MapPolicyAction } from './policy-actions.js';
import { fail, isRecord, resolveTab, unknownScope, type MemoryToolBridge, type MemoryToolHost } from './tool-route.js';

const TEXT_MAX = 4_000;

/** The slice of MemoryService this route uses. */
export interface MapPolicyHost extends MemoryToolHost {
  admin(request: MemoryAdminRequest): Promise<MemoryAdminResult>;
  /** The session's verified profile and its label; `read` also needs the vault to be clear for that profile. */
  mapIdentity(sessionId: string, purpose: 'change' | 'read'): { profile: string; label: string } | { error: string };
}

interface MapArguments {
  action: MapPolicyAction;
  tabId?: number;
  path?: string;
  ownerConfirmed: boolean;
  confirmedOrigin?: string;
  confirmedPath?: string;
  confirmedProfile?: string;
}

function parseArguments(action: MapPolicyAction, params: Record<string, unknown>): MapArguments | string {
  const allowed = ['action', 'tabId', 'path', 'ownerConfirmed', 'confirmedOrigin', 'confirmedPath', 'confirmedProfile'];
  if (Object.keys(params).some((key) => !allowed.includes(key))) return 'INVALID_ARGUMENT: map actions take action, tabId and path only';
  const problem = mapActionArgsProblem(action, params.tabId, params.path);
  if (problem) return `INVALID_ARGUMENT: ${problem}`;
  const { ownerConfirmed, confirmedOrigin, confirmedPath, confirmedProfile } = params;
  if (ownerConfirmed !== undefined && typeof ownerConfirmed !== 'boolean') return 'INVALID_ARGUMENT: ownerConfirmed must be a boolean';
  for (const value of [confirmedOrigin, confirmedPath, confirmedProfile]) {
    if (value !== undefined && (typeof value !== 'string' || value.length > 300)) return 'INVALID_ARGUMENT: confirmed fields must be strings';
  }
  return {
    action,
    ...(typeof params.tabId === 'number' ? { tabId: params.tabId } : {}),
    ...(typeof params.path === 'string' ? { path: params.path } : {}),
    ownerConfirmed: ownerConfirmed === true,
    ...(typeof confirmedOrigin === 'string' ? { confirmedOrigin } : {}),
    ...(typeof confirmedPath === 'string' ? { confirmedPath } : {}),
    ...(typeof confirmedProfile === 'string' ? { confirmedProfile } : {}),
  };
}

function adminRequest(action: MapPolicyAction, profile: string, origin: string | undefined, path: string | undefined): MapAdminRequest {
  switch (action) {
    case 'map_enable': return { command: 'enable', browser: profile };
    case 'map_disable': return { command: 'disable', browser: profile };
    case 'map_exclude_path': return { command: 'exclude-path', origin, path };
    case 'map_include_path': return { command: 'include-path', origin, path };
    // Admin `export` covers every site of the profile, so a site-scoped request runs `inspect` to stay on that site;
    // either way the agent gets the outline only (RV-15).
    case 'map_inspect':
    case 'map_export': return origin ? { command: 'inspect', browser: profile, origin } : { command: 'export', browser: profile };
    case 'map_delete': return origin ? { command: 'delete', browser: profile, origin, ...(path ? { path } : {}) } : { command: 'delete', browser: profile, all: true };
  }
}

function doneText(action: MapPolicyAction, label: string, origin: string | undefined, path: string | undefined): string {
  const site = origin ?? 'all sites';
  switch (action) {
    case 'map_enable': return `The site map is on for browser profile "${label}".`;
    case 'map_disable': return `The site map is off for browser profile "${label}"; its data is kept until it is deleted.`;
    case 'map_exclude_path': return `${path} and the pages under it are excluded from the site map for ${origin}.`;
    case 'map_include_path': return `${path} is allowed in the site map for ${origin} again.`;
    case 'map_inspect':
    case 'map_export': return `Site map of ${site} for browser profile "${label}".`;
    case 'map_delete': return path ? `The site map entry ${path} of ${origin} was deleted for browser profile "${label}".` : `The site map of ${site} was deleted for browser profile "${label}".`;
  }
}

/** Outlines of the returned maps, bounded like other memory text (R-16). */
function inspectText(header: string, records: readonly MapRecord[]): string {
  const parts = [header, ...records.map((record) => buildMapOutline(record.origin, record).text)];
  return parts.join('\n').slice(0, TEXT_MAX);
}

export async function routeMapPolicyTool(
  memory: MapPolicyHost,
  bridge: MemoryToolBridge,
  sessionId: string,
  agentName: string,
  action: MapPolicyAction,
  params: Record<string, unknown>,
  signal: AbortSignal,
  sanitize: (value: unknown) => Promise<unknown>,
): Promise<RoutedCallResult> {
  const args = parseArguments(action, params);
  if (typeof args === 'string') return fail(args);
  const reading = action === 'map_inspect' || action === 'map_export';
  const identity = memory.mapIdentity(sessionId, reading ? 'read' : 'change');
  if ('error' in identity) return fail(identity.error);
  const { profile, label } = identity;

  let origin: string | undefined;
  if (args.tabId !== undefined) {
    const prepared = memory.prepareTool(sessionId, 'policy');
    if ('error' in prepared) return fail(prepared.error);
    const tab = await resolveTab(bridge, sessionId, agentName, args.tabId, signal);
    if ('success' in tab) return tab;
    origin = tab.origin;
    const after = memory.mapIdentity(sessionId, reading ? 'read' : 'change');
    if ('error' in after || after.profile !== profile || prepared.connectionId === null) return unknownScope("this session's browser profile changed during the request, so nothing was changed.");
  }
  let path: string | undefined;
  if (args.path !== undefined) {
    // map_delete names one page (the root too); exclusions name a prefix, never "/".
    const canonical = action === 'map_delete' ? canonicalPagePath(args.path) : canonicalPrefix(args.path);
    if (!canonical) return fail(action === 'map_delete' ? 'INVALID_ARGUMENT: path must start with "/" and must have no query or fragment' : 'INVALID_ARGUMENT: path must start with "/", must not be "/", and must have no query or fragment');
    path = canonical;
  }

  const preview = { action, ...(origin ? { origin } : {}), ...(path ? { path } : {}), profile, profileLabel: label };
  if (!args.ownerConfirmed) {
    return { ...fail('ACTION_NOT_CONFIRMED: the owner has not confirmed this change; nothing was changed.'), result: { success: false, ownerConfirmationRequired: true, ...preview } };
  }
  if (args.confirmedProfile !== profile || (origin !== undefined && args.confirmedOrigin !== origin) || (path !== undefined && args.confirmedPath !== path)) {
    return unknownScope('the tab, path or browser profile changed while the owner was deciding, so nothing was changed.');
  }

  try {
    const outcome = await memory.admin({ kind: 'memory-admin', id: `map-policy-${randomUUID()}`, command: 'map', map: adminRequest(action, profile, origin, path) });
    if (!outcome.success) return fail(outcome.error ?? 'MAP_UNAVAILABLE: the site map failed');
    const text = doneText(action, label, origin, path);
    const records = (outcome.records ?? []).filter((record): record is MapRecord => isRecord(record) && record.profile === profile);
    // An agent sees outlines only, as with 003's inspect and export; the full JSON export is the owner CLI's (RV-15).
    if (action === 'map_inspect') return { success: true, result: await sanitize({ success: true, ...preview, text: inspectText(text, records) }) };
    if (action === 'map_export') return { success: true, result: await sanitize({ success: true, ...preview, text: inspectText(`${text} The full export is available to the owner with \`npm run memory -- map export\`.`, records) }) };
    return { success: true, result: await sanitize({ success: true, ...preview, text }) };
  } catch {
    return fail('MAP_UNAVAILABLE: the site map failed');
  }
}
