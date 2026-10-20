import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ToolDefinition, ToolResult } from './types.js';
import { optionalTabId, textResult, jsonError } from './types.js';
import { STATE_DIR } from '../daemon-config.js';
import { BATCH_BUDGET_MS, BATCH_MAX_STEPS, NOT_BATCHABLE } from './batch-limits.js';

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

/** Starts with a letter, digit or _, then letters, digits, _ . - (64 characters at most). */
const NAME = /^[A-Za-z0-9_][\w.-]{0,63}$/;
const VAR = /\{\{\s*([\w.-]+)\s*\}\}/g;

export function shortcutsFile(): string {
  return process.env.BC_SHORTCUTS_FILE || path.join(STATE_DIR, 'shortcuts.json');
}

/** Own keys only: a placeholder or a saved name like "constructor" must not resolve through the prototype chain. */
const hasOwn = (obj: object, key: string): boolean => Object.hasOwn(obj, key);
const own = (all: Record<string, Shortcut>, name: string): Shortcut | undefined => (hasOwn(all, name) ? all[name] : undefined);

/**
 * The saved shortcuts. A missing file is an empty set. A file that exists but
 * cannot be parsed is an error, never silently replaced by the next save.
 * The map has no prototype, so a shortcut named "__proto__" is an ordinary key.
 */
function load(): Record<string, Shortcut> {
  const file = shortcutsFile();
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return Object.create(null) as Record<string, Shortcut>;
    throw err;
  }
  let data: { shortcuts?: unknown };
  try {
    data = JSON.parse(raw) as { shortcuts?: unknown };
  } catch (err) {
    throw new Error(`${file} is not valid JSON (${(err as Error).message}); fix or move it, then retry`, { cause: err });
  }
  const out = Object.create(null) as Record<string, Shortcut>;
  if (data && typeof data.shortcuts === 'object' && data.shortcuts !== null && !Array.isArray(data.shortcuts)) {
    for (const [key, value] of Object.entries(data.shortcuts)) out[key] = value as Shortcut;
  }
  return out;
}

/** Atomic replace: write a unique temp file beside the target, then rename it over the target. */
function save(all: Record<string, Shortcut>): void {
  const file = shortcutsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, shortcuts: all }, null, 2));
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Writes run one at a time in this process, and each re-reads the file it
 * changes, so two saves here cannot drop each other's shortcut. Two MCP client
 * processes can still race; the window is then one read and one rename.
 */
let writes: Promise<unknown> = Promise.resolve();
function mutate(task: () => ToolResult): Promise<ToolResult> {
  const run = writes.then(task);
  writes = run.catch(() => undefined);
  return run;
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
    if (whole && hasOwn(vars, whole[1]!)) return vars[whole[1]!];
    return value.replace(VAR, (m, k: string) => (hasOwn(vars, k) ? String(vars[k]) : m));
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, vars));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, vars)]));
  }
  return value;
}

/** Every string in a step (its tool name and all of its params, nested). */
function stringsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => stringsIn(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => stringsIn(v, out));
  return out;
}

/**
 * Save-time checks, before anything is written. Each step must name a browser
 * tool that can run inside a batch, and every {{placeholder}} must be well
 * formed. A templated tool name ("{{t}}") cannot be checked yet: run checks it
 * again after substitution.
 */
async function validateSteps(actions: Shortcut['actions']): Promise<string | null> {
  const { toolMap } = await import('./index.js');
  for (const [i, step] of actions.entries()) {
    const at = `step ${i + 1}`;
    if (!step.tool.includes('{{')) {
      if (NOT_BATCHABLE.has(step.tool)) return `NOT_BATCHABLE: ${at} (${step.tool}) cannot be a shortcut step`;
      if (!toolMap.has(step.tool)) return `UNKNOWN_TOOL: ${at} names no browser tool ("${step.tool}")`;
    }
    for (const text of stringsIn([step.tool, step.params])) {
      // Valid placeholders are removed first; any "{{" left over is malformed.
      if (text.replace(VAR, '').includes('{{')) {
        return `BAD_PLACEHOLDER: ${at} has a malformed {{variable}} (names: letters, digits, _ . -; written as {{name}})`;
      }
    }
  }
  return null;
}

const summaryOf = (s: Shortcut) => ({
  name: s.name, ...(s.description ? { description: s.description } : {}), steps: s.actions.length,
  ...(s.variables.length ? { variables: s.variables } : {}), updatedAt: s.updatedAt,
});

export const shortcutsTool: ToolDefinition = {
  name: 'browser_shortcuts',
  summary: 'Save and replay named action sequences (with {{variables}})',
  description:
    'Saved, replayable browser workflows. save stores a named list of steps (same format as browser_batch actions; put {{variable}} placeholders in any string param; steps are checked on save), run replays it in ONE call with vars filled in (it runs as a browser_batch: stops at the first failing step unless continueOnError), list/show/delete manage them. Stored locally in ~/.browser-controller/shortcuts.json.',
  inputSchema: z.object({
    action: z.enum(['list', 'show', 'save', 'run', 'delete']).describe('Shortcut action'),
    name: z.string().optional().describe('Shortcut name (letters, digits, _ . -; starts with a letter, digit or _)'),
    description: z.string().max(500).optional().describe('save: what it does / when to use it'),
    actions: z.array(z.object({
      tool: z.string(),
      params: z.record(z.string(), z.unknown()).optional(),
    })).max(BATCH_MAX_STEPS).optional().describe('save: the steps, like browser_batch actions'),
    vars: z.record(z.string(), z.unknown()).optional().describe('run: values for the {{variables}}'),
    tabId: optionalTabId().describe('run: default tab for every step without its own tabId'),
    continueOnError: z.boolean().optional().describe('run: keep going after a failing step'),
    output: z.enum(['all', 'last', 'errors']).optional().describe('run: like browser_batch output (default last)'),
  }),
  // A run is a browser_batch, so it has the same step limit and time budget.
  timeoutMs: BATCH_BUDGET_MS,
  async handler(host, params): Promise<ToolResult> {
    const p = params as {
      action: 'list' | 'show' | 'save' | 'run' | 'delete'; name?: string; description?: string;
      actions?: Shortcut['actions']; vars?: Record<string, unknown>; tabId?: number;
      continueOnError?: boolean; output?: 'all' | 'last' | 'errors';
    };
    if (p.action === 'list') {
      return textResult(JSON.stringify({ success: true, shortcuts: Object.values(load()).map(summaryOf) }));
    }
    if (!p.name) return jsonError({ success: false, error: 'name is required' });
    const name = p.name;
    // The name rule applies to new shortcuts only: an existing one saved under an
    // older rule must still be runnable and deletable.
    if (p.action === 'save' && !NAME.test(name)) {
      return jsonError({ success: false, error: 'INVALID_NAME: name must be 1-64 characters: letters, digits, _ . -, starting with a letter, digit or _' });
    }
    switch (p.action) {
      case 'show': {
        const existing = own(load(), name);
        if (!existing) return jsonError({ success: false, error: `No shortcut "${name}"` });
        return textResult(JSON.stringify({ success: true, shortcut: existing }));
      }
      case 'delete':
        return mutate(() => {
          const all = load();
          if (!own(all, name)) return jsonError({ success: false, error: `No shortcut "${name}"` });
          delete all[name];
          save(all);
          return textResult(JSON.stringify({ success: true, deleted: name }));
        });
      case 'save': {
        const actions = p.actions;
        if (!actions || actions.length === 0) return jsonError({ success: false, error: 'actions (non-empty) are required to save a shortcut' });
        // A saved confirm:true would approve a consequential WebMCP tool on every
        // future run; a "{{confirm}}" placeholder keeps the decision per run.
        if (actions.some((a) => a.tool === 'browser_webmcp_call' && a.params?.confirm === true)) {
          return jsonError({
            success: false,
            error: 'browser_webmcp_call steps cannot save confirm:true (it would approve the tool on every future run). Use confirm:"{{confirm}}" and pass vars:{confirm:true} on a run the user approved.',
          });
        }
        const invalid = await validateSteps(actions);
        if (invalid) return jsonError({ success: false, error: invalid });
        return mutate(() => {
          const all = load();
          const existing = own(all, name);
          const now = new Date().toISOString();
          all[name] = {
            name,
            ...(p.description ? { description: p.description } : existing?.description ? { description: existing.description } : {}),
            actions,
            variables: variablesOf(actions),
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
          };
          save(all);
          return textResult(JSON.stringify({ success: true, saved: summaryOf(all[name]!), file: shortcutsFile() }));
        });
      }
      case 'run': {
        const existing = own(load(), name);
        if (!existing) return jsonError({ success: false, error: `No shortcut "${name}"` });
        const vars = p.vars ?? {};
        // A placeholder with no own value is missing, even when its name is an
        // Object.prototype key such as {{constructor}}.
        const missing = existing.variables.filter((v) => !hasOwn(vars, v));
        if (missing.length) {
          return jsonError({ success: false, error: `MISSING_PARAM: Missing vars: ${missing.join(', ')}`, variables: existing.variables });
        }
        const actions = substitute(existing.actions, vars) as Shortcut['actions'];
        // The save-time guard cannot see a templated tool name ("{{t}}"): check
        // again after substitution. Only a confirm:true SAVED in the shortcut is
        // refused; one supplied through vars is this run's own decision.
        const standing = actions.findIndex((a, i) => a.tool === 'browser_webmcp_call' && existing.actions[i]?.params?.confirm === true);
        if (standing !== -1) {
          return jsonError({
            success: false,
            error: `Step ${standing + 1} would call browser_webmcp_call with a saved confirm:true. Re-save it with confirm:"{{confirm}}" and pass vars:{confirm:true} on a run the user approved.`,
          });
        }
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
