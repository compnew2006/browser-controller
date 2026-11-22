import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

// The cancel is injected on a counted `loadTask` call: `pauseForLogin`
// loads the task, then its guarded save re-loads it — the cancel lands
// between the two, exactly the window the guard exists for. The mock
// delegates every call to the real store; only the counted call first
// writes the cancelled record, the way `browser_task_cancel` does, and
// then returns the real load — which now sees the marker.
const arm = vi.hoisted(() => ({ onLoadCall: 0, count: 0 }));

vi.mock('../../mcp-server/src/tasks/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../mcp-server/src/tasks/store.js')>();
  return {
    ...actual,
    loadTask: async (id: string, tasksDir?: string) => {
      arm.count += 1;
      if (arm.onLoadCall > 0 && arm.count === arm.onLoadCall) {
        const stored = await actual.loadTask(id, tasksDir);
        if (stored) {
          stored.state = 'failed';
          stored.cancelled = true;
          stored.evidence.push('cancelled by the user at step 1 of 2 — the task stops here and never resumes');
          await actual.saveTask(stored, tasksDir);
        }
      }
      return actual.loadTask(id, tasksDir);
    },
  };
});

import { pauseForLogin } from '../../mcp-server/src/tasks/session.js';
import { TaskCancelledExternally } from '../../mcp-server/src/tasks/cancel-guard.js';
import { loadTask, saveTask } from '../../mcp-server/src/tasks/store.js';
import { runTaskWithReport } from '../../mcp-server/src/tasks/wiring.js';
import type { Task } from '../../mcp-server/src/tasks/types.js';
import type { ToolDefinition, ToolHost, ToolResult } from '../../mcp-server/src/tools/types.js';
import { outcomeOf, textResult } from '../../mcp-server/src/tools/types.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-tasks-session-cancel-'));
  arm.count = 0;
  arm.onLoadCall = 0;
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const LOGIN_FORM_TEXT =
  '- textbox "Email" [ref=e1]\n- textbox "Password" [ref=e2]\n- button "Sign in" [ref=e3]';

function taskWithSteps(id = 'task-1'): Task {
  return {
    id,
    goal: 'Open the dashboard and confirm it loaded',
    constraints: ['read-only'],
    steps: [
      { tool: 'browser_navigate', params: { url: 'https://example.com/dashboard' }, verify: [{ kind: 'no-error-text', value: "isn't working" }] },
      { tool: 'browser_snapshot', params: {}, verify: [{ kind: 'no-error-text', value: "isn't working" }] },
    ],
    state: 'running',
    evidence: [],
  };
}

/** A host fake tools ignore; its only job is to let the runner call the snapshot tool. */
const dummyHost: ToolHost = {
  callTool: async () => {
    throw new Error('no extension in test');
  },
};

function fakeTool(
  name: string,
  calls: string[],
  result: ToolResult | Error,
  idempotent = true,
  inputSchema: z.ZodObject<z.ZodRawShape> = z.object({}).strict(),
): ToolDefinition {
  return {
    name,
    summary: `Fake ${name} for session-cancel tests`,
    description: `Test-only stand-in for ${name}.`,
    inputSchema,
    ...(idempotent ? { idempotent: true as const } : {}),
    handler: async (_host, _params) => {
      calls.push(name);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

const tabSchema = z.object({ tabId: z.number().optional() }).strict();
const navigateSchema = z.object({ url: z.string(), incognito: z.boolean().optional() }).strict();

describe('pauseForLogin cross-process cancel', () => {
  it('a cancel landing between the load and the save is not overwritten with paused-login', async () => {
    await saveTask(taskWithSteps(), dir);
    // `pauseForLogin` loads the task (call 1), then its guarded save
    // re-loads it (call 2): the cancel lands on that re-load.
    arm.count = 0;
    arm.onLoadCall = 2;

    let thrown: unknown;
    try {
      await pauseForLogin('task-1', 0, dir);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TaskCancelledExternally);
    const cancelled = thrown as TaskCancelledExternally;
    expect(cancelled.stored.state).toBe('failed');
    expect(cancelled.stored.evidence.some((line) => line.startsWith('cancelled by the user'))).toBe(true);

    const stored = await loadTask('task-1', dir);
    expect(stored?.state).toBe('failed');
    expect(stored?.evidence.some((line) => line.startsWith('cancelled by the user'))).toBe(true);
    expect(stored?.evidence.some((line) => line.includes('paused for login'))).toBe(false);
  });

  it('the runner returns the stored cancelled record when the cancel lands inside pauseForLogin', async () => {
    const calls: string[] = [];
    const tools = new Map<string, ToolDefinition>([
      ['browser_navigate', fakeTool('browser_navigate', calls, textResult('loaded'), false, navigateSchema)],
      [
        'browser_snapshot',
        fakeTool(
          'browser_snapshot',
          calls,
          outcomeOf({ success: true, text: LOGIN_FORM_TEXT, url: 'https://example.com/login?next=%2Fdashboard', tabId: 42 }),
          true,
          tabSchema,
        ),
      ],
    ]);
    await saveTask(taskWithSteps(), dir);
    // Loads on the expired path: 1 runTask, 2 the unknown-step save's
    // re-check, 3 `pauseForLogin`'s load, 4 the pause save's re-check —
    // the cancel lands on that last one.
    arm.count = 0;
    arm.onLoadCall = 4;

    const result = await runTaskWithReport('task-1', {
      tasksDir: dir,
      tools,
      host: dummyHost,
      session: { knownLoginUrls: ['https://example.com/login'] },
    });
    expect(result.state).toBe('failed');
    expect(result.evidence.some((line) => line.startsWith('cancelled by the user'))).toBe(true);
    expect(result.steps[0]?.result?.status).toBe('unknown');
    expect(result.evidence.some((line) => line.includes('paused for login'))).toBe(false);

    const stored = await loadTask('task-1', dir);
    expect(stored?.state).toBe('failed');
    expect(stored?.evidence.some((line) => line.startsWith('cancelled by the user'))).toBe(true);
    expect(stored?.report?.json.state).toBe('failed');
    // The marker did its job and is cleaned up on the terminal record.
    expect(stored?.cancelled).toBeUndefined();
  });
});
