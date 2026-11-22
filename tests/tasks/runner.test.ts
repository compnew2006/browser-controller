import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { saveTask } from '../../mcp-server/src/tasks/store.js';
import { planTask } from '../../mcp-server/src/tasks/planner.js';
import { isMutatingTool, runTask } from '../../mcp-server/src/tasks/runner.js';
import type { Task } from '../../mcp-server/src/tasks/types.js';
import type { ToolDefinition, ToolHost, ToolResult } from '../../mcp-server/src/tools/types.js';
import { failureResult, textResult } from '../../mcp-server/src/tools/types.js';
import { toolMap } from '../../mcp-server/src/tools/registry.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-tasks-runner-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A fake tool that records its calls and answers with a fixed result. */
function fakeTool(
  name: string,
  calls: string[],
  result: ToolResult | Error,
  idempotent = true,
  inputSchema: z.ZodObject<z.ZodRawShape> = z.object({}).strict(),
  onCall?: (params: Record<string, unknown>) => void,
): ToolDefinition {
  return {
    name,
    summary: `Fake ${name} for runner tests`,
    description: `Test-only stand-in for ${name}.`,
    inputSchema,
    ...(idempotent ? { idempotent: true as const } : {}),
    handler: async (_host, params) => {
      calls.push(name);
      onCall?.(params);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

function twoStepTask(id = 'task-1'): Task {
  return {
    id,
    goal: 'Open the example page and confirm it loaded',
    constraints: ['read-only'],
    steps: [
      { tool: 'fake-ok', params: {}, verify: [{ kind: 'no-error-text', value: "isn't working" }] },
      { tool: 'fake-next', params: {}, verify: [{ kind: 'no-error-text', value: "isn't working" }] },
    ],
    state: 'planned',
    evidence: [],
  };
}

/** A host fake tools ignore; its only job is to let the runner call the snapshot tool. */
const dummyHost: ToolHost = {
  callTool: async () => {
    throw new Error('no extension in test');
  },
};

const tabSchema = z.object({ tabId: z.number().optional() }).strict();

/** A fake `browser_snapshot` answering with fixed page text (its calls go to `calls`). */
function snapshotTool(calls: string[], text: string): ToolDefinition {
  return fakeTool('browser_snapshot', calls, textResult(text), true, tabSchema);
}

describe('planner', () => {
  it('splits a goal with a URL into navigate and snapshot steps', () => {
    const task = planTask('Open https://example.com and confirm it loaded', ['read-only']);
    expect(task.state).toBe('planned');
    expect(task.goal).toBe('Open https://example.com and confirm it loaded');
    expect(task.constraints).toEqual(['read-only']);
    expect(task.evidence).toEqual([]);
    expect(task.steps[0]?.tool).toBe('browser_navigate');
    expect(task.steps[0]?.params).toEqual({ url: 'https://example.com' });
    expect(task.steps[1]?.tool).toBe('browser_snapshot');
    // Every step carries at least one verify rule.
    for (const step of task.steps) expect(step.verify.length).toBeGreaterThanOrEqual(1);
    expect(task.steps[0]?.verify).toContainEqual({ kind: 'url-contains', value: 'example.com' });
  });

  it('plans a tabs-list step and then a snapshot when the goal names no URL', () => {
    const task = planTask('Check what the current page shows', []);
    expect(task.steps.map((step) => step.tool)).toEqual(['browser_tabs', 'browser_snapshot']);
    expect(task.steps[0]?.params).toEqual({ action: 'list' });
    for (const step of task.steps) expect(step.verify.length).toBeGreaterThanOrEqual(1);
  });

  it('strips sentence punctuation after a URL in the goal', () => {
    const task = planTask('Open https://example.com.', []);
    expect(task.steps[0]?.params).toEqual({ url: 'https://example.com' });
    expect(task.steps[0]?.verify).toContainEqual({ kind: 'url-contains', value: 'example.com' });
  });

  it('rejects an empty goal', () => {
    expect(() => planTask('   ', [])).toThrowError(/goal/);
  });
});

describe('runner', () => {
  it('test_runner_stops_at_failed_verification', async () => {
    const calls: string[] = [];
    const snapshotCalls: string[] = [];
    const tools = new Map<string, ToolDefinition>([
      ['fake-ok', fakeTool('fake-ok', calls, textResult('page loaded'))],
      ['fake-next', fakeTool('fake-next', calls, textResult('next page'))],
      ['browser_snapshot', snapshotTool(snapshotCalls, 'page loaded')],
    ]);
    await saveTask(twoStepTask(), dir);

    const done = await runTask('task-1', {
      tasksDir: dir,
      tools,
      host: dummyHost,
      verify: (_step, snapshot) => ({ ok: false, evidence: `page shows an error: ${snapshot.text}` }),
    });

    expect(done.state).toBe('failed');
    expect(done.steps[0]?.result?.status).toBe('verify-failed');
    expect(done.steps[1]?.result).toBeUndefined();
    expect(calls).toEqual(['fake-ok']);
    expect(snapshotCalls).toEqual(['browser_snapshot']);
    expect(done.evidence.join('\n')).toContain('page shows an error: page loaded');
  });

  it('runs every step in order and finishes done when all verify', async () => {
    const calls: string[] = [];
    const snapshotCalls: string[] = [];
    const tools = new Map<string, ToolDefinition>([
      ['fake-ok', fakeTool('fake-ok', calls, textResult('page loaded'))],
      ['fake-next', fakeTool('fake-next', calls, textResult('next page'))],
      ['browser_snapshot', snapshotTool(snapshotCalls, 'page loaded')],
    ]);
    await saveTask(twoStepTask(), dir);

    const done = await runTask('task-1', {
      tasksDir: dir,
      tools,
      host: dummyHost,
      verify: () => ({ ok: true, evidence: 'checked' }),
    });

    expect(done.state).toBe('done');
    expect(calls).toEqual(['fake-ok', 'fake-next']);
    expect(snapshotCalls).toEqual(['browser_snapshot', 'browser_snapshot']);
    expect(done.steps.map((step) => step.result?.status)).toEqual(['ok', 'ok']);
    expect(done.evidence.length).toBe(2);
  });

  it('stops at a tool that returns an error result', async () => {
    const calls: string[] = [];
    const tools = new Map<string, ToolDefinition>([
      ['fake-ok', fakeTool('fake-ok', calls, failureResult('NAVIGATION_FAILED: no network'))],
      ['fake-next', fakeTool('fake-next', calls, textResult('next page'))],
    ]);
    await saveTask(twoStepTask(), dir);

    const done = await runTask('task-1', {
      tasksDir: dir,
      tools,
      verify: () => ({ ok: true, evidence: 'checked' }),
    });

    expect(done.state).toBe('failed');
    expect(done.steps[0]?.result?.status).toBe('failed');
    expect(done.steps[0]?.result?.detail).toContain('NAVIGATION_FAILED');
    expect(calls).toEqual(['fake-ok']);
  });

  it('stops at a tool that throws', async () => {
    const calls: string[] = [];
    const tools = new Map<string, ToolDefinition>([
      ['fake-ok', fakeTool('fake-ok', calls, new Error('TIMEOUT: tab did not respond'))],
      ['fake-next', fakeTool('fake-next', calls, textResult('next page'))],
    ]);
    await saveTask(twoStepTask(), dir);

    const done = await runTask('task-1', { tasksDir: dir, tools });
    expect(done.state).toBe('failed');
    expect(done.steps[0]?.result?.status).toBe('failed');
    expect(done.steps[0]?.result?.detail).toContain('TIMEOUT');
    expect(calls).toEqual(['fake-ok']);
  });

  it('refuses a mutating step without explicit approval and never runs it', async () => {
    const calls: string[] = [];
    const tools = new Map<string, ToolDefinition>([
      ['fake-click', fakeTool('fake-click', calls, textResult('clicked'), false)],
    ]);
    await saveTask(
      {
        id: 'task-1',
        goal: 'Click the submit button',
        constraints: ['read-only'],
        steps: [{ tool: 'fake-click', params: {}, verify: [{ kind: 'no-error-text', value: "isn't working" }] }],
        state: 'planned',
        evidence: [],
      },
      dir,
    );

    const done = await runTask('task-1', { tasksDir: dir, tools });
    expect(done.state).toBe('failed');
    expect(calls).toEqual([]);
    expect(done.steps[0]?.result?.status).toBe('failed');
    expect(done.steps[0]?.result?.detail).toMatch(/refused.*approval/i);
    expect(done.evidence.join('\n')).toMatch(/refused.*approval/i);
  });

  it('runs a mutating step when the task explicitly allows mutations', async () => {
    const calls: string[] = [];
    const snapshotCalls: string[] = [];
    const tools = new Map<string, ToolDefinition>([
      ['fake-click', fakeTool('fake-click', calls, textResult('clicked'), false)],
      ['browser_snapshot', snapshotTool(snapshotCalls, 'clicked')],
    ]);
    await saveTask(
      {
        id: 'task-1',
        goal: 'Click the submit button',
        constraints: ['allow-mutations'],
        steps: [{ tool: 'fake-click', params: {}, verify: [{ kind: 'no-error-text', value: "isn't working" }] }],
        state: 'planned',
        evidence: [],
      },
      dir,
    );

    const done = await runTask('task-1', {
      tasksDir: dir,
      tools,
      host: dummyHost,
      verify: () => ({ ok: true, evidence: 'checked' }),
    });
    expect(done.state).toBe('done');
    expect(calls).toEqual(['fake-click']);
    expect(snapshotCalls).toEqual(['browser_snapshot']);
  });

  it('fails a step whose tool is not registered and runs nothing after it', async () => {
    const calls: string[] = [];
    const tools = new Map<string, ToolDefinition>([
      ['fake-next', fakeTool('fake-next', calls, textResult('next page'))],
    ]);
    await saveTask(
      {
        ...twoStepTask(),
        steps: [
          { tool: 'no-such-tool', params: {}, verify: [{ kind: 'no-error-text', value: "isn't working" }] },
          { tool: 'fake-next', params: {}, verify: [{ kind: 'no-error-text', value: "isn't working" }] },
        ],
      },
      dir,
    );

    const done = await runTask('task-1', { tasksDir: dir, tools });
    expect(done.state).toBe('failed');
    expect(done.steps[0]?.result?.status).toBe('failed');
    expect(done.steps[0]?.result?.detail).toContain('unknown tool');
    expect(calls).toEqual([]);
  });

  it('resumes from the first unfinished step and keeps completed work', async () => {
    const calls: string[] = [];
    const snapshotCalls: string[] = [];
    const tools = new Map<string, ToolDefinition>([
      ['fake-ok', fakeTool('fake-ok', calls, textResult('page loaded'))],
      ['fake-next', fakeTool('fake-next', calls, textResult('next page'))],
      ['browser_snapshot', snapshotTool(snapshotCalls, 'next page')],
    ]);
    const task = twoStepTask();
    task.steps[0]!.result = { status: 'ok', detail: 'already done' };
    task.state = 'paused-login';
    await saveTask(task, dir);

    const done = await runTask('task-1', {
      tasksDir: dir,
      tools,
      host: dummyHost,
      verify: () => ({ ok: true, evidence: 'checked' }),
    });
    expect(done.state).toBe('done');
    expect(calls).toEqual(['fake-next']);
    expect(snapshotCalls).toEqual(['browser_snapshot']);
    expect(done.steps[0]?.result).toEqual({ status: 'ok', detail: 'already done' });
  });

  it('rejects a task that was never saved', async () => {
    await expect(runTask('missing', { tasksDir: dir })).rejects.toThrowError(/not found/);
  });
});

describe('runner verification through the real verifier', () => {
  const navigateSchema = z.object({ url: z.string(), incognito: z.boolean().optional() }).strict();
  const navigateTask: Task = {
    id: 'task-1',
    goal: 'Open the example page',
    constraints: ['read-only'],
    steps: [
      {
        tool: 'browser_navigate',
        params: { url: 'https://example.com' },
        verify: [{ kind: 'no-error-text', value: "isn't working" }],
      },
    ],
    state: 'planned',
    evidence: [],
  };

  it('fails a navigation that landed on an error page, even though the navigate call succeeded', async () => {
    const calls: string[] = [];
    const tools = new Map<string, ToolDefinition>([
      ['browser_navigate', fakeTool('browser_navigate', calls, textResult('loaded'), false, navigateSchema)],
      [
        'browser_snapshot',
        fakeTool('browser_snapshot', calls, textResult("This page isn't working"), true, tabSchema),
      ],
    ]);
    await saveTask(navigateTask, dir);

    const done = await runTask('task-1', { tasksDir: dir, tools, host: dummyHost });
    expect(done.state).toBe('failed');
    expect(done.steps[0]?.result?.status).toBe('verify-failed');
    expect(done.steps[0]?.result?.detail).toContain("isn't working");
    expect(calls).toEqual(['browser_navigate', 'browser_snapshot']);
  });

  it('verifies a snapshot step against its own result without reading the page twice', async () => {
    const calls: string[] = [];
    const tools = new Map<string, ToolDefinition>([
      [
        'browser_snapshot',
        fakeTool('browser_snapshot', calls, textResult("This page isn't working"), true, tabSchema),
      ],
    ]);
    await saveTask(
      {
        id: 'task-1',
        goal: 'Read the page',
        constraints: ['read-only'],
        steps: [{ tool: 'browser_snapshot', params: {}, verify: [{ kind: 'no-error-text', value: "isn't working" }] }],
        state: 'planned',
        evidence: [],
      },
      dir,
    );

    const done = await runTask('task-1', { tasksDir: dir, tools, host: dummyHost });
    expect(done.state).toBe('failed');
    expect(done.steps[0]?.result?.status).toBe('verify-failed');
    expect(calls).toEqual(['browser_snapshot']);
  });

  it('fails verification when the snapshot read itself fails', async () => {
    const calls: string[] = [];
    const tools = new Map<string, ToolDefinition>([
      ['browser_navigate', fakeTool('browser_navigate', calls, textResult('loaded'), false, navigateSchema)],
      [
        'browser_snapshot',
        fakeTool('browser_snapshot', calls, new Error('TAB_FROZEN: tab did not respond'), true, tabSchema),
      ],
    ]);
    await saveTask(navigateTask, dir);

    const done = await runTask('task-1', { tasksDir: dir, tools, host: dummyHost });
    expect(done.state).toBe('failed');
    expect(done.steps[0]?.result?.status).toBe('verify-failed');
    expect(done.steps[0]?.result?.detail).toContain('snapshot unavailable');
  });

  it('fails verification when no snapshot tool is available, instead of trusting the step result', async () => {
    const calls: string[] = [];
    const tools = new Map<string, ToolDefinition>([
      ['fake-ok', fakeTool('fake-ok', calls, textResult("This page isn't working"))],
    ]);
    await saveTask(
      {
        id: 'task-1',
        goal: 'Open the page',
        constraints: ['read-only'],
        steps: [{ tool: 'fake-ok', params: {}, verify: [{ kind: 'no-error-text', value: "isn't working" }] }],
        state: 'planned',
        evidence: [],
      },
      dir,
    );

    const done = await runTask('task-1', { tasksDir: dir, tools });
    expect(done.state).toBe('failed');
    expect(done.steps[0]?.result?.status).toBe('verify-failed');
    expect(done.steps[0]?.result?.detail).toContain('snapshot unavailable');
    expect(calls).toEqual(['fake-ok']);
  });

  it('verifies a step against its own explicit tab, not the bound tab', async () => {
    const calls: string[] = [];
    const seen: Array<Record<string, unknown>> = [];
    // The bound tab (42) shows an error page; the step's own tab (99) is clean.
    // Reading the wrong tab would fail this step.
    const snapshotPerTab: ToolDefinition = {
      name: 'browser_snapshot',
      summary: 'Fake browser_snapshot',
      description: 'Test-only stand-in for browser_snapshot.',
      inputSchema: tabSchema,
      idempotent: true,
      handler: async (_host, params) => {
        seen.push(params);
        return params.tabId === 42 ? textResult("This page isn't working") : textResult('page text');
      },
    };
    const tools = new Map<string, ToolDefinition>([
      ['fake-act', fakeTool('fake-act', calls, textResult('acted'), true, tabSchema)],
      ['browser_snapshot', snapshotPerTab],
    ]);
    await saveTask(
      {
        id: 'task-1',
        goal: 'Act on tab 99 while bound to tab 42',
        constraints: ['read-only'],
        steps: [
          {
            tool: 'fake-act',
            params: { tabId: 42 },
            verify: [{ kind: 'no-error-text', value: "isn't working" }],
            result: { status: 'ok', detail: 'already done' },
          },
          {
            tool: 'fake-act',
            params: { tabId: 99 },
            verify: [{ kind: 'no-error-text', value: "isn't working" }],
          },
        ],
        state: 'planned',
        evidence: [],
      },
      dir,
    );

    const done = await runTask('task-1', { tasksDir: dir, tools, host: dummyHost });
    expect(done.state).toBe('done');
    expect(calls).toEqual(['fake-act']);
    expect(seen).toEqual([{ tabId: 99 }]);
    expect(done.steps[1]?.result?.status).toBe('ok');
  });
});

describe('isMutatingTool', () => {
  const def = (name: string, idempotent?: boolean): ToolDefinition => ({
    name,
    summary: `Fake ${name}`,
    description: `Test-only stand-in for ${name}.`,
    inputSchema: z.object({}).strict(),
    ...(idempotent === true ? { idempotent: true as const } : {}),
    handler: async () => textResult('ok'),
  });

  it('treats an idempotent read as non-mutating', () => {
    expect(isMutatingTool(def('browser_snapshot', true), {})).toBe(false);
  });

  it('treats an unknown non-idempotent tool as mutating (fail-closed)', () => {
    expect(isMutatingTool(def('fake-click'), {})).toBe(true);
  });

  it('treats a plain-URL navigate as a read', () => {
    expect(isMutatingTool(def('browser_navigate'), { url: 'https://example.com' })).toBe(false);
  });

  it('treats back/forward/reload navigations as mutating', () => {
    for (const url of ['back', 'forward', 'reload']) {
      expect(isMutatingTool(def('browser_navigate'), { url })).toBe(true);
    }
  });

  it('treats an incognito navigate as mutating', () => {
    expect(isMutatingTool(def('browser_navigate'), { url: 'https://example.com', incognito: true })).toBe(true);
  });

  it('treats reading logs as a read and clearing them as mutating', () => {
    expect(isMutatingTool(def('browser_logs'), { tabId: 1 })).toBe(false);
    expect(isMutatingTool(def('browser_logs'), { tabId: 1, clear: true })).toBe(true);
  });

  it('treats tabs list/profiles/focus/session-read as reads and close/session-set/browser-select as mutating', () => {
    expect(isMutatingTool(def('browser_tabs'), {})).toBe(false);
    expect(isMutatingTool(def('browser_tabs'), { action: 'list' })).toBe(false);
    expect(isMutatingTool(def('browser_tabs'), { action: 'profiles' })).toBe(false);
    expect(isMutatingTool(def('browser_tabs'), { action: 'focus', tabId: 1 })).toBe(false);
    expect(isMutatingTool(def('browser_tabs'), { action: 'session' })).toBe(false);
    expect(isMutatingTool(def('browser_tabs'), { action: 'close', tabId: 1 })).toBe(true);
    expect(isMutatingTool(def('browser_tabs'), { action: 'session', isolation: 'isolated' })).toBe(true);
    expect(isMutatingTool(def('browser_tabs'), { action: 'session', access: 'read-only' })).toBe(true);
    expect(isMutatingTool(def('browser_tabs'), { browser: 'auto' })).toBe(true);
  });
});

describe('P4 navigate exception', () => {
  it('runs a plain-URL navigate without approval while refusing a mutating tool in the same task', async () => {
    const calls: string[] = [];
    const snapshotCalls: string[] = [];
    const navigateSchema = z.object({ url: z.string(), incognito: z.boolean().optional() }).strict();
    const tools = new Map<string, ToolDefinition>([
      ['browser_navigate', fakeTool('browser_navigate', calls, textResult('loaded'), false, navigateSchema)],
      ['browser_click', fakeTool('browser_click', calls, textResult('clicked'), false)],
      ['browser_snapshot', snapshotTool(snapshotCalls, 'loaded')],
    ]);
    await saveTask(
      {
        id: 'task-1',
        goal: 'Open the page, then click',
        constraints: ['read-only'],
        steps: [
          { tool: 'browser_navigate', params: { url: 'https://example.com' }, verify: [{ kind: 'no-error-text', value: "isn't working" }] },
          { tool: 'browser_click', params: {}, verify: [{ kind: 'no-error-text', value: "isn't working" }] },
        ],
        state: 'planned',
        evidence: [],
      },
      dir,
    );

    const done = await runTask('task-1', { tasksDir: dir, tools, host: dummyHost });
    expect(done.state).toBe('failed');
    expect(calls).toEqual(['browser_navigate']);
    expect(snapshotCalls).toEqual(['browser_snapshot']);
    expect(done.steps[1]?.result?.status).toBe('failed');
    expect(done.steps[1]?.result?.detail).toMatch(/refused.*approval/i);
  });

  it('refuses a reload navigate without approval', async () => {
    const calls: string[] = [];
    const navigateSchema = z.object({ url: z.string(), incognito: z.boolean().optional() }).strict();
    const tools = new Map<string, ToolDefinition>([
      ['browser_navigate', fakeTool('browser_navigate', calls, textResult('loaded'), false, navigateSchema)],
    ]);
    await saveTask(
      {
        id: 'task-1',
        goal: 'Reload the page',
        constraints: ['read-only'],
        steps: [{ tool: 'browser_navigate', params: { url: 'reload' }, verify: [{ kind: 'no-error-text', value: "isn't working" }] }],
        state: 'planned',
        evidence: [],
      },
      dir,
    );

    const done = await runTask('task-1', { tasksDir: dir, tools });
    expect(done.state).toBe('failed');
    expect(calls).toEqual([]);
    expect(done.steps[0]?.result?.detail).toMatch(/refused.*approval/i);
  });
});

/** A fake extension host answering the real registry tools. */
function registryHost(calls: Array<{ tool: string; params: Record<string, unknown> }>): ToolHost {
  return {
    callTool: async (tool, params) => {
      calls.push({ tool, params });
      if (tool === 'browser_navigate') return { success: true, tabId: 42, text: 'loaded', url: 'https://example.com' };
      if (tool === 'browser_evaluate') return { success: true, result: '120:0', text: '120:0' };
      if (tool === 'browser_tabs') {
        return { success: true, text: '7 [own] Example https://example.com', tabs: [{ tabId: 7, role: 'own' }], openTabCount: 1 };
      }
      if (tool === 'browser_snapshot') {
        return { success: true, tabId: typeof params.tabId === 'number' ? params.tabId : 42, text: 'page text', url: 'https://example.com' };
      }
      throw new Error(`unexpected tool call: ${tool}`);
    },
  };
}

describe('runner against the real registry', () => {
  it('runs a planned URL task: the snapshot is bound to the tab the navigate opened', async () => {
    const calls: Array<{ tool: string; params: Record<string, unknown> }> = [];
    const task = planTask('Open https://example.com and confirm it loaded', ['read-only']);
    await saveTask(task, dir);

    const done = await runTask(task.id, { tasksDir: dir, host: registryHost(calls) });
    expect(done.state).toBe('done');
    expect(calls.find((call) => call.tool === 'browser_navigate')?.params).toEqual({ url: 'https://example.com' });
    expect(calls.find((call) => call.tool === 'browser_snapshot')?.params).toEqual({ tabId: 42, maxChars: 50000 });
  });

  it('runs a planned no-URL task: the snapshot is bound to the first listed tab', async () => {
    const calls: Array<{ tool: string; params: Record<string, unknown> }> = [];
    const task = planTask('Check what the current page shows', ['read-only']);
    await saveTask(task, dir);

    const done = await runTask(task.id, { tasksDir: dir, host: registryHost(calls) });
    expect(done.state).toBe('done');
    expect(calls.find((call) => call.tool === 'browser_tabs')?.params).toEqual({ action: 'list' });
    expect(calls.find((call) => call.tool === 'browser_snapshot')?.params).toEqual({ tabId: 7, maxChars: 50000 });
  });

  it('fails a snapshot with no tab to bind to, with evidence, and never calls the tool', async () => {
    const calls: Array<{ tool: string; params: Record<string, unknown> }> = [];
    await saveTask(
      {
        id: 'task-1',
        goal: 'Read the page',
        constraints: ['read-only'],
        steps: [{ tool: 'browser_snapshot', params: {}, verify: [{ kind: 'no-error-text', value: "isn't working" }] }],
        state: 'planned',
        evidence: [],
      },
      dir,
    );

    const done = await runTask('task-1', { tasksDir: dir, host: registryHost(calls) });
    expect(done.state).toBe('failed');
    expect(done.steps[0]?.result?.status).toBe('failed');
    expect(done.steps[0]?.result?.detail).toMatch(/tabId is required/);
    expect(calls).toEqual([]);
  });

  it('resumes a planned task from the tab recorded on its completed navigate step', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const calls: string[] = [];
    const tabSchema = z.object({ tabId: z.number().optional(), url: z.string().optional(), action: z.string().optional() }).strict();
    const tools = new Map<string, ToolDefinition>([
      ['browser_navigate', fakeTool('browser_navigate', calls, textResult('loaded'), false, tabSchema)],
      ['browser_snapshot', fakeTool('browser_snapshot', calls, textResult('page text'), true, tabSchema, (params) => seen.push(params))],
    ]);
    const task = planTask('Open https://example.com and confirm it loaded', ['read-only']);
    // As if a previous run completed the navigate and recorded its tab.
    task.steps[0]!.params = { url: 'https://example.com', tabId: 42 };
    task.steps[0]!.result = { status: 'ok', detail: 'loaded' };
    task.state = 'paused-login';
    await saveTask(task, dir);

    const done = await runTask(task.id, { tasksDir: dir, tools });
    expect(done.state).toBe('done');
    expect(calls).toEqual(['browser_snapshot']);
    expect(seen).toEqual([{ tabId: 42 }]);
  });
});

describe('registry mutation guard', () => {
  // Tools whose `idempotent: true` is a read: the gate trusts the flag for
  // these, so a new idempotent tool must be added here deliberately — a
  // future idempotent-but-writing tool fails this test instead of sailing
  // through the read-only gate.
  const KNOWN_IDEMPOTENT_READS = new Set([
    'browser_snapshot',
    'browser_text',
    'browser_screenshot',
    'browser_inspect_element',
    'browser_fetch_many',
    'browser_memory',
    'browser_site_map',
  ]);
  // Non-idempotent tools whose read/write depends on the action (see isMutatingTool).
  const MIXED_TOOLS = new Set(['browser_navigate', 'browser_logs', 'browser_tabs']);
  // Non-idempotent tools that always write (fail-closed default).
  const KNOWN_WRITES = new Set([
    'browser_click',
    'browser_type',
    'browser_fill',
    'browser_scroll',
    'browser_wait',
    'browser_evaluate',
    'browser_handle_dialog',
    'browser_batch',
    'browser_emulate',
    'browser_mock',
    'browser_safety',
    'browser_vault',
    'browser_memory_policy',
  ]);

  it('classifies every registered tool: idempotent reads, mixed, or writes', () => {
    for (const name of KNOWN_IDEMPOTENT_READS) expect(toolMap.has(name)).toBe(true);
    for (const name of MIXED_TOOLS) expect(toolMap.has(name)).toBe(true);
    for (const name of KNOWN_WRITES) expect(toolMap.has(name)).toBe(true);
    for (const tool of toolMap.values()) {
      if (tool.idempotent === true) {
        expect(KNOWN_IDEMPOTENT_READS.has(tool.name)).toBe(true);
      } else {
        expect(MIXED_TOOLS.has(tool.name) || KNOWN_WRITES.has(tool.name)).toBe(true);
      }
    }
    expect(toolMap.size).toBe(KNOWN_IDEMPOTENT_READS.size + MIXED_TOOLS.size + KNOWN_WRITES.size);
  });

  it('applies the per-action rules to the real registry definitions', () => {
    const navigate = toolMap.get('browser_navigate')!;
    const logs = toolMap.get('browser_logs')!;
    const tabs = toolMap.get('browser_tabs')!;
    expect(isMutatingTool(navigate, { url: 'https://example.com' })).toBe(false);
    expect(isMutatingTool(navigate, { url: 'reload' })).toBe(true);
    expect(isMutatingTool(navigate, { url: 'https://example.com', incognito: true })).toBe(true);
    expect(isMutatingTool(logs, { tabId: 1 })).toBe(false);
    expect(isMutatingTool(logs, { tabId: 1, clear: true })).toBe(true);
    expect(isMutatingTool(tabs, { action: 'list' })).toBe(false);
    expect(isMutatingTool(tabs, { action: 'close', tabId: 1 })).toBe(true);
  });
});
