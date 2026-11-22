import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import {
  answerQuestion,
  askQuestion,
  mutationApprovalConstraint,
  pauseForQuestion,
  pendingQuestions,
} from '../../mcp-server/src/tasks/questions.js';
import type { Question } from '../../mcp-server/src/tasks/questions.js';
import { loadTask, saveTask } from '../../mcp-server/src/tasks/store.js';
import { saveTaskWithReport } from '../../mcp-server/src/tasks/reporting.js';
import { runTask } from '../../mcp-server/src/tasks/runner.js';
import type { Task } from '../../mcp-server/src/tasks/types.js';
import type { ToolDefinition, ToolHost, ToolResult } from '../../mcp-server/src/tools/types.js';
import { textResult } from '../../mcp-server/src/tools/types.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-tasks-questions-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
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
    summary: `Fake ${name} for question tests`,
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

describe('askQuestion', () => {
  it('pauses a running task in paused-question, saves the current step, and sends the question on the channel', async () => {
    await saveTask(taskWithSteps(), dir);
    const sent: Array<{ type: string; question: Question }> = [];
    const question = await askQuestion('task-1', 'Which report should I open?', ['Sales', 'Stock'], {
      tasksDir: dir,
      send: async (message) => {
        sent.push(message);
      },
    });

    expect(question.taskId).toBe('task-1');
    expect(question.text).toBe('Which report should I open?');
    expect(question.options).toEqual(['Sales', 'Stock']);
    expect(question.kind).toBe('choice');
    expect(question.id.length).toBeGreaterThan(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.type).toBe('taskQuestion');
    expect(sent[0]?.question).toBe(question);

    const reloaded = await loadTask('task-1', dir);
    expect(reloaded?.state).toBe('paused-question');
    expect(reloaded?.evidence.join('\n')).toContain('step 1 of 2');
    expect(reloaded?.evidence.join('\n')).toContain('Which report should I open?');
    expect(pendingQuestions().map((q) => q.id)).toContain(question.id);
  });

  it('asks a confirm question with yes/no options when no options are given', async () => {
    await saveTask(taskWithSteps(), dir);
    const question = await askQuestion('task-1', 'Allow this change?', undefined, {
      tasksDir: dir,
      kind: 'confirm',
    });
    expect(question.kind).toBe('confirm');
    expect(question.options).toEqual(['yes', 'no']);
  });

  it('throws for a task that was never saved, a finished task, or an empty question', async () => {
    await expect(askQuestion('missing', 'Which one?', ['A'], { tasksDir: dir })).rejects.toThrowError(/not found/);
    const done = taskWithSteps();
    done.state = 'done';
    await saveTask(done, dir);
    await expect(askQuestion('task-1', 'Which one?', ['A'], { tasksDir: dir })).rejects.toThrowError(
      /cannot pause.*done/,
    );
    const running = taskWithSteps();
    running.id = 'task-2';
    await saveTask(running, dir);
    await expect(askQuestion('task-2', '   ', ['A'], { tasksDir: dir })).rejects.toThrowError(/needs text/);
    await expect(askQuestion('task-2', 'Which one?', [], { tasksDir: dir })).rejects.toThrowError(/option/);
  });

  it('keeps the question pending when the send channel fails, and records the failure as evidence', async () => {
    await saveTask(taskWithSteps(), dir);
    const question = await askQuestion('task-1', 'Which one?', ['A'], {
      tasksDir: dir,
      send: async () => {
        throw new Error('socket gone');
      },
    });
    expect(pendingQuestions().map((q) => q.id)).toContain(question.id);
    const reloaded = await loadTask('task-1', dir);
    expect(reloaded?.state).toBe('paused-question');
    expect(reloaded?.evidence.join('\n')).toMatch(/could not be sent.*socket gone/i);
  });
});

describe('pauseForQuestion', () => {
  it('pauses a running task in paused-question and saves the current step number', async () => {
    const task = taskWithSteps();
    task.steps[0]!.result = { status: 'ok', detail: 'first done' };
    await saveTask(task, dir);

    const paused = await pauseForQuestion('task-1', 1, dir);
    expect(paused.state).toBe('paused-question');
    expect(paused.evidence.join('\n')).toContain('step 2 of 2');

    const reloaded = await loadTask('task-1', dir);
    expect(reloaded?.state).toBe('paused-question');
  });

  it('throws for a task that was never saved and for a finished task', async () => {
    await expect(pauseForQuestion('missing', 0, dir)).rejects.toThrowError(/not found/);
    const done = taskWithSteps();
    done.state = 'done';
    await saveTask(done, dir);
    await expect(pauseForQuestion('task-1', 0, dir)).rejects.toThrowError(/cannot pause.*done/);
  });

  it('drops a stale report when pausing for a question', async () => {
    const task = taskWithSteps();
    await saveTask(task, dir);
    await saveTaskWithReport(task, dir);
    expect((await loadTask('task-1', dir))?.report).toBeDefined();
    await pauseForQuestion('task-1', 0, dir);
    // The report described the earlier state; the paused record carries
    // none until the task settles again.
    expect((await loadTask('task-1', dir))?.report).toBeUndefined();
  });
});

describe('answerQuestion', () => {
  it('test_answer_resumes_task', async () => {
    await saveTask(taskWithSteps(), dir);
    const question = await askQuestion('task-1', 'Which report should I open?', ['Sales', 'Stock'], {
      tasksDir: dir,
    });
    expect((await loadTask('task-1', dir))?.state).toBe('paused-question');

    const continued: Task[] = [];
    const resumed = await answerQuestion(question.id, 'Sales', {
      tasksDir: dir,
      continueWith: async (task) => {
        continued.push(task);
        // The continuation resumes from the first unfinished step: no step
        // has run yet, so both are still unrun.
        expect(task.steps[0]?.result).toBeUndefined();
        expect(task.steps[1]?.result).toBeUndefined();
        return { ...task, state: 'done' as const };
      },
    });

    expect(resumed.state).toBe('done');
    expect(continued).toHaveLength(1);
    expect(continued[0]?.state).toBe('running');
    expect(pendingQuestions().map((q) => q.id)).not.toContain(question.id);
    const reloaded = await loadTask('task-1', dir);
    // The fake continuation returns 'done' without saving it, so the stored
    // task is the one answerQuestion saved: running, with the answer recorded.
    expect(reloaded?.state).toBe('running');
    expect(reloaded?.evidence.join('\n')).toContain('Sales');
    expect(reloaded?.evidence.join('\n')).toContain('resuming from the same step');
  });

  it('returns the task running when no continuation is supplied', async () => {
    await saveTask(taskWithSteps(), dir);
    const question = await askQuestion('task-1', 'Which one?', ['A', 'B'], { tasksDir: dir });
    const resumed = await answerQuestion(question.id, 'B', { tasksDir: dir });
    expect(resumed.state).toBe('running');
    expect(resumed.evidence.join('\n')).toContain('B');
  });

  it('resumes from the same step through runTask once answered', async () => {
    const calls: string[] = [];
    const snapshotCalls: string[] = [];
    const tools = new Map<string, ToolDefinition>([
      ['fake-ok', fakeTool('fake-ok', calls, textResult('page loaded'))],
      ['fake-next', fakeTool('fake-next', calls, textResult('next page'))],
      [
        'browser_snapshot',
        fakeTool('browser_snapshot', snapshotCalls, textResult('page loaded'), true, tabSchema),
      ],
    ]);
    const task = taskWithSteps();
    task.steps[0]!.result = { status: 'ok', detail: 'already done' };
    await saveTask(task, dir);
    const question = await askQuestion('task-1', 'Continue with the second step?', undefined, {
      tasksDir: dir,
      kind: 'confirm',
    });

    const resumed = await answerQuestion(question.id, 'yes', {
      tasksDir: dir,
      continueWith: async (toContinue) =>
        runTask(toContinue.id, { tasksDir: dir, tools, host: dummyHost, verify: () => ({ ok: true, evidence: 'checked' }) }),
    });

    expect(resumed.state).toBe('done');
    // The completed first step never re-ran; the resume ran only step 2.
    expect(calls).toEqual(['fake-next']);
    expect(snapshotCalls).toEqual(['browser_snapshot']);
    expect(resumed.steps[0]?.result).toEqual({ status: 'ok', detail: 'already done' });
    expect(resumed.steps[1]?.result?.status).toBe('ok');
  });

  it('throws for an unknown question, an answer outside the options, and a task that is not paused-question', async () => {
    await expect(answerQuestion('no-such-question', 'A', { tasksDir: dir })).rejects.toThrowError(
      /question not found/,
    );
    await saveTask(taskWithSteps(), dir);
    const question = await askQuestion('task-1', 'Which one?', ['A', 'B'], { tasksDir: dir });
    await expect(answerQuestion(question.id, 'C', { tasksDir: dir })).rejects.toThrowError(/not one of the options/);
    expect(pendingQuestions().map((q) => q.id)).toContain(question.id);
    // The task is still paused-question: a second answer with a valid option works.
    await answerQuestion(question.id, 'A', { tasksDir: dir });
    // Answering the same question twice is an unknown question now.
    await expect(answerQuestion(question.id, 'A', { tasksDir: dir })).rejects.toThrowError(/question not found/);
  });

  it('accepts any non-empty answer for a free-text question', async () => {
    await saveTask(taskWithSteps(), dir);
    const question = await askQuestion('task-1', 'What should I search for?', undefined, {
      tasksDir: dir,
      kind: 'text',
    });
    const resumed = await answerQuestion(question.id, 'quarterly sales', { tasksDir: dir });
    expect(resumed.state).toBe('running');
    expect(resumed.evidence.join('\n')).toContain('quarterly sales');
  });

  it('accepts "Yes" for a yes/no question, like isApproval does', async () => {
    await saveTask(taskWithSteps(), dir);
    const question = await askQuestion('task-1', 'Proceed?', ['yes', 'no'], { tasksDir: dir, kind: 'confirm' });
    const resumed = await answerQuestion(question.id, 'Yes', { tasksDir: dir });
    expect(resumed.state).toBe('running');
  });
});

describe('mutation-approval question flow (runner + questions)', () => {
  function mutatingTask(): Task {
    return {
      id: 'task-1',
      goal: 'Click the submit button',
      constraints: ['read-only'],
      steps: [{ tool: 'fake-click', params: {}, verify: [{ kind: 'no-error-text', value: "isn't working" }] }],
      state: 'planned',
      evidence: [],
    };
  }

  /** The runner's injected ask: the real askQuestion, sending on a fake channel. */
  function runnerAsk(sent: Array<{ type: string; question: Question }>) {
    return async (input: {
      taskId: string;
      text: string;
      options?: string[];
      kind: 'confirm' | 'choice' | 'text';
      context?: { stepIndex: number; tool: string; params: Record<string, unknown> };
    }): Promise<Question> =>
      askQuestion(input.taskId, input.text, input.options, {
        tasksDir: dir,
        kind: input.kind,
        context: input.context,
        send: async (message) => {
          sent.push(message);
        },
      });
  }

  function clickTools(calls: string[], snapshotCalls: string[]): Map<string, ToolDefinition> {
    return new Map<string, ToolDefinition>([
      ['fake-click', fakeTool('fake-click', calls, textResult('clicked'), false)],
      [
        'browser_snapshot',
        fakeTool('browser_snapshot', snapshotCalls, textResult('clicked'), true, tabSchema),
      ],
    ]);
  }

  it('pauses in paused-question instead of failing when a mutating step lacks approval, and the question names the tool and params', async () => {
    const calls: string[] = [];
    const sent: Array<{ type: string; question: Question }> = [];
    await saveTask(mutatingTask(), dir);

    const paused = await runTask('task-1', {
      tasksDir: dir,
      tools: clickTools(calls, []),
      host: dummyHost,
      questions: { ask: runnerAsk(sent) },
    });

    expect(paused.state).toBe('paused-question');
    expect(calls).toEqual([]);
    expect(paused.steps[0]?.result).toBeUndefined();
    expect(sent).toHaveLength(1);
    const question = sent[0]!.question;
    expect(question.kind).toBe('confirm');
    expect(question.options).toEqual(['yes', 'no']);
    expect(question.text).toContain('fake-click');
    expect(question.context).toEqual({ stepIndex: 0, tool: 'fake-click', params: {} });
    expect(pendingQuestions().map((q) => q.id)).toContain(question.id);
  });

  it('a "yes" answer grants approval for that step only and the task continues from the same step', async () => {
    const calls: string[] = [];
    const snapshotCalls: string[] = [];
    const sent: Array<{ type: string; question: Question }> = [];
    const tools = clickTools(calls, snapshotCalls);
    await saveTask(mutatingTask(), dir);

    const paused = await runTask('task-1', {
      tasksDir: dir,
      tools,
      host: dummyHost,
      questions: { ask: runnerAsk(sent) },
    });
    expect(paused.state).toBe('paused-question');

    const done = await answerQuestion(sent[0]!.question.id, 'yes', {
      tasksDir: dir,
      continueWith: async (task) =>
        runTask(task.id, {
          tasksDir: dir,
          tools,
          host: dummyHost,
          verify: () => ({ ok: true, evidence: 'checked' }),
          questions: { ask: runnerAsk(sent) },
        }),
    });

    expect(done.state).toBe('done');
    expect(calls).toEqual(['fake-click']);
    expect(snapshotCalls).toEqual(['browser_snapshot']);
    // The approval was recorded on the task, so the resume did not re-ask.
    expect(sent).toHaveLength(1);
    expect(done.constraints).toContain(mutationApprovalConstraint(0));
    expect(done.constraints).not.toContain('allow-mutations');
    expect(done.evidence.join('\n')).toMatch(/approved.*fake-click/i);
  });

  it('a "no" answer fails the task with the refusal as evidence, exactly as a refusal without a question does', async () => {
    const calls: string[] = [];
    const sent: Array<{ type: string; question: Question }> = [];
    const tools = clickTools(calls, []);
    await saveTask(mutatingTask(), dir);

    const paused = await runTask('task-1', {
      tasksDir: dir,
      tools,
      host: dummyHost,
      questions: { ask: runnerAsk(sent) },
    });
    expect(paused.state).toBe('paused-question');

    const continued: Task[] = [];
    const failed = await answerQuestion(sent[0]!.question.id, 'no', {
      tasksDir: dir,
      continueWith: async (task) => {
        continued.push(task);
        return task;
      },
    });

    expect(failed.state).toBe('failed');
    expect(continued).toEqual([]);
    expect(calls).toEqual([]);
    expect(failed.steps[0]?.result?.status).toBe('failed');
    expect(failed.steps[0]?.result?.detail).toMatch(/refused.*approval/i);
    expect(failed.evidence.join('\n')).toMatch(/refused.*approval/i);
    expect(failed.constraints).not.toContain(mutationApprovalConstraint(0));
  });

  it('still refuses outright (failed, never runs) when no question channel is wired', async () => {
    const calls: string[] = [];
    await saveTask(mutatingTask(), dir);

    const done = await runTask('task-1', { tasksDir: dir, tools: clickTools(calls, []) });
    expect(done.state).toBe('failed');
    expect(calls).toEqual([]);
    expect(done.steps[0]?.result?.detail).toMatch(/refused.*approval/i);
  });

  it('refuses a paused-question task handed to runTask directly, and runs nothing', async () => {
    const calls: string[] = [];
    const sent: Array<{ type: string; question: Question }> = [];
    await saveTask(mutatingTask(), dir);
    const paused = await runTask('task-1', {
      tasksDir: dir,
      tools: clickTools(calls, []),
      host: dummyHost,
      questions: { ask: runnerAsk(sent) },
    });
    expect(paused.state).toBe('paused-question');

    await expect(
      runTask('task-1', { tasksDir: dir, tools: clickTools(calls, []), host: dummyHost }),
    ).rejects.toThrowError(/answerQuestion/);
    expect(calls).toEqual([]);
    expect((await loadTask('task-1', dir))?.state).toBe('paused-question');
  });
});
