import { TOOL_NAMES } from './tool-names.js';

/**
 * Wire actions the MCP server sends that are not tools in the registry.
 * Task lifecycle signals use the IPC `call` path because the MCP process
 * has no extension bridge. The daemon intercepts them in `routeCall` and
 * delivers question, lock-release and cursor controls with `sendControl`; they are
 * never tools and are not forwarded as ordinary extension calls.
 */
export const INTERNAL_WIRE_TOOLS: ReadonlySet<string> = new Set([
  'browser_classify_action',
  'browser_task_internal_question',
  'browser_task_internal_lock_release',
  'browser_task_internal_cursor',
]);

/** The internal wire action that carries a task question from the MCP process to the daemon. */
export const TASK_QUESTION_WIRE_ACTION = 'browser_task_internal_question';

/** Internal task lifecycle signal that releases the extension's page-input lease. */
export const TASK_LOCK_RELEASE_WIRE_ACTION = 'browser_task_internal_lock_release';

/** Internal task lifecycle signal that turns the agent cursor on/off for one task (Gap D). */
export const TASK_CURSOR_WIRE_ACTION = 'browser_task_internal_cursor';

/**
 * Wire actions only the daemon sends to the extension. No IPC client may ask for them, so
 * isKnownWireTool refuses these names: they would give any caller a tab's page state outside
 * the tool that checks policy and scope.
 */
export const DAEMON_ONLY_WIRE_TOOLS: ReadonlySet<string> = new Set(['browser_memory_internal_context']);

/**
 * The registered tool names, generated from the registry (see tool-names.ts).
 *
 * The list is data, not a dependency: the transport checks a name against it
 * instead of importing the tools layer, so the wire boundary stays independent
 * of the tools. tests/protocol-tool-names.test.ts proves the list never drifts
 * from the registry.
 */
const REGISTERED_TOOL_NAMES: ReadonlySet<string> = new Set(TOOL_NAMES);

/**
 * Tool names the daemon forwards: the registry plus the internal wire actions.
 * Private vault names are let through so the vault router returns its coded
 * denial. Names only; parameters are validated in the MCP process and the
 * extension (audit F6-3).
 */
export function isKnownWireTool(name: unknown): boolean {
  if (typeof name !== 'string' || DAEMON_ONLY_WIRE_TOOLS.has(name)) return false;
  return REGISTERED_TOOL_NAMES.has(name) || INTERNAL_WIRE_TOOLS.has(name) || name.startsWith('browser_vault_internal_');
}
