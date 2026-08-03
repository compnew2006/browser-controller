import type { ToolDefinition } from './types.js';
import { navigateTool } from './navigate.js';
import { clickTool } from './click.js';
import { typeTool } from './type.js';
import { scrollTool } from './scroll.js';
import { pressKeyTool } from './press-key.js';
import { waitTool } from './wait.js';
import { snapshotTool } from './snapshot.js';
import { screenshotTool } from './screenshot.js';
import { consoleTool } from './console.js';
import { networkTool } from './network.js';
import { tabsTool } from './tabs.js';
import { findTool } from './find.js';
import { textTool } from './text.js';
import { hoverTool } from './hover.js';
import { selectTool } from './select.js';
import { evaluateTool } from './evaluate.js';
import { clickTextTool } from './click-text.js';
import { dialogTool } from './dialog.js';
import { uploadFileTool } from './upload-file.js';
import { runActionTool } from './run-action.js';
import { dragTool } from './drag.js';
import { fillFormTool } from './fill-form.js';

export const allTools: ToolDefinition[] = [
  navigateTool,
  clickTool,
  typeTool,
  scrollTool,
  pressKeyTool,
  waitTool,
  snapshotTool,
  screenshotTool,
  consoleTool,
  networkTool,
  tabsTool,
  findTool,
  textTool,
  hoverTool,
  selectTool,
  evaluateTool,
  clickTextTool,
  dialogTool,
  uploadFileTool,
  runActionTool,
  dragTool,
  fillFormTool,
];

export const toolMap = new Map<string, ToolDefinition>(
  allTools.map(t => [t.name, t]),
);

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
 * each tool's `timeoutMs` when set; tools without one fall back to the caller's
 * default. This co-locates transport policy with the tool registry so a new
 * tool forces the author to consider its timeout (audit M3), rather than
 * relying on a parallel TOOL_TIMEOUTS table that can drift.
 */
const timeoutByToolName = new Map(
  allTools
    .filter((t) => typeof t.timeoutMs === 'number')
    .map((t) => [t.name, t.timeoutMs as number]),
);

export function toolTimeoutMs(tool: string): number | undefined {
  return timeoutByToolName.get(tool);
}
