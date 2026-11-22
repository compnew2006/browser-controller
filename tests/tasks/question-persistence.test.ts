import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadTask, saveTask } from '../../mcp-server/src/tasks/store.js';
import type { Task } from '../../mcp-server/src/tasks/types.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-questions-restart-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.resetModules();
});

function taskWithSteps(id = 'task-1'): Task {
  return {
    id,
    goal: 'Open the dashboard and confirm it loaded',
    constraints: ['read-only'],
    steps: [
      { tool: 'fake-ok', params: {}, verify: [{ kind: 'no-error-text', value: "isn't working" }] },
      { tool: 'fake-next', params: {}, verify: [{ kind: 'no-error-text', value: "isn't working" }] },
    ],
    state: 'running',
    evidence: [],
  };
}

/** A fresh import of the questions module: the registry is empty, as after a daemon restart. */
async function freshQuestions() {
  vi.resetModules();
  return import('../../mcp-server/src/tasks/questions.js');
}

describe('pending questions across a restart', () => {
  it('answers a question from disk after the in-memory registry is gone, and forgets its file', async () => {
    const before = await freshQuestions();
    await saveTask(taskWithSteps(), dir);
    const question = await before.askQuestion('task-1', 'Which report should I open?', ['Sales', 'Stock'], { tasksDir: dir });
    expect(fs.existsSync(path.join(dir, 'questions', `${question.id}.json`))).toBe(true);
    expect((await loadTask('task-1', dir))?.state).toBe('paused-question');

    // The daemon restarts: a fresh module, an empty registry, the same files.
    const after = await freshQuestions();
    expect(after.pendingQuestions()).toEqual([]);
    const resumed = await after.answerQuestion(question.id, 'Sales', { tasksDir: dir });
    expect(resumed.state).toBe('running');
    expect(resumed.evidence.join('\n')).toContain('Sales');
    expect(fs.existsSync(path.join(dir, 'questions', `${question.id}.json`))).toBe(false);
    await expect(after.answerQuestion(question.id, 'Sales', { tasksDir: dir })).rejects.toThrowError(/question not found/);
  });

  it('restores the still-waiting questions and drops the stale ones', async () => {
    const before = await freshQuestions();
    await saveTask(taskWithSteps('task-1'), dir);
    await saveTask(taskWithSteps('task-2'), dir);
    const waiting = await before.askQuestion('task-1', 'Which one?', ['A', 'B'], { tasksDir: dir });
    const stale = await before.askQuestion('task-2', 'Which one?', ['A', 'B'], { tasksDir: dir });
    // task-2 stops waiting another way: its question is stale now.
    const task2 = await loadTask('task-2', dir);
    task2!.state = 'failed';
    await saveTask(task2!, dir);

    const after = await freshQuestions();
    const restored = await after.restorePendingQuestions(dir);
    expect(restored.map((q) => q.id)).toEqual([waiting.id]);
    expect(after.pendingQuestions().map((q) => q.id)).toEqual([waiting.id]);
    expect(fs.existsSync(path.join(dir, 'questions', `${stale.id}.json`))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'questions', `${waiting.id}.json`))).toBe(true);
    // The restored question answers normally.
    const resumed = await after.answerQuestion(waiting.id, 'A', { tasksDir: dir });
    expect(resumed.state).toBe('running');
  });

  it('skips a corrupt persisted question on restore', async () => {
    const before = await freshQuestions();
    await saveTask(taskWithSteps(), dir);
    const question = await before.askQuestion('task-1', 'Which one?', ['A', 'B'], { tasksDir: dir });
    fs.writeFileSync(path.join(dir, 'questions', `${question.id}.json`), '{not json');

    const after = await freshQuestions();
    expect(await after.restorePendingQuestions(dir)).toEqual([]);
    expect(after.pendingQuestions()).toEqual([]);
    const names = fs.readdirSync(path.join(dir, 'questions'));
    expect(names.some((name) => name.startsWith(`${question.id}.json.corrupt-`))).toBe(true);
  });
});
