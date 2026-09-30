import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import type { ToolDefinition, ToolResult } from './types.js';
import { optionalTabId, textResult, jsonError } from './types.js';
import { STATE_DIR } from '../daemon-config.js';

/**
 * Saved, replayable action sequences — Browser Controller's counterpart of
 * Claude-in-Chrome's shortcuts. A shortcut is a named browser_batch with
 * {{variables}}: save once, then `run` it in ONE call with different values.
 * Stored locally in ~/.browser-controller/shortcuts.json (BC_SHORTCUTS_FILE
 * overrides); nothing leaves the machine.
 */

interface Shortcut {
  name: string;
  description?: string;
  actions: Array<{ tool: string; params?: Record<string, unknown> }>;
  variables: string[];
  createdAt: string;
  updatedAt: string;
}

const NAME = /^[\w.-]{1,64}$/;
const VAR = /\{\{\s*([\w.-]+)\s*\}\}/g;

export function shortcutsFile(): string {
  return process.env.BC_SHORTCUTS_FILE || path.join(STATE_DIR, 'shortcuts.json');
}

function load(): Record<string, Shortcut> {
  try {
    const data = JSON.parse(fs.readFileSync(shortcutsFile(), 'utf8')) as { shortcuts?: Record<string, Shortcut> };
    return data && typeof data.shortcuts === 'object' && data.shortcuts ? data.shortcuts : {};
  } catch {
    return {};
  }
}

function save(all: Record<string, Shortcut>): void {
  const file = shortcutsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, shortcuts: all }, null, 2));
  fs.renameSync(tmp, file);
}

/** Every {{variable}} used anywhere in the actions. */
export function variablesOf(actions: unknown): string[] {
  const found = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === 'string') for (const m of v.matchAll(VAR)) found.add(m[1]!);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(actions);
  return [...found].sort();
}

/** Replace {{variables}}. A string that is exactly one variable keeps the value's type (numbers, booleans). */
export function substitute(value: unknown, vars: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    const whole = value.match(/^\{\{\s*([\w.-]+)\s*\}\}$/);
    if (whole && whole[1]! in vars) return vars[whole[1]!];
    return value.replace(VAR, (m, k: string) => (k in vars ? String(vars[k]) : m));
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, vars));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, vars)]));
  }
  return value;
}

const summaryOf = (s: Shortcut) => ({
  name: s.name, ...(s.description ? { description: s.description } : {}), steps: s.actions.length,
  ...(s.variables.length ? { variables: s.variables } : {}), updatedAt: s.updatedAt,
});

export const shortcutsTool: ToolDefinition = {
  name: 'browser_shortcuts',
  summary: 'Save and replay named action sequences (with {{variables}})',
  description:
    'Saved, replayable browser workflows. save stores a named list of steps (same format as browser_batch actions; put {{variable}} placeholders in any string param), run replays it in ONE call with vars filled in (it runs as a browser_batch: stops at the first failing step unless continueOnError), list/show/delete manage them. Stored locally in ~/.browser-controller/shortcuts.json.',
  inputSchema: z.object({
    action: z.enum(['list', 'show', 'save', 'run', 'delete']).describe('Shortcut action'),
    name: z.string().optional().describe('Shortcut name (letters, digits, _ . -)'),
    description: z.string().max(500).optional().describe('save: what it does / when to use it'),
    actions: z.array(z.object({
      tool: z.string(),
      params: z.record(z.string(), z.unknown()).optional(),
    })).max(200).optional().describe('save: the steps, like browser_batch actions'),
    vars: z.record(z.string(), z.unknown()).optional().describe('run: values for the {{variables}}'),
    tabId: optionalTabId().describe('run: default tab for every step without its own tabId'),
    continueOnError: z.boolean().optional().describe('run: keep going after a failing step'),
    output: z.enum(['all', 'last', 'errors']).optional().describe('run: like browser_batch output (default last)'),
  }),
  // A run can hold up to 200 steps, like browser_batch.
  timeoutMs: 300_000,
  async handler(host, params): Promise<ToolResult> {
    const p = params as {
      action: 'list' | 'show' | 'save' | 'run' | 'delete'; name?: string; description?: string;
      actions?: Shortcut['actions']; vars?: Record<string, unknown>; tabId?: number;
      continueOnError?: boolean; output?: 'all' | 'last' | 'errors';
    };
    const all = load();
    if (p.action === 'list') {
      return textResult(JSON.stringify({ success: true, shortcuts: Object.values(all).map(summaryOf) }));
    }
    if (!p.name || !NAME.test(p.name)) return jsonError({ success: false, error: 'name is required (letters, digits, _ . -, max 64)' });
    const existing = all[p.name];
    switch (p.action) {
      case 'show':
        if (!existing) return jsonError({ success: false, error: `No shortcut "${p.name}"` });
        return textResult(JSON.stringify({ success: true, shortcut: existing }));
      case 'delete':
        if (!existing) return jsonError({ success: false, error: `No shortcut "${p.name}"` });
        delete all[p.name];
        save(all);
        return textResult(JSON.stringify({ success: true, deleted: p.name }));
      case 'save': {
        if (!p.actions || p.actions.length === 0) return jsonError({ success: false, error: 'actions (non-empty) are required to save a shortcut' });
        const bad = p.actions.find((a) => a.tool === 'browser_batch' || a.tool === 'browser_shortcuts' || a.tool === 'browser_tools');
        if (bad) return jsonError({ success: false, error: `${bad.tool} cannot be a shortcut step` });
        const now = new Date().toISOString();
        all[p.name] = {
          name: p.name,
          ...(p.description ? { description: p.description } : existing?.description ? { description: existing.description } : {}),
          actions: p.actions,
          variables: variablesOf(p.actions),
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        save(all);
        return textResult(JSON.stringify({ success: true, saved: summaryOf(all[p.name]!), file: shortcutsFile() }));
      }
      case 'run': {
        if (!existing) return jsonError({ success: false, error: `No shortcut "${p.name}"` });
        const vars = p.vars ?? {};
        const missing = existing.variables.filter((v) => !(v in vars));
        if (missing.length) return jsonError({ success: false, error: `Missing vars: ${missing.join(', ')}`, variables: existing.variables });
        const actions = substitute(existing.actions, vars) as Shortcut['actions'];
        // Lazy, through the registry: batch.ts and the registry import each
        // other, and the registry imports this module.
        const { toolMap } = await import('./index.js');
        const batchTool = toolMap.get('browser_batch')!;
        return batchTool.handler(host, {
          ...(p.tabId !== undefined ? { tabId: p.tabId } : {}),
          actions,
          continueOnError: p.continueOnError ?? false,
          output: p.output ?? 'last',
        });
      }
      default:
        return jsonError({ success: false, error: `Unknown action ${String(p.action)}` });
    }
  },
};
