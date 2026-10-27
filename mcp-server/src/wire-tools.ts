import { toolMap } from './tools/index.js';

/** Wire actions the MCP server sends that are not tools in the registry. */
const INTERNAL_WIRE_TOOLS = new Set(['browser_classify_action']);

/**
 * Tool names the daemon forwards: the registry plus the internal wire actions.
 * Private vault names are let through so the vault router returns its coded
 * denial. Names only; parameters are validated in the MCP process and the
 * extension (audit F6-3).
 */
export function isKnownWireTool(name: unknown): boolean {
  if (typeof name !== 'string') return false;
  return toolMap.has(name) || INTERNAL_WIRE_TOOLS.has(name) || name.startsWith('browser_vault_internal_');
}
