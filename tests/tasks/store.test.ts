import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listTasks, loadTask, saveTask, MAX_TASK_BYTES, TaskStoreError } from '../../mcp-server/src/tasks/store.js';
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

  it('skips and quarantines a corrupt file, but keeps the good tasks', async () => {
    const good = pausedLoginTask();
    await saveTask(good, dir);
    // Garbage bytes, owner-only so the read reaches the JSON parse, not the policy.
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, 'not json {{{');
    fs.chmodSync(bad, 0o600);

    let caught: unknown;
    try {
      await loadTask('bad', dir);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TaskStoreError);
    expect((caught as TaskStoreError).kind).toBe('corrupt');

    expect(await listTasks(dir)).toEqual([good]);
    expect(fs.existsSync(bad)).toBe(false);
    expect(fs.readdirSync(dir).some((name) => /^bad\.json\.corrupt-\d+$/.test(name))).toBe(true);
    // The quarantined name no longer matches a task file, so a second listing is stable.
    expect(await listTasks(dir)).toEqual([good]);
  });

  it('skips and quarantines a file whose stored id is invalid, instead of aborting the listing', async () => {
    const good = pausedLoginTask();
    await saveTask(good, dir);
    // A hand-edited file whose stored id is invalid ('../x' could never be a
    // task file name): file-content corruption, not a caller error.
    const bad = path.join(dir, 'badid.json');
    fs.writeFileSync(bad, `${JSON.stringify({ ...pausedLoginTask(), id: '../x' })}\n`);
    fs.chmodSync(bad, 0o600);

    let caught: unknown;
    try {
      await loadTask('badid', dir);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TaskStoreError);
    expect((caught as TaskStoreError).kind).toBe('corrupt');

    expect(await listTasks(dir)).toEqual([good]);
    expect(fs.existsSync(bad)).toBe(false);
    expect(fs.readdirSync(dir).some((name) => /^badid\.json\.corrupt-\d+$/.test(name))).toBe(true);
    expect(await listTasks(dir)).toEqual([good]);
  });

  it('rethrows when a file is too large instead of skipping it', async () => {
    const big = path.join(dir, 'big.json');
    fs.writeFileSync(big, 'x'.repeat(MAX_TASK_BYTES + 1));
    fs.chmodSync(big, 0o600);

    await expect(loadTask('big', dir)).rejects.toThrowError(/too large/);
    await expect(listTasks(dir)).rejects.toThrowError(TaskStoreError);
    // An oversize file is not corruption: it stays put, unquarantined.
    expect(fs.existsSync(big)).toBe(true);
  });

  it('rethrows when a file fails the owner-only policy instead of skipping it', async () => {
    if (process.platform === 'win32') return;
    // A mode other users may read is refused by the read policy even when the
    // process itself (e.g. root) could read the bytes — this is the portable
    // stand-in for a permission/unreadable file, which chmod 000 cannot
    // simulate for a root process.
    const file = path.join(dir, 'task-1.json');
    fs.writeFileSync(file, `${JSON.stringify(pausedLoginTask())}\n`);
    fs.chmodSync(file, 0o644);

    let caught: unknown;
    try {
      await loadTask('task-1', dir);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TaskStoreError);
    expect((caught as TaskStoreError).kind).toBe('unavailable');
    await expect(listTasks(dir)).rejects.toThrowError(TaskStoreError);
    expect(fs.existsSync(file)).toBe(true);
  });
});
