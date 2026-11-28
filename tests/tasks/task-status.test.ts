import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listTasks, saveTask } from '../../mcp-server/src/tasks/store.js';
import { saveTaskWithReport } from '../../mcp-server/src/tasks/reporting.js';
import {
  TASK_STATUS_MAX_TASKS,
  buildTaskStatus,
  pushTaskStatus,
} from '../../mcp-server/src/tasks/task-status.js';
import type { Task } from '../../mcp-server/src/tasks/types.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-task-status-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function taskWithSteps(id: string, state: Task['state'] = 'running'): Task {
  return {
    id,
    goal: `Goal for ${id}`,
    constraints: [],
    steps: [
      { tool: 'browser_snapshot', params: {}, verify: [], result: { status: 'ok', detail: 'observed="Balance: 42"' } },
      { tool: 'browser_navigate', params: {}, verify: [] },
    ],
    state,
    evidence: [],
  };
}

/** Pin a task file's mtime so most-recent-first order is deterministic. */
function setMtime(id: string, ms: number): void {
  const file = path.join(dir, `${id}.json`);
  fs.utimesSync(file, new Date(ms), new Date(ms));
}

describe('buildTaskStatus (daemon → popup task list)', () => {
  it('maps each task to { id, goal, state, steps, report? } with browser_task_status step statuses', async () => {
    await saveTask(taskWithSteps('task-a'), dir);
    const done = taskWithSteps('task-b', 'done');
    await saveTaskWithReport(done, dir);

    const tasks = await buildTaskStatus(dir);
    expect(tasks).toHaveLength(2);
    const running = tasks.find((t) => t.id === 'task-a');
    expect(running).toMatchObject({
      id: 'task-a',
      goal: 'Goal for task-a',
      state: 'running',
      steps: [
        { step: 1, tool: 'browser_snapshot', status: 'ok' },
        { step: 2, tool: 'browser_navigate', status: 'not-run' },
      ],
    });
    expect(running).not.toHaveProperty('report');
    const settled = tasks.find((t) => t.id === 'task-b');
    expect(settled?.state).toBe('done');
    expect(typeof settled?.report?.text).toBe('string');
    expect(settled?.report?.text.length).toBeGreaterThan(0);
    expect(settled?.report?.json.taskId).toBe('task-b');
  });

  it('orders most-recent-first by task file mtime and caps at 20', async () => {
    const base = Date.now() - 100_000;
    for (let i = 0; i < TASK_STATUS_MAX_TASKS + 1; i++) {
      const id = `task-${String(i).padStart(2, '0')}`;
      await saveTask(taskWithSteps(id), dir);
      setMtime(id, base + i * 1000);
    }
    expect(await listTasks(dir)).toHaveLength(TASK_STATUS_MAX_TASKS + 1);

    const tasks = await buildTaskStatus(dir);
    expect(tasks).toHaveLength(TASK_STATUS_MAX_TASKS);
    expect(tasks[0]?.id).toBe(`task-${TASK_STATUS_MAX_TASKS}`);
    expect(tasks[tasks.length - 1]?.id).toBe('task-01');
    expect(tasks.map((t) => t.id)).not.toContain('task-00');
  });

  it('returns an empty list for a missing tasks dir', async () => {
    await expect(buildTaskStatus(path.join(dir, 'no-such-dir'))).resolves.toEqual([]);
  });

  it('throws on a failed read (a file where the tasks dir should be)', async () => {
    const notADir = path.join(dir, 'not-a-dir');
    fs.writeFileSync(notADir, 'not a directory');
    await expect(buildTaskStatus(notADir)).rejects.toThrow('task directory could not be read');
  });
});

describe('pushTaskStatus', () => {
  it('sends a taskStatus control message with the tasks payload', async () => {
    await saveTask(taskWithSteps('task-a'), dir);
    const sent: Array<Record<string, unknown>> = [];
    const bridge = {
      sendControl(type: string, payload: Record<string, unknown> = {}) {
        sent.push({ type, ...payload });
      },
    };

    await pushTaskStatus(bridge, dir);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.type).toBe('taskStatus');
    const tasks = sent[0]?.tasks as Array<Record<string, unknown>>;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ id: 'task-a', state: 'running', goal: 'Goal for task-a' });
  });

  it('sends one frame with an empty list for a missing tasks dir', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const bridge = {
      sendControl(type: string, payload: Record<string, unknown> = {}) {
        sent.push({ type, ...payload });
      },
    };
    await expect(pushTaskStatus(bridge, path.join(dir, 'no-such-dir'))).resolves.toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.tasks).toEqual([]);
  });

  it('never throws and sends no frame when the tasks dir cannot be read', async () => {
    // A file where the tasks dir should be: readdir fails with ENOTDIR, so
    // listTasks throws — unlike a missing dir (ENOENT), which yields [].
    const notADir = path.join(dir, 'not-a-dir');
    fs.writeFileSync(notADir, 'not a directory');
    const sent: Array<Record<string, unknown>> = [];
    const bridge = {
      sendControl(type: string, payload: Record<string, unknown> = {}) {
        sent.push({ type, ...payload });
      },
    };
    await expect(pushTaskStatus(bridge, notADir)).resolves.toBeUndefined();
    expect(sent).toHaveLength(0);
  });
});
