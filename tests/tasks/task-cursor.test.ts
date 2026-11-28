import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { loadTask, saveTask } from '../../mcp-server/src/tasks/store.js';
import { askQuestion } from '../../mcp-server/src/tasks/questions.js';
import { runTask } from '../../mcp-server/src/tasks/runner.js';
import { TASK_CURSOR_WIRE_ACTION } from '../../mcp-server/src/protocol/wire-tools.js';
import { routeTaskInternalAction } from '../../mcp-server/src/tasks/internal-action-route.js';
import { taskRunOptions } from '../../mcp-server/src/tasks/wiring.js';
import type { Task } from '../../mcp-server/src/tasks/types.js';
import type { ToolDefinition, ToolHost, ToolResult } from '../../mcp-server/src/tools/types.js';
import { textResult } from '../../mcp-server/src/tools/types.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-tasks-cursor-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function fakeTool(
  name: string,
  calls: string[],
  result: ToolResult | Error,
  idempotent = true,
  inputSchema: z.ZodObject<z.ZodRawShape> = z.object({}).strict(),
): ToolDefinition {
  return {
    name,
    summary: `Fake ${name} for task-cursor tests`,
    description: 'Test-only stand-in.',
    inputSchema,
    ...(idempotent ? { idempotent: true as const } : {}),
    handler: async () => {
      calls.push(name);
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

const dummyHost: ToolHost = {
  callTool: async () => {
    throw new Error('no extension in test');
  },
};

const tabSchema = z.object({ tabId: z.number().optional() }).strict();

function toolsFor(calls: string[]): Map<string, ToolDefinition> {
  return new Map<string, ToolDefinition>([
    ['fake-ok', fakeTool('fake-ok', calls, textResult('page loaded'))],
    ['fake-next', fakeTool('fake-next', calls, textResult('next page'))],
    ['browser_snapshot', fakeTool('browser_snapshot', calls, textResult('page loaded'), true, tabSchema)],
  ]);
}

describe('task-mode agent cursor (Gap D)', () => {
  it('enables the cursor when the run starts and disables it when the task settles done', async () => {
    const calls: string[] = [];
    const cursorCalls: Array<[string, boolean]> = [];
    await saveTask(twoStepTask(), dir);

    const done = await runTask('task-1', {
      tasksDir: dir,
      tools: toolsFor(calls),
      host: dummyHost,
      setTaskCursor: async (taskId, enabled) => {
        cursorCalls.push([taskId, enabled]);
      },
    });

    expect(done.state).toBe('done');
    expect(cursorCalls).toEqual([
      ['task-1', true],
      ['task-1', false],
    ]);
    // The enable lands before the first step executes.
    expect(calls[0]).toBe('fake-ok');
  });

  it('disables the cursor when the task settles failed', async () => {
    const calls: string[] = [];
    const cursorCalls: Array<[string, boolean]> = [];
    await saveTask(twoStepTask(), dir);

    const failed = await runTask('task-1', {
      tasksDir: dir,
      tools: toolsFor(calls),
      host: dummyHost,
      verify: () => ({ ok: false, evidence: 'page shows an error' }),
      setTaskCursor: async (taskId, enabled) => {
        cursorCalls.push([taskId, enabled]);
      },
    });

    expect(failed.state).toBe('failed');
    expect(cursorCalls).toEqual([
      ['task-1', true],
      ['task-1', false],
    ]);
  });

  it('keeps the cursor enabled while the task pauses for a question (still live, user watching)', async () => {
    const calls: string[] = [];
    const cursorCalls: Array<[string, boolean]> = [];
    const task: Task = {
      id: 'task-1',
      goal: 'Fill the login form',
      constraints: ['read-only'],
      steps: [
        {
          tool: 'fake-fill',
          params: { target: 'e1', password: 's3cret' },
          verify: [{ kind: 'no-error-text', value: "isn't working" }],
        },
      ],
      state: 'planned',
      evidence: [],
    };
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
      ['browser_snapshot', fakeTool('browser_snapshot', calls, textResult('page loaded'), true, tabSchema)],
    ]);
    await saveTask(task, dir);

    const paused = await runTask('task-1', {
      tasksDir: dir,
      tools,
      host: dummyHost,
      questions: {
        ask: async (input) =>
          askQuestion(input.taskId, input.text, input.options, {
            tasksDir: dir,
            kind: input.kind,
            context: input.context,
          }),
      },
      setTaskCursor: async (taskId, enabled) => {
        cursorCalls.push([taskId, enabled]);
      },
    });

    expect(paused.state).toBe('paused-question');
    // Enabled at run start, never disabled: the pause is not a settle.
    expect(cursorCalls).toEqual([['task-1', true]]);
  });

  it('keeps the cursor enabled while the task pauses for login', async () => {
    const calls: string[] = [];
    const cursorCalls: Array<[string, boolean]> = [];
    await saveTask(twoStepTask(), dir);

    const paused = await runTask('task-1', {
      tasksDir: dir,
      tools: toolsFor(calls),
      host: dummyHost,
      session: { detectSession: () => 'expired' },
      setTaskCursor: async (taskId, enabled) => {
        cursorCalls.push([taskId, enabled]);
      },
    });

    expect(paused.state).toBe('paused-login');
    expect(cursorCalls).toEqual([['task-1', true]]);
  });

  it('a failing cursor signal never fails the run (cosmetic, best-effort)', async () => {
    const calls: string[] = [];
    await saveTask(twoStepTask(), dir);

    const done = await runTask('task-1', {
      tasksDir: dir,
      tools: toolsFor(calls),
      host: dummyHost,
      setTaskCursor: async () => {
        throw new Error('no extension connected');
      },
    });

    expect(done.state).toBe('done');
    expect(calls).toContain('fake-ok');
  });

  it('disables the cursor when another process cancelled the task mid-run', async () => {
    const calls: string[] = [];
    const cursorCalls: Array<[string, boolean]> = [];
    const task = twoStepTask();
    task.state = 'failed';
    task.cancelled = true;
    task.evidence.push('cancelled by the user at step 1 of 2 — the task stops here and never resumes');
    await saveTask(task, dir);

    const stored = await runTask('task-1', {
      tasksDir: dir,
      tools: toolsFor(calls),
      host: dummyHost,
      setTaskCursor: async (taskId, enabled) => {
        cursorCalls.push([taskId, enabled]);
      },
    });

    expect(stored.state).toBe('failed');
    expect(stored.cancelled).toBe(true);
    // The run never started, so nothing was enabled — but the settle
    // signal still goes out so a stale enable can never linger.
    expect(cursorCalls).toEqual([['task-1', false]]);
    expect(calls).toEqual([]);
  });
});

describe('task cursor wire action', () => {
  it('routes the cursor signal to the daemon control channel', () => {
    const sendControl = vi.fn();
    const outcome = routeTaskInternalAction(
      { sendControl },
      'session-1',
      TASK_CURSOR_WIRE_ACTION,
      { taskId: 'task-1', enabled: true },
    );
    expect(outcome).toEqual({ success: true, result: { enabled: true } });
    expect(sendControl).toHaveBeenCalledWith('taskCursor', { sessionId: 'session-1', taskId: 'task-1', enabled: true });
  });

  it('refuses a malformed cursor signal', () => {
    const sendControl = vi.fn();
    expect(
      routeTaskInternalAction({ sendControl }, 'session-1', TASK_CURSOR_WIRE_ACTION, { taskId: 'task-1' }),
    ).toMatchObject({ success: false });
    expect(
      routeTaskInternalAction({ sendControl }, 'session-1', TASK_CURSOR_WIRE_ACTION, { taskId: '!!', enabled: true }),
    ).toMatchObject({ success: false });
    expect(sendControl).not.toHaveBeenCalled();
  });

  it('wires setTaskCursor through the task host as the internal wire action', async () => {
    const callTool = vi.fn(async () => undefined);
    const host: ToolHost = { callTool: callTool as ToolHost['callTool'] };
    const options = taskRunOptions(host, async () => {}, dir, 'task-1');
    await options.setTaskCursor?.('task-1', true);
    expect(callTool).toHaveBeenCalledWith(TASK_CURSOR_WIRE_ACTION, { taskId: 'task-1', enabled: true });
  });
});
