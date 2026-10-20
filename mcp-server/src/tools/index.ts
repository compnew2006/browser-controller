import { z } from 'zod';
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
import { batchTool } from './batch.js';
import { emulateTool } from './emulate.js';
import { logsTool } from './logs.js';
import { mockTool } from './mock.js';
import { inspectElementTool } from './inspect-element.js';

/** The 17 tools, in the order tools/list shows them. Extension-backed ones forward by name; batch runs in the MCP process. */
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
];

export const toolMap = new Map<string, ToolDefinition>(
  allTools.map((t) => [t.name, t]),
);

export type ToolCapability = 'read' | 'write' | 'mixed';

export interface ToolManifestEntry {
  name: string;
  summary: string;
  description: string;
  inputSchema: unknown;
  timeoutMs: number | undefined;
  idempotent: boolean;
  capability: ToolCapability;
}

function capabilityOf(tool: ToolDefinition): ToolCapability {
  if (tool.idempotent === true) return 'read';
  if (tool.name === 'browser_logs' || tool.name === 'browser_tabs') return 'mixed';
  return 'write';
}

export const toolManifest: ToolManifestEntry[] = allTools.map((tool) => ({
  name: tool.name,
  summary: tool.summary,
  description: tool.description,
  inputSchema: z.toJSONSchema(tool.inputSchema, { io: 'input' }),
  timeoutMs: tool.timeoutMs,
  idempotent: tool.idempotent === true,
  capability: capabilityOf(tool),
}));

/**
 * Whether a tool is safe to retry on timeout, derived from each tool's
 * `idempotent` flag (the single source of truth — see ToolDefinition). This
 * replaces the hand-maintained IDEMPOTENT_TOOLS string set that previously
 * lived in daemon-config.ts and could silently drift from the real registry
 * (audit C1/m5). `browser_logs` is false here despite "looking" like a read,
 * because `clear:true` mutates state (audit M2).
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
