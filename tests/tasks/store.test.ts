import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listTasks, loadTask, saveTask } from '../../mcp-server/src/tasks/store.js';
import type { Task } from '../../mcp-server/src/tasks/types.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-tasks-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function pausedLoginTask(): Task {
  return {
    id: 'task-1',
    goal: 'Open the library home page and confirm it loaded',
    constraints: ['read-only'],
    steps: [
      {
        tool: 'navigate',
        params: { url: 'https://example.com' },
        verify: [{ kind: 'url-contains', value: 'example.com' }],
      },
      {
        tool: 'snapshot',
        params: {},
        verify: [{ kind: 'text-present', value: 'Example' }],
        result: { status: 'ok' },
      },
    ],
    state: 'paused-login',
    evidence: [],
  };
}

describe('task store', () => {
  it('test_save_and_load_roundtrip', async () => {
    const planned = { ...pausedLoginTask(), state: 'planned' as const };
    await saveTask(planned, dir);
    const task = pausedLoginTask();
    await saveTask(task, dir);
    expect(await loadTask('task-1', dir)).toEqual(task);
    expect(await listTasks(dir)).toEqual([task]);
  });

  it('returns null for a task that was never saved', async () => {
    expect(await loadTask('missing', dir)).toBeNull();
    expect(await listTasks(dir)).toEqual([]);
  });

  it('writes private files', async () => {
    await saveTask(pausedLoginTask(), dir);
    const file = path.join(dir, 'task-1.json');
    expect(fs.existsSync(file)).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    }
  });
});
