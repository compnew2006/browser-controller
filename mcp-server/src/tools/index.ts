import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { navigateTool } from './navigate.js';
import { clickTool } from './click.js';
import { typeTool } from './type.js';
import { scrollTool } from './scroll.js';
import { waitTool } from './wait.js';
import { snapshotTool } from './snapshot.js';
import { screenshotTool } from './screenshot.js';
import { consoleTool } from './console.js';
import { networkTool } from './network.js';
import { tabsTool } from './tabs.js';
import { textTool } from './text.js';
import { evaluateTool } from './evaluate.js';
import { dialogTool } from './dialog.js';
import { interceptTool } from './intercept.js';
import { fillTool } from './fill.js';
import { batchTool } from './batch.js';
import { resizeWindowTool } from './resize-window.js';
import { emulateTool } from './emulate.js';
import { listBrowsersTool, selectBrowserTool } from './browsers.js';
import { inspectElementTool } from './inspect-element.js';

export const allTools: ToolDefinition[] = [
  navigateTool,
  clickTool,
  typeTool,
  fillTool,
  scrollTool,
  waitTool,
  snapshotTool,
  screenshotTool,
  consoleTool,
  networkTool,
  tabsTool,
  textTool,
  evaluateTool,
  dialogTool,
  interceptTool,
  batchTool,
  resizeWindowTool,
  emulateTool,
  listBrowsersTool,
  selectBrowserTool,
  inspectElementTool,
];

export const toolMap = new Map<string, ToolDefinition>(
  allTools.map((t) => [t.name, t]),
);

export type ToolCapability = 'read' | 'write' | 'mixed';

export interface ToolManifestEntry {
  name: string;
  description: string;
  inputSchema: unknown;
  timeoutMs: number | undefined;
  idempotent: boolean;
  capability: ToolCapability;
}

function capabilityOf(tool: ToolDefinition): ToolCapability {
  if (tool.idempotent === true) return 'read';
  if (tool.name === 'browser_console' || tool.name === 'browser_network' || tool.name === 'browser_tabs') return 'mixed';
  return 'write';
}

export const toolManifest: ToolManifestEntry[] = allTools.map((tool) => ({
  name: tool.name,
  description: tool.description,
  inputSchema: z.toJSONSchema(tool.inputSchema),
  timeoutMs: tool.timeoutMs,
  idempotent: tool.idempotent === true,
  capability: capabilityOf(tool),
}));

/**
 * Whether a tool is safe to retry on timeout, derived from each tool's
 * `idempotent` flag (the single source of truth — see ToolDefinition). This
 * replaces the hand-maintained IDEMPOTENT_TOOLS string set that previously
 * lived in daemon-config.ts and could silently drift from the real registry
 * (audit C1/m5). `browser_console`/`browser_network` are false here despite
 * "looking" like reads, because `clear:true` mutates state (audit M2).
 */
const idempotentToolNames = new Set(
  allTools.filter((t) => t.idempotent === true).map((t) => t.name),
);

export function isIdempotent(tool: string): boolean {
  return idempotentToolNames.has(tool);
}

/**
 * Per-tool transport timeout (bridge → extension round-trip). Derived from
 * each tool's `timeoutMs`; tools without one fall back to the caller's default.
 * This co-locates transport policy with the tool registry so a new tool forces
 * the author to consider its timeout (audit M3), rather than relying on a
 * parallel table that can drift. The registry guard test
 * (registry.test.ts) requires every tool to declare a `timeoutMs`.
 */
const timeoutByToolName = new Map(
  allTools
    .filter((t) => typeof t.timeoutMs === "number")
    .map((t) => [t.name, t.timeoutMs as number]),
);

export function toolTimeoutMs(tool: string): number | undefined {
  return timeoutByToolName.get(tool);
}
