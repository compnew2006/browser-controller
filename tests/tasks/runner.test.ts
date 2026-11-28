import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { loadTask, saveTask } from '../../mcp-server/src/tasks/store.js';
import { saveTaskWithReport } from '../../mcp-server/src/tasks/reporting.js';
import { askQuestion } from '../../mcp-server/src/tasks/questions.js';
import { listPendingQuestions, loadPendingQuestion } from '../../mcp-server/src/tasks/question-store.js';
import { runTaskWithReport, configureTaskRunner } from '../../mcp-server/src/tasks/wiring.js';
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

  it('keeps a balanced closing paren in a Wikipedia-style URL', () => {
    const task = planTask('Open https://en.wikipedia.org/wiki/PC_(x) for the specs', []);
    expect(task.steps[0]?.params).toEqual({ url: 'https://en.wikipedia.org/wiki/PC_(x)' });
  });

  it('strips an unbalanced closing paren after a URL', () => {
    const task = planTask('Open https://example.com/foo).', []);
    expect(task.steps[0]?.params).toEqual({ url: 'https://example.com/foo' });
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

  it('a cancel from another process aborts the run instead of being overwritten', async () => {
    const calls: string[] = [];
    const snapshotCalls: string[] = [];
    const tools = new Map<string, ToolDefinition>([
      [
        'fake-ok',
        {
          name: 'fake-ok',
          summary: 'Fake fake-ok for the cross-process cancel test',
          description: 'Test-only stand-in for fake-ok.',
          inputSchema: z.object({}).strict(),
          idempotent: true as const,
          handler: async () => {
            calls.push('fake-ok');
            // The cancel from the other process: the MCP process cancels
            // while the daemon runs this task, so its cancel tool never
            // sees this run in its own in-flight set — it loads the
            // stored record, fails it with the cancellation, and saves
            // it, exactly as `browser_task_cancel` does.
            const stored = await loadTask('task-cancel-race', dir);
            if (!stored) throw new Error('task was never saved');
            stored.state = 'failed';
            stored.cancelled = true;
            stored.evidence.push('cancelled by the user at step 1 of 2 — the task stops here and never resumes');
            await saveTaskWithReport(stored, dir);
            return textResult('page loaded');
          },
        },
      ],
      ['fake-next', fakeTool('fake-next', calls, textResult('next page'))],
      ['browser_snapshot', snapshotTool(snapshotCalls, 'page loaded')],
    ]);
    await saveTask(twoStepTask('task-cancel-race'), dir);

    const aborted = await runTaskWithReport('task-cancel-race', {
      tasksDir: dir,
      tools,
      host: dummyHost,
      verify: () => ({ ok: true, evidence: 'checked' }),
    });

    expect(aborted.state).toBe('failed');
    expect(aborted.evidence.some((line) => line.startsWith('cancelled by the user'))).toBe(true);
    // The run stopped at the cancelled step's save: the second step never ran.
    expect(calls).toEqual(['fake-ok']);
    expect(aborted.steps[1]?.result).toBeUndefined();
    // The stored record is the cancellation, not the run's own outcome.
    const stored = await loadTask('task-cancel-race', dir);
    expect(stored?.state).toBe('failed');
    expect(stored?.evidence.some((line) => line.startsWith('cancelled by the user'))).toBe(true);
    expect(stored?.report?.json.state).toBe('failed');
    // The marker did its job and is cleaned up on the terminal record.
    expect(stored?.cancelled).toBeUndefined();
  });

  it('a cancel landing after the run failed a step on its own keeps the cancellation evidence', async () => {
    const calls: string[] = [];
    const snapshotCalls: string[] = [];
    const tools = new Map<string, ToolDefinition>([
      ['fake-ok', fakeTool('fake-ok', calls, failureResult('INVALID_ARGUMENT: bad params'))],
      ['fake-next', fakeTool('fake-next', calls, textResult('next page'))],
      ['browser_snapshot', snapshotTool(snapshotCalls, 'page loaded')],
    ]);
    await saveTask(twoStepTask('task-own-failure-cancel'), dir);
    configureTaskRunner(async (id, options) => {
      const failed = await runTask(id, options);
      // The cancel from the other process lands after the runner's
      // final save but before the wrapper's load: both records are
      // `failed`, so only the marker tells the wrapper the stored one
      // is the cancellation, not the run's own step failure.
      const stored = await loadTask(id, dir);
      if (!stored) throw new Error('task was never saved');
      stored.state = 'failed';
      stored.cancelled = true;
      stored.evidence.push('cancelled by the user at step 1 of 2 — the task stops here and never resumes');
      await saveTaskWithReport(stored, dir);
      return failed;
    });
    try {
      const result = await runTaskWithReport('task-own-failure-cancel', {
        tasksDir: dir,
        tools,
        host: dummyHost,
        verify: () => ({ ok: true, evidence: 'checked' }),
      });
      expect(result.state).toBe('failed');
      expect(result.evidence.some((line) => line.startsWith('cancelled by the user'))).toBe(true);
      // The run's own step failure is still in the evidence: the stored
      // record keeps both, the wrapper did not replace it with the run's.
      expect(result.evidence.some((line) => line.includes('INVALID_ARGUMENT'))).toBe(true);
      const stored = await loadTask('task-own-failure-cancel', dir);
      expect(stored?.evidence.some((line) => line.startsWith('cancelled by the user'))).toBe(true);
      expect(stored?.report?.json.state).toBe('failed');
      // The marker did its job and is cleaned up on the terminal record.
      expect(stored?.cancelled).toBeUndefined();
    } finally {
      configureTaskRunner();
    }
  });

  it('stops at a tool that returns an error result', async () => {
    const calls: string[] = [];
    const tools = new Map<string, ToolDefinition>([
      // INVALID_ARGUMENT is not retryable: Task 7 retries TIMEOUT and
      // NAVIGATION_FAILED, so the stop-at-first-error case uses a code the
      // policy stops on — retry coverage lives in recovery.test.ts.
      ['fake-ok', fakeTool('fake-ok', calls, failureResult('INVALID_ARGUMENT: bad params'))],
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
    expect(done.steps[0]?.result?.detail).toContain('INVALID_ARGUMENT');
    expect(calls).toEqual(['fake-ok']);
  });

  it('stops at a tool that throws', async () => {
    const calls: string[] = [];
    const tools = new Map<string, ToolDefinition>([
      // As above: TIMEOUT retries since Task 7, so the throwing case uses
      // a non-retryable code.
      ['fake-ok', fakeTool('fake-ok', calls, new Error('INTERNAL_ERROR: handler crashed'))],
      ['fake-next', fakeTool('fake-next', calls, textResult('next page'))],
    ]);
    await saveTask(twoStepTask(), dir);

    const done = await runTask('task-1', { tasksDir: dir, tools });
    expect(done.state).toBe('failed');
    expect(done.steps[0]?.result?.status).toBe('failed');
    expect(done.steps[0]?.result?.detail).toContain('INTERNAL_ERROR');
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
    // A `paused-login` task resumes only through `resumeAfterLogin`, so this
    // resume-from-unfinished-step case runs from `running`, not paused-login.
    task.state = 'running';
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
    // A `paused-login` task resumes only through `resumeAfterLogin`, so this
    // tab-rebind case runs from `running`, not paused-login.
    task.state = 'running';
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
    // A task status read changes nothing; the other task tools write.
    'browser_task_status',
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
    'browser_task_start',
    'browser_task_cancel',
    'browser_task_answer',
    'browser_task_resume',
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

describe('mutation-approval question redaction', () => {
  it('a mutation-approval question never carries credential-like param values', async () => {
    const calls: string[] = [];
    const snapshotCalls: string[] = [];
    const secret = 'hunter2-secret-value';
    const tools = new Map<string, ToolDefinition>([
      [
        'fake-fill',
        fakeTool(
          'fake-fill',
          calls,
          textResult('filled'),
          false,
          z.object({ target: z.string(), password: z.string() }).strict(),
        ),
      ],
      ['browser_snapshot', snapshotTool(snapshotCalls, 'page loaded')],
    ]);
    const task: Task = {
      id: 'task-1',
      goal: 'Fill the login form',
      constraints: ['read-only'],
      steps: [
        {
          tool: 'fake-fill',
          params: { target: 'e1', password: secret },
          verify: [{ kind: 'no-error-text', value: "isn't working" }],
        },
      ],
      state: 'planned',
      evidence: [],
    };
    await saveTask(task, dir);
    const asked: Array<{ text: string }> = [];
    const paused = await runTask('task-1', {
      tasksDir: dir,
      tools,
      host: dummyHost,
      questions: {
        ask: async (input) => {
          asked.push({ text: input.text });
          return askQuestion(input.taskId, input.text, input.options, {
            tasksDir: dir,
            kind: input.kind,
            context: input.context,
          });
        },
      },
    });
    expect(paused.state).toBe('paused-question');
    expect(asked).toHaveLength(1);
    // The user can still judge the step: the tool name is there, and the
    // harmless param's key name survives — but no param value is anywhere,
    // and the credential-named key is dropped outright.
    expect(asked[0]?.text).toContain('fake-fill');
    expect(asked[0]?.text).toContain('target');
    expect(asked[0]?.text).not.toContain('e1');
    expect(asked[0]?.text).not.toContain(secret);
    expect(asked[0]?.text).not.toContain('password');
    expect(asked[0]?.text.length).toBeLessThanOrEqual(201);
    const reloaded = await loadTask('task-1', dir);
    expect(reloaded?.evidence.join('\n')).not.toContain(secret);
    // The old `key=value` form must be gone from the evidence; a bare
    // 'e1' substring check would false-positive on the random question
    // UUID in the same evidence lines.
    expect(reloaded?.evidence.join('\n')).not.toContain('target=e1');
    const pending = await listPendingQuestions(dir);
    expect(pending).toHaveLength(1);
    const stored = await loadPendingQuestion(pending[0]!.id, dir);
    expect(JSON.stringify(stored)).not.toContain(secret);
    expect(JSON.stringify(stored)).not.toContain('target=e1');
    expect(stored?.context?.params).toEqual(['target']);
    expect(stored?.text).toContain('fake-fill');
  });

  /**
   * One mutating step through the real `runTask` → `askQuestion` path:
   * returns the asked question text, the paused task, and the persisted
   * question file, so each carrier can assert the secret appears nowhere.
   */
  async function runMutatingStep(
    tool: ToolDefinition,
    params: Record<string, unknown>,
  ): Promise<{ text: string; stored: Awaited<ReturnType<typeof loadPendingQuestion>>; evidence: string }> {
    const tools = new Map<string, ToolDefinition>([
      [tool.name, tool],
      ['browser_snapshot', snapshotTool([], 'page loaded')],
    ]);
    const task: Task = {
      id: 'task-1',
      goal: 'Do the mutating step',
      constraints: ['read-only'],
      steps: [{ tool: tool.name, params, verify: [{ kind: 'no-error-text', value: "isn't working" }] }],
      state: 'planned',
      evidence: [],
    };
    await saveTask(task, dir);
    const asked: string[] = [];
    const paused = await runTask('task-1', {
      tasksDir: dir,
      tools,
      host: dummyHost,
      questions: {
        ask: async (input) => {
          asked.push(input.text);
          return askQuestion(input.taskId, input.text, input.options, {
            tasksDir: dir,
            kind: input.kind,
            context: input.context,
          });
        },
      },
    });
    expect(paused.state).toBe('paused-question');
    expect(asked).toHaveLength(1);
    const pending = await listPendingQuestions(dir);
    expect(pending).toHaveLength(1);
    const stored = await loadPendingQuestion(pending[0]!.id, dir);
    const reloaded = await loadTask('task-1', dir);
    return { text: asked[0]!, stored, evidence: reloaded?.evidence.join('\n') ?? '' };
  }

  it('a browser_type-like step never leaks its generic-key text value', async () => {
    const secret = 's3cret-typed-p4ssw0rd!';
    const { text, stored, evidence } = await runMutatingStep(
      fakeTool(
        'fake-type',
        [],
        textResult('typed'),
        false,
        z.object({ target: z.string(), text: z.string() }).strict(),
      ),
      { target: 'e1', text: secret },
    );
    expect(text).toContain('fake-type');
    expect(text).toContain('target');
    expect(text).toContain('text');
    expect(text).not.toContain(secret);
    expect(text).not.toContain('e1');
    expect(text.length).toBeLessThanOrEqual(201);
    expect(evidence).not.toContain(secret);
    expect(JSON.stringify(stored)).not.toContain(secret);
    expect(stored?.context?.params).toEqual(['target', 'text']);
  });

  it('a browser_fill-like step never leaks a nested fields[].value, not even its 40-char prefix', async () => {
    const secret = 'fill-secret-value-that-is-longer-than-forty-chars-0123456789';
    const { text, stored, evidence } = await runMutatingStep(
      fakeTool(
        'fake-fill-fields',
        [],
        textResult('filled'),
        false,
        z.object({ fields: z.array(z.object({ selector: z.string(), value: z.string() })) }).strict(),
      ),
      { fields: [{ selector: '#pw', value: secret }] },
    );
    expect(text).toContain('fake-fill-fields');
    expect(text).toContain('fields');
    expect(text).not.toContain(secret);
    expect(text).not.toContain(secret.slice(0, 40));
    expect(text).not.toContain('#pw');
    expect(evidence).not.toContain(secret);
    expect(evidence).not.toContain(secret.slice(0, 40));
    expect(JSON.stringify(stored)).not.toContain(secret);
    expect(JSON.stringify(stored)).not.toContain(secret.slice(0, 40));
    expect(stored?.context?.params).toEqual(['fields']);
  });

  it('a browser_evaluate-like step never leaks its expression', async () => {
    const secret = "document.querySelector('#pw').value = 'hunter2-secret'";
    const { text, stored, evidence } = await runMutatingStep(
      fakeTool(
        'fake-evaluate',
        [],
        textResult('evaluated'),
        false,
        z.object({ expression: z.string() }).strict(),
      ),
      { expression: secret },
    );
    expect(text).toContain('fake-evaluate');
    expect(text).toContain('expression');
    expect(text).not.toContain(secret);
    expect(text).not.toContain('hunter2-secret');
    expect(evidence).not.toContain(secret);
    expect(JSON.stringify(stored)).not.toContain(secret);
    expect(JSON.stringify(stored)).not.toContain('hunter2-secret');
    expect(stored?.context?.params).toEqual(['expression']);
  });
});

describe('zero-step tasks', () => {
  it('a zero-step task fails instead of completing with no evidence', async () => {
    const task: Task = { id: 'task-1', goal: 'Do nothing', constraints: [], steps: [], state: 'planned', evidence: [] };
    await saveTask(task, dir);
    const failed = await runTask('task-1', { tasksDir: dir, tools: new Map(), host: dummyHost });
    expect(failed.state).toBe('failed');
    expect(failed.evidence.join('\n')).toContain('no steps');
    const stored = await loadTask('task-1', dir);
    expect(stored?.state).toBe('failed');
  });
});

describe('prepare-element-before-click (Gap A)', () => {
  const repoRoot = path.join(import.meta.dirname, '..', '..');
  const FIXTURE_PATH = path.join(repoRoot, 'scripts', 'pages', 'prepare-fixture.html');

  const clickSchema = z
    .object({ tabId: z.number().optional(), target: z.string().optional(), hover: z.boolean().optional() })
    .strict();
  const scrollSchema = z.object({ tabId: z.number().optional(), target: z.string().optional() }).strict();
  const typeSchema = z
    .object({ tabId: z.number().optional(), target: z.string().optional(), text: z.string().optional() })
    .strict();

  /** A tool whose answers are consumed in call order (a fixed result, or a thrown error). */
  function scriptedTool(
    name: string,
    calls: string[],
    seen: Array<Record<string, unknown>>,
    answers: Array<ToolResult | Error>,
    inputSchema: z.ZodObject<z.ZodRawShape>,
  ): ToolDefinition {
    let next = 0;
    return {
      name,
      summary: `Fake ${name} for prepare tests`,
      description: `Test-only stand-in for ${name}.`,
      inputSchema,
      handler: async (_host, params) => {
        calls.push(name);
        seen.push(params);
        const answer = answers[Math.min(next, answers.length - 1)]!;
        next += 1;
        if (answer instanceof Error) throw answer;
        return answer;
      },
    };
  }

  function prepareTask(steps: Task['steps']): Task {
    return {
      id: 'task-1',
      goal: 'Click the prepared element',
      constraints: ['allow-mutations'],
      steps,
      state: 'planned',
      evidence: [],
    };
  }

  it('clicks a covered button from one step: scroll-into-view, then one retry, no hover', async () => {
    const calls: string[] = [];
    const seenClick: Array<Record<string, unknown>> = [];
    const seenScroll: Array<Record<string, unknown>> = [];
    const tools = new Map<string, ToolDefinition>([
      [
        'browser_click',
        scriptedTool(
          'browser_click',
          calls,
          seenClick,
          [
            failureResult('ELEMENT_COVERED: the click point of button "Covered action" is covered by the fixed header; the click would land there instead.'),
            textResult('clicked'),
          ],
          clickSchema,
        ),
      ],
      ['browser_scroll', scriptedTool('browser_scroll', calls, seenScroll, [textResult('scrolled into view')], scrollSchema)],
      ['browser_snapshot', snapshotTool(calls, 'covered button clicked')],
    ]);
    await saveTask(
      prepareTask([
        {
          tool: 'browser_click',
          params: { target: 'e7' },
          verify: [{ kind: 'text-present', value: 'covered button clicked' }],
        },
      ]),
      dir,
    );

    const done = await runTask('task-1', {
      tasksDir: dir,
      tools,
      host: dummyHost,
      verify: () => ({ ok: true, evidence: 'checked' }),
    });

    expect(done.state).toBe('done');
    // Prepare adds no top-level steps: the task still has the one planned step.
    expect(done.steps).toHaveLength(1);
    expect(done.steps[0]?.result?.status).toBe('ok');
    expect(calls).toEqual(['browser_click', 'browser_scroll', 'browser_click', 'browser_snapshot']);
    expect(seenScroll).toEqual([{ target: 'e7' }]);
    // The retry is a plain click, not a hover: nothing hovered on this path.
    expect(seenClick).toEqual([{ target: 'e7' }, { target: 'e7' }]);
    expect(done.evidence.join('\n')).toMatch(/prepare step 1 \(browser_click\)/);
    expect(done.evidence.join('\n')).toContain('ELEMENT_COVERED');
  });

  it('clicks a hover-menu item from one step: scroll fails hidden, hover reveals, scroll, retry', async () => {
    const calls: string[] = [];
    const seenClick: Array<Record<string, unknown>> = [];
    const seenScroll: Array<Record<string, unknown>> = [];
    const tools = new Map<string, ToolDefinition>([
      [
        'browser_click',
        scriptedTool(
          'browser_click',
          calls,
          seenClick,
          [
            failureResult('ELEMENT_HIDDEN: button "Menu item" is not displayed (display:none, visibility:hidden or zero size); nothing was clicked.'),
            textResult('hovered Menu item'),
            textResult('clicked'),
          ],
          clickSchema,
        ),
      ],
      [
        'browser_scroll',
        scriptedTool(
          'browser_scroll',
          calls,
          seenScroll,
          [
            failureResult('ELEMENT_HIDDEN: button "Menu item" is not displayed; it cannot be scrolled to'),
            textResult('scrolled into view'),
          ],
          scrollSchema,
        ),
      ],
      ['browser_snapshot', snapshotTool(calls, 'menu item clicked')],
    ]);
    await saveTask(
      prepareTask([
        {
          tool: 'browser_click',
          params: { target: 'e8' },
          verify: [{ kind: 'text-present', value: 'menu item clicked' }],
        },
      ]),
      dir,
    );

    const done = await runTask('task-1', {
      tasksDir: dir,
      tools,
      host: dummyHost,
      verify: () => ({ ok: true, evidence: 'checked' }),
    });

    expect(done.state).toBe('done');
    expect(done.steps).toHaveLength(1);
    expect(done.steps[0]?.result?.status).toBe('ok');
    expect(calls).toEqual([
      'browser_click',
      'browser_scroll',
      'browser_click',
      'browser_scroll',
      'browser_click',
      'browser_snapshot',
    ]);
    // Only the middle click is a hover; the first attempt and the retry are plain clicks.
    expect(seenClick).toEqual([{ target: 'e8' }, { target: 'e8', hover: true }, { target: 'e8' }]);
    expect(seenScroll).toEqual([{ target: 'e8' }, { target: 'e8' }]);
    expect(done.evidence.join('\n')).toMatch(/prepare step 1 \(browser_click\)/);
    expect(done.evidence.join('\n')).toContain('hover');
    expect(done.evidence.join('\n')).toContain('ELEMENT_HIDDEN');
  });

  it('a failed scroll means no retry: the click ran once and the step fails with the prepare reason', async () => {
    const calls: string[] = [];
    const seenClick: Array<Record<string, unknown>> = [];
    const tools = new Map<string, ToolDefinition>([
      [
        'browser_click',
        scriptedTool(
          'browser_click',
          calls,
          seenClick,
          [failureResult('ELEMENT_COVERED: the click point of button "Covered action" is covered by the fixed header; the click would land there instead.')],
          clickSchema,
        ),
      ],
      [
        'browser_scroll',
        scriptedTool('browser_scroll', calls, [], [failureResult('NOT_SCROLLABLE: nothing moved and the element is still out of view')], scrollSchema),
      ],
      ['browser_snapshot', snapshotTool(calls, 'page text')],
    ]);
    await saveTask(
      prepareTask([{ tool: 'browser_click', params: { target: 'e7' }, verify: [{ kind: 'no-error-text', value: "isn't working" }] }]),
      dir,
    );

    const done = await runTask('task-1', {
      tasksDir: dir,
      tools,
      host: dummyHost,
      verify: () => ({ ok: true, evidence: 'checked' }),
    });

    expect(done.state).toBe('failed');
    expect(done.steps[0]?.result?.status).toBe('failed');
    expect(done.steps[0]?.result?.detail).toContain('ELEMENT_COVERED');
    expect(done.steps[0]?.result?.detail).toContain('prepare');
    expect(done.steps[0]?.result?.detail).toContain('NOT_SCROLLABLE');
    expect(calls).toEqual(['browser_click', 'browser_scroll']);
    expect(seenClick).toHaveLength(1);
  });

  it('a failure no prepare can fix runs no prepare at all', async () => {
    const calls: string[] = [];
    const tools = new Map<string, ToolDefinition>([
      [
        'browser_click',
        scriptedTool(
          'browser_click',
          calls,
          [],
          [failureResult('ELEMENT_DISABLED: button "Covered action" is disabled; nothing was clicked.')],
          clickSchema,
        ),
      ],
      ['browser_snapshot', snapshotTool(calls, 'page text')],
    ]);
    await saveTask(
      prepareTask([{ tool: 'browser_click', params: { target: 'e7' }, verify: [{ kind: 'no-error-text', value: "isn't working" }] }]),
      dir,
    );

    const done = await runTask('task-1', {
      tasksDir: dir,
      tools,
      host: dummyHost,
      verify: () => ({ ok: true, evidence: 'checked' }),
    });

    expect(done.state).toBe('failed');
    expect(done.steps[0]?.result?.detail).toContain('ELEMENT_DISABLED');
    expect(calls).toEqual(['browser_click']);
    expect(done.evidence.join('\n')).not.toContain('prepare');
  });

  it('a click that succeeds first try runs no prepare at all', async () => {
    const calls: string[] = [];
    const seenScroll: Array<Record<string, unknown>> = [];
    const tools = new Map<string, ToolDefinition>([
      ['browser_click', scriptedTool('browser_click', calls, [], [textResult('clicked')], clickSchema)],
      ['browser_scroll', scriptedTool('browser_scroll', calls, seenScroll, [textResult('scrolled into view')], scrollSchema)],
      ['browser_snapshot', snapshotTool(calls, 'clicked')],
    ]);
    await saveTask(
      prepareTask([{ tool: 'browser_click', params: { target: 'e7' }, verify: [{ kind: 'no-error-text', value: "isn't working" }] }]),
      dir,
    );

    const done = await runTask('task-1', {
      tasksDir: dir,
      tools,
      host: dummyHost,
      verify: () => ({ ok: true, evidence: 'checked' }),
    });

    expect(done.state).toBe('done');
    expect(calls).toEqual(['browser_click', 'browser_snapshot']);
    expect(seenScroll).toEqual([]);
    expect(done.evidence.join('\n')).not.toContain('prepare');
  });

  it('a retry that fails again stops: one prepare, one retry, no loop', async () => {
    const calls: string[] = [];
    const seenClick: Array<Record<string, unknown>> = [];
    const seenScroll: Array<Record<string, unknown>> = [];
    const tools = new Map<string, ToolDefinition>([
      [
        'browser_click',
        scriptedTool(
          'browser_click',
          calls,
          seenClick,
          [
            failureResult('ELEMENT_COVERED: the click point of button "Covered action" is covered by the fixed header; the click would land there instead.'),
            failureResult('ELEMENT_COVERED: the click point of button "Covered action" is still covered by the fixed header; the click would land there instead.'),
          ],
          clickSchema,
        ),
      ],
      ['browser_scroll', scriptedTool('browser_scroll', calls, seenScroll, [textResult('scrolled into view')], scrollSchema)],
      ['browser_snapshot', snapshotTool(calls, 'page text')],
    ]);
    await saveTask(
      prepareTask([{ tool: 'browser_click', params: { target: 'e7' }, verify: [{ kind: 'no-error-text', value: "isn't working" }] }]),
      dir,
    );

    const done = await runTask('task-1', {
      tasksDir: dir,
      tools,
      host: dummyHost,
      verify: () => ({ ok: true, evidence: 'checked' }),
    });

    expect(done.state).toBe('failed');
    expect(done.steps[0]?.result?.status).toBe('failed');
    expect(done.steps[0]?.result?.detail).toContain('prepare');
    expect(calls).toEqual(['browser_click', 'browser_scroll', 'browser_click']);
    expect(seenClick).toHaveLength(2);
    expect(seenScroll).toHaveLength(1);
  });

  it('a covered field is typed from one step: scroll-into-view, then one retry', async () => {
    const calls: string[] = [];
    const seenScroll: Array<Record<string, unknown>> = [];
    const tools = new Map<string, ToolDefinition>([
      [
        'browser_type',
        scriptedTool(
          'browser_type',
          calls,
          [],
          [
            failureResult('ELEMENT_COVERED: the click point of textbox "Name" is covered by the fixed header; nothing was typed.'),
            textResult('typed'),
          ],
          typeSchema,
        ),
      ],
      ['browser_scroll', scriptedTool('browser_scroll', calls, seenScroll, [textResult('scrolled into view')], scrollSchema)],
      ['browser_snapshot', snapshotTool(calls, 'typed')],
    ]);
    await saveTask(
      prepareTask([
        {
          tool: 'browser_type',
          params: { target: 'e9', text: 'hello' },
          verify: [{ kind: 'no-error-text', value: "isn't working" }],
        },
      ]),
      dir,
    );

    const done = await runTask('task-1', {
      tasksDir: dir,
      tools,
      host: dummyHost,
      verify: () => ({ ok: true, evidence: 'checked' }),
    });

    expect(done.state).toBe('done');
    expect(done.steps).toHaveLength(1);
    expect(calls).toEqual(['browser_type', 'browser_scroll', 'browser_type', 'browser_snapshot']);
    expect(seenScroll).toEqual([{ target: 'e9' }]);
    expect(done.evidence.join('\n')).toMatch(/prepare step 1 \(browser_type\)/);
  });

  it('a hover step that fails covered is prepared like any click: scroll, then retry the hover', async () => {
    const calls: string[] = [];
    const seenClick: Array<Record<string, unknown>> = [];
    const tools = new Map<string, ToolDefinition>([
      [
        'browser_click',
        scriptedTool(
          'browser_click',
          calls,
          seenClick,
          [
            failureResult('ELEMENT_COVERED: the hover point of button "Menu" is covered by the fixed header; nothing was hovered.'),
            textResult('hovered Menu'),
          ],
          clickSchema,
        ),
      ],
      ['browser_scroll', scriptedTool('browser_scroll', calls, [], [textResult('scrolled into view')], scrollSchema)],
      ['browser_snapshot', snapshotTool(calls, 'hovered')],
    ]);
    await saveTask(
      prepareTask([
        {
          tool: 'browser_click',
          params: { target: 'e8', hover: true },
          verify: [{ kind: 'no-error-text', value: "isn't working" }],
        },
      ]),
      dir,
    );

    const done = await runTask('task-1', {
      tasksDir: dir,
      tools,
      host: dummyHost,
      verify: () => ({ ok: true, evidence: 'checked' }),
    });

    expect(done.state).toBe('done');
    expect(done.steps).toHaveLength(1);
    expect(calls).toEqual(['browser_click', 'browser_scroll', 'browser_click', 'browser_snapshot']);
    expect(seenClick).toEqual([
      { target: 'e8', hover: true },
      { target: 'e8', hover: true },
    ]);
    expect(done.evidence.join('\n')).toMatch(/prepare step 1 \(browser_click\)/);
  });

  it('a point target cannot be prepared: the scroll refuses it and the click is not retried', async () => {
    const calls: string[] = [];
    const seenClick: Array<Record<string, unknown>> = [];
    const tools = new Map<string, ToolDefinition>([
      [
        'browser_click',
        scriptedTool(
          'browser_click',
          calls,
          seenClick,
          [failureResult('CLICK_MISSED: the click at 120,300 landed on the fixed header, not on the target: the target moved after it was measured. Take a new snapshot before acting again.')],
          clickSchema,
        ),
      ],
      [
        'browser_scroll',
        scriptedTool('browser_scroll', calls, [], [failureResult('INVALID_ARGUMENT: a point target needs dx or dy to scroll')], scrollSchema),
      ],
      ['browser_snapshot', snapshotTool(calls, 'page text')],
    ]);
    await saveTask(
      prepareTask([{ tool: 'browser_click', params: { target: '120,300' }, verify: [{ kind: 'no-error-text', value: "isn't working" }] }]),
      dir,
    );

    const done = await runTask('task-1', {
      tasksDir: dir,
      tools,
      host: dummyHost,
      verify: () => ({ ok: true, evidence: 'checked' }),
    });

    expect(done.state).toBe('failed');
    expect(done.steps[0]?.result?.detail).toContain('CLICK_MISSED');
    expect(done.steps[0]?.result?.detail).toContain('prepare');
    expect(calls).toEqual(['browser_click', 'browser_scroll']);
    expect(seenClick).toHaveLength(1);
  });

  it('the prepare fixture serves both views the fakes mirror, and the menu case runs on it', async () => {
    const server = http.createServer((req, res) => {
      const url = req.url ?? '';
      if (url === '/prepare-fixture/covered' || url === '/prepare-fixture/menu') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(fs.readFileSync(FIXTURE_PATH, 'utf8'));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture server did not bind');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      const covered = await (await fetch(`${baseUrl}/prepare-fixture/covered`)).text();
      expect(covered).toContain('Prepare fixture — Covered button');
      expect(covered).toContain('id="covered-action"');
      expect(covered).toContain('covered button clicked');
      const menu = await (await fetch(`${baseUrl}/prepare-fixture/menu`)).text();
      expect(menu).toContain('Prepare fixture — Hover menu');
      expect(menu).toContain('id="menu-item"');
      // The menu item keeps its box while hidden (visibility, not display):
      // that is what a hover can land on to reveal it.
      expect(menu).toContain('visibility:hidden');
      expect(menu).toContain('menu item clicked');

      // The menu case, driven by fakes whose snapshot text mirrors the
      // fixture's menu view line for line — the same seam the audit e2e
      // test uses (tests/tasks/e2e-audit-task.test.ts).
      const calls: string[] = [];
      const tools = new Map<string, ToolDefinition>([
        [
          'browser_click',
          scriptedTool(
            'browser_click',
            calls,
            [],
            [
              failureResult('ELEMENT_HIDDEN: button "Menu item" is not displayed (display:none, visibility:hidden or zero size); nothing was clicked.'),
              textResult('hovered Menu item'),
              textResult('clicked'),
            ],
            clickSchema,
          ),
        ],
        [
          'browser_scroll',
          scriptedTool(
            'browser_scroll',
            calls,
            [],
            [
              failureResult('ELEMENT_HIDDEN: button "Menu item" is not displayed; it cannot be scrolled to'),
              textResult('scrolled into view'),
            ],
            scrollSchema,
          ),
        ],
        [
          'browser_snapshot',
          snapshotTool(
            calls,
            'heading "Prepare fixture — Hover menu"\n- button "Menu" [ref=e8]\n- button "Menu item" [ref=e9]\n- text "menu item clicked"',
          ),
        ],
      ]);
      await saveTask(
        prepareTask([
          {
            tool: 'browser_click',
            params: { target: 'e9' },
            verify: [{ kind: 'text-present', value: 'menu item clicked' }],
          },
        ]),
        dir,
      );
      const done = await runTask('task-1', {
        tasksDir: dir,
        tools,
        host: dummyHost,
        verify: () => ({ ok: true, evidence: 'checked' }),
      });
      expect(done.state).toBe('done');
      expect(calls).toEqual([
        'browser_click',
        'browser_scroll',
        'browser_click',
        'browser_scroll',
        'browser_click',
        'browser_snapshot',
      ]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
