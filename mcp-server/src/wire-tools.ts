import { toolMap } from './tools/index.js';

/** Wire actions the MCP server sends that are not tools in the registry. */
const INTERNAL_WIRE_TOOLS = new Set(['browser_classify_action']);

/**
 * Wire actions only the daemon sends to the extension. No IPC client may ask for them, so
 * isKnownWireTool refuses these names: they would give any caller a tab's page state outside
 * the tool that checks policy and scope.
 */
export const DAEMON_ONLY_WIRE_TOOLS: ReadonlySet<string> = new Set(['browser_memory_internal_context']);

/**
 * Tool names the daemon forwards: the registry plus the internal wire actions.
 * Private vault names are let through so the vault router returns its coded
 * denial. Names only; parameters are validated in the MCP process and the
 * extension (audit F6-3).
 */
export function isKnownWireTool(name: unknown): boolean {
  if (typeof name !== 'string' || DAEMON_ONLY_WIRE_TOOLS.has(name)) return false;
  return toolMap.has(name) || INTERNAL_WIRE_TOOLS.has(name) || name.startsWith('browser_vault_internal_');
}
