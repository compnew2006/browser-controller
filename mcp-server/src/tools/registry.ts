import type { ToolDefinition } from './types.js';
import { navigateTool } from './navigate.js';
import { tabsTool } from './tabs.js';
import { snapshotTool } from './snapshot.js';
import { textTool } from './text.js';
import { screenshotTool } from './screenshot.js';
import { clickTool } from './click.js';
import { typeTool } from './type.js';
import { fillTool } from './fill.js';
import { scrollTool } from './scroll.js';
import { waitTool } from './wait.js';
import { evaluateTool } from './evaluate.js';
import { dialogTool } from './dialog.js';
import { batchTool, useToolRegistry } from './batch.js';
import { emulateTool } from './emulate.js';
import { logsTool } from './logs.js';
import { mockTool } from './mock.js';
import { inspectElementTool } from './inspect-element.js';
import { safetyTool } from './safety.js';
import { vaultTool } from './vault.js';
import { memoryTool } from './memory.js';
import { memoryPolicyTool } from './memory-policy.js';

/**
 * The tools, in the order tools/list shows them. Extension-backed ones forward
 * by name; batch and safety settings run in the MCP process.
 *
 * This list lives here rather than in index.ts (which re-exports it) because
 * browser_batch runs its siblings by name: while the list lived in the barrel,
 * tools/index.ts -> tools/batch.ts -> tools/index.ts was an import cycle.
 */
export const allTools: ToolDefinition[] = [
  navigateTool,
  tabsTool,
  snapshotTool,
  textTool,
  screenshotTool,
  clickTool,
  typeTool,
  fillTool,
  scrollTool,
  waitTool,
  evaluateTool,
  dialogTool,
  batchTool,
  emulateTool,
  logsTool,
  mockTool,
  inspectElementTool,
  safetyTool,
  vaultTool,
  memoryTool,
  memoryPolicyTool,
];

export const toolMap = new Map<string, ToolDefinition>(
  allTools.map((t) => [t.name, t]),
);

/**
 * Bridge timeouts for wire actions the daemon sends that are not tools: the memory context read is bounded like
 * browser_memory itself, so it never falls back to the bridge's 30 s default.
 */
export const internalWireTimeouts: ReadonlyMap<string, number> = new Map([['browser_memory_internal_context', 10_000]]);

/** Browser_batch resolves its steps through the map above. */
useToolRegistry((name) => toolMap.get(name));
