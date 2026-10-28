/**
 * The `browser_memory_policy` actions, shared by the MCP tool and the daemon route (specs/004-site-navigation-map
 * research R-20). A leaf module: the MCP process imports it without pulling in the memory store.
 */
export const MEMORY_POLICY_ACTIONS = ['enable', 'disable', 'exclude', 'include', 'inspect', 'export', 'delete'] as const;
export const MAP_POLICY_ACTIONS = ['map_enable', 'map_disable', 'map_exclude_path', 'map_include_path', 'map_inspect', 'map_export', 'map_delete'] as const;
export const POLICY_ACTIONS = [...MEMORY_POLICY_ACTIONS, ...MAP_POLICY_ACTIONS] as const;

export type MemoryPolicyAction = (typeof MEMORY_POLICY_ACTIONS)[number];
export type MapPolicyAction = (typeof MAP_POLICY_ACTIONS)[number];
export type PolicyAction = (typeof POLICY_ACTIONS)[number];

/** 003 actions that act on the tab's site. */
export const SITE_SCOPED_ACTIONS: ReadonlySet<string> = new Set(['exclude', 'include', 'inspect', 'export', 'delete']);

/** How each map action uses tabId and path: required, optional or refused. */
export const MAP_ACTION_ARGS: Readonly<Record<MapPolicyAction, { tabId: 'required' | 'optional' | 'refused'; path: 'required' | 'optional' | 'refused' }>> = {
  map_enable: { tabId: 'refused', path: 'refused' },
  map_disable: { tabId: 'refused', path: 'refused' },
  map_exclude_path: { tabId: 'required', path: 'required' },
  map_include_path: { tabId: 'required', path: 'required' },
  map_inspect: { tabId: 'optional', path: 'refused' },
  map_export: { tabId: 'optional', path: 'refused' },
  map_delete: { tabId: 'optional', path: 'optional' },
};

export function isMapPolicyAction(value: unknown): value is MapPolicyAction {
  return (MAP_POLICY_ACTIONS as readonly unknown[]).includes(value);
}

/** Problems with a map action's tabId and path, or null. A path needs a tabId: it names a page of the tab's site. */
export function mapActionArgsProblem(action: MapPolicyAction, tabId: unknown, path: unknown): string | null {
  const rule = MAP_ACTION_ARGS[action];
  if (tabId !== undefined && (typeof tabId !== 'number' || !Number.isInteger(tabId) || tabId < 0)) return 'tabId must be a non-negative integer';
  if (path !== undefined && (typeof path !== 'string' || path.length < 2 || path.length > 200 || !/^\/[^?#]*$/u.test(path))) return 'path must start with "/", be 2-200 characters and have no query or fragment';
  if (rule.tabId === 'required' && tabId === undefined) return `${action} needs a tabId; the site is taken from that tab`;
  if (rule.tabId === 'refused' && tabId !== undefined) return `${action} covers this browser profile and takes no tabId`;
  if (rule.path === 'required' && path === undefined) return `${action} needs a path`;
  if (rule.path === 'refused' && path !== undefined) return `${action} takes no path`;
  if (path !== undefined && tabId === undefined) return 'a path needs the tabId of a page on that site';
  return null;
}
