import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  deletePendingQuestion,
  listPendingQuestions,
  loadPendingQuestion,
  savePendingQuestion,
  validatePendingQuestion,
} from '../../mcp-server/src/tasks/question-store.js';
import type { Question } from '../../mcp-server/src/tasks/questions.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-question-store-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const choice: Question = {
  id: '11111111-1111-4111-8111-111111111111',
  taskId: 'task-1',
  text: 'Which report should I open?',
  options: ['Sales', 'Stock'],
  kind: 'choice',
  context: { stepIndex: 0, tool: 'browser_navigate', params: { url: 'https://example.com' } },
};

describe('question store', () => {
  it('round-trips a question through save and load', async () => {
    await savePendingQuestion(choice, dir);
    expect(await loadPendingQuestion(choice.id, dir)).toEqual(choice);
    expect(await listPendingQuestions(dir)).toEqual([choice]);
  });

  it('returns null for a question that was never persisted, and an empty list for a missing directory', async () => {
    expect(await loadPendingQuestion(choice.id, dir)).toBeNull();
    expect(await listPendingQuestions(dir)).toEqual([]);
  });

  it('forgets a persisted question on delete', async () => {
    await savePendingQuestion(choice, dir);
    await deletePendingQuestion(choice.id, dir);
    expect(await loadPendingQuestion(choice.id, dir)).toBeNull();
    expect(await listPendingQuestions(dir)).toEqual([]);
    await deletePendingQuestion(choice.id, dir); // already forgotten: no throw
  });

  it('lists every persisted question', async () => {
    const second = { ...choice, id: '22222222-2222-4222-8222-222222222222', taskId: 'task-2', text: 'Second?' };
    await savePendingQuestion(second, dir);
    await savePendingQuestion(choice, dir);
    expect(await listPendingQuestions(dir)).toEqual([choice, second]);
  });

  it('rejects an invalid id and an oversized question', async () => {
    await expect(savePendingQuestion({ ...choice, id: '../escape' }, dir)).rejects.toThrowError(/starts with a letter or digit/);
    await expect(loadPendingQuestion('../escape', dir)).rejects.toThrowError(/starts with a letter or digit/);
    const huge = { ...choice, text: 'x'.repeat(70_000) };
    await expect(savePendingQuestion(huge, dir)).rejects.toThrowError(/limited to 64 KiB/);
  });

  it('quarantines a corrupt file and skips it on list, and throws on a corrupt load', async () => {
    await savePendingQuestion(choice, dir);
    fs.writeFileSync(path.join(dir, 'questions', `${choice.id}.json`), '{not json');
    await expect(loadPendingQuestion(choice.id, dir)).rejects.toThrowError(/not valid JSON/);
    expect(await listPendingQuestions(dir)).toEqual([]);
    const names = fs.readdirSync(path.join(dir, 'questions'));
    expect(names.some((name) => name.startsWith(`${choice.id}.json.corrupt-`))).toBe(true);
  });

  it('rejects unknown fields and a bad kind on validate', () => {
    expect(() => validatePendingQuestion({ ...choice, surprise: true })).toThrowError(/needs id, taskId, text and kind/);
    expect(() => validatePendingQuestion({ ...choice, kind: 'essay' })).toThrowError(/known kind/);
    expect(() => validatePendingQuestion({ ...choice, options: ['A', ''] })).toThrowError(/non-empty strings/);
  });
});
