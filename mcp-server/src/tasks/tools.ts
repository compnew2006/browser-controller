/**
 * The task MCP tools (specs/011-professional-browsing-layer, Task 8):
 * `browser_task_start`, `browser_task_status`, `browser_task_cancel`,
 * `browser_task_answer`, `browser_task_resume`. They compose what Tasks 1–7
 * built — plan, save, run, verify, session, evidence, questions, recovery —
 * into the five calls an agent drives a task with.
 *
 * How a task runs: `browser_task_start` plans the goal, saves the task,
 * and returns at once with the task `planned`; the run itself happens in
 * the background (`resumeTaskInBackground`, `wiring.ts`), so a long task
 * never blocks the tool call, and the agent polls `browser_task_status`.
 * `browser_task_answer` records the answer and likewise resumes in the
 * background, returning the task `running`. Both resumes drive the run
 * through `taskRunOptions`, so a mutating step asks the user through the
 * question protocol instead of failing outright — and, with no wired
 * ask, the runner still refuses it: the question path adds an approval
 * route, it never weakens the P4 gate (the approval is per step, and a
 * `no` fails the task with the refusal as evidence).
 *
 * A task paused for login has no answer to give — the user completes login
 * by takeover — so `browser_task_resume` is its production resume path
 * (final review, 2026-11-22: without it FR-006 / SC-002 were dead in
 * production — `resumeAfterLogin` had no caller). The tool re-checks the
 * page first through `resumeAfterLogin`, reading it with `browser_snapshot`
 * on the tab the task's completed steps bound and supplying the task's
 * last known URL as the expected URL, then continues the run in the
 * background through the same `taskRunOptions` — so a resumed mutating
 * step still needs its approval, exactly as a fresh run does.
 *
 * These tools run in the MCP client process, not the daemon: their host
 * is the daemon client, so steps run as the agent's own session, and
 * questions reach the extension through the internal wire action (see
 * `wireQuestionSend`). They never import the tool registry — the registry
 * imports them, and the runner resolves its tools from the registry, so
 * a static import back would be a cycle (`registry → tools → runner →
 * registry`); the runner loads the registry lazily instead (see
 * `runner.ts`).
 *
 * Handlers validate their own arguments against their zod schemas
 * before doing anything: `registerTools` validates first, but a direct
 * call must fail the same way. Failures are `CODE: message` errors from
 * `core/error-codes.ts`, never literal codes.
 */
import { z } from 'zod';
import type { ToolDefinition, ToolHost, ToolResult } from '../tools/types.js';
import { outcomeOf, textResult } from '../tools/types.js';
import { ERROR_CODES, formatError } from '../core/error-codes.js';
import { defaultTasksDir, loadTask, saveTask } from './store.js';
import { planTask } from './planner.js';
import { answerQuestion } from './questions.js';
import { deletePendingQuestion, listPendingQuestions } from './question-store.js';
import { saveTaskWithReport } from './reporting.js';
import { lastKnownUrl, resumeAfterLogin, type SessionPage } from './session.js';
import { pageSnapshotFromResult, resultText } from './verify.js';
import { isTaskRunning, resumeTaskInBackground, taskRunOptions, wireQuestionSend } from './wiring.js';
import { disableTaskCursorIfSettled } from './task-cursor.js';
import { TASK_CURSOR_WIRE_ACTION } from '../protocol/wire-tools.js';
import type { Task } from './types.js';

/** The task as an agent reads it: state, step outcomes, evidence, pending questions, and the report when one exists. */
function taskSummary(task: Task, questions?: Array<{ id: string; text: string; options?: string[]; kind: string }>): Record<string, unknown> {
  return {
    taskId: task.id,
    goal: task.goal,
    state: task.state,
    constraints: [...task.constraints],
    steps: task.steps.map((step, index) => ({ step: index + 1, tool: step.tool, status: step.result?.status ?? 'not-run' })),
    evidence: [...task.evidence],
    questions: questions ?? [],
    ...(task.report ? { report: task.report } : {}),
  };
}

/** Parse a handler's arguments against its own schema, or fail coded. */
function parseParams<T extends z.ZodObject<z.ZodRawShape>>(schema: T, params: Record<string, unknown>, tool: string): z.infer<T> {
  const parsed = schema.safeParse(params);
  if (!parsed.success) {
    const detail = parsed.error.issues[0]?.message ?? 'invalid arguments';
    throw new Error(formatError(ERROR_CODES.INVALID_ARGUMENT, `${tool}: ${detail}`));
  }
  return parsed.data;
}

/** Load a task or fail coded when it was never saved. */
async function requireTask(id: string, tasksDir: string): Promise<Task> {
  const task = await loadTask(id, tasksDir);
  if (!task) throw new Error(formatError(ERROR_CODES.INVALID_ARGUMENT, `task not found: ${id}`));
  return task;
}

const startSchema = z
  .object({
    goal: z.string().min(1),
    constraints: z.array(z.string()).optional(),
  })
  .strict();

const taskIdSchema = z
  .object({
    taskId: z.string().min(1),
  })
  .strict();

const answerSchema = z
  .object({
    questionId: z.string().min(1),
    answer: z.string().min(1),
  })
  .strict();

/**
 * Plan a goal into verified steps, save the task, and run it in the
 * background. Returns the task id with state `planned`; poll
 * `browser_task_status` for progress. The plan emits no mutating step,
 * and a mutating step added later still needs approval.
 */
export const taskStartTool: ToolDefinition = {
  name: 'browser_task_start',
  summary: 'Plan a goal into steps and run it as a task',
  description: 'For multi-step browser goals, use this to plan, run, and verify the steps as a single task. It runs in the background; poll browser_task_status for progress. Mutating steps need approval.',
  inputSchema: startSchema,
  timeoutMs: 10_000,
  handler: async (host: ToolHost, params: Record<string, unknown>): Promise<ToolResult> => {
    const args = parseParams(startSchema, params, 'browser_task_start');
    if (args.goal.trim() === '') {
      throw new Error(formatError(ERROR_CODES.INVALID_ARGUMENT, 'browser_task_start needs a non-empty goal'));
    }
    const tasksDir = defaultTasksDir();
    const task = planTask(args.goal, args.constraints ?? []);
    if (typeof host.sessionId === 'string' && host.sessionId !== '') task.sessionId = host.sessionId;
    await saveTask(task, tasksDir);
    void resumeTaskInBackground(task.id, taskRunOptions(host, wireQuestionSend(host), tasksDir, task.id));
    return textResult(
      JSON.stringify({ taskId: task.id, state: task.state, goal: task.goal, steps: task.steps.length, constraints: task.constraints }),
    );
  },
};

/** Read a task: its state, step outcomes, evidence, pending questions, and its evidence report when one exists. */
export const taskStatusTool: ToolDefinition = {
  name: 'browser_task_status',
  summary: "Read a task's state, steps, evidence and report",
  description: 'Read a task by id: state, steps, evidence, questions, and report when settled.',
  inputSchema: taskIdSchema,
  timeoutMs: 10_000,
  idempotent: true,
  handler: async (_host: ToolHost, params: Record<string, unknown>): Promise<ToolResult> => {
    const args = parseParams(taskIdSchema, params, 'browser_task_status');
    const tasksDir = defaultTasksDir();
    const task = await requireTask(args.taskId, tasksDir);
    const questions = (await listPendingQuestions(tasksDir))
      .filter((question) => question.taskId === task.id)
      .map((question) => ({ id: question.id, text: question.text, options: question.options, kind: question.kind }));
    return textResult(JSON.stringify(taskSummary(task, questions)));
  },
};

/**
 * Cancel a planned or paused task: it fails with the cancellation as
 * evidence and its evidence report persisted, and marks the record
 * cancelled (`Task.cancelled`) so a run in flight in another process
 * aborts at its next save instead of overwriting the cancellation
 * (`tasks/cancel-guard.ts`). A finished task cannot be cancelled, and
 * a task this process is currently running cannot be either — wait for
 * it to pause or finish, then cancel. A paused task keeps the
 * task-mode cursor on, so cancel is the settle that turns it off: the
 * disable goes out here, best-effort, because the runner's settle
 * paths never run for a task cancelled from pause. The input lock
 * needs no release here — the pause already released it
 * (`runTaskWithReport`'s finally runs on every return from `runTask`,
 * pause included).
 */
export const taskCancelTool: ToolDefinition = {
  name: 'browser_task_cancel',
  summary: 'Cancel a planned or paused task',
  description: 'Cancel a planned or paused task and save its report. A finished task, or one currently running, cannot be cancelled.',
  inputSchema: taskIdSchema,
  timeoutMs: 10_000,
  handler: async (host: ToolHost, params: Record<string, unknown>): Promise<ToolResult> => {
    const args = parseParams(taskIdSchema, params, 'browser_task_cancel');
    const tasksDir = defaultTasksDir();
    const task = await requireTask(args.taskId, tasksDir);
    if (task.state === 'done' || task.state === 'failed') {
      throw new Error(formatError(ERROR_CODES.INVALID_ARGUMENT, `cannot cancel task ${args.taskId}: task is ${task.state}`));
    }
    if (isTaskRunning(task.id)) {
      throw new Error(
        formatError(ERROR_CODES.INVALID_ARGUMENT, `cannot cancel task ${args.taskId}: it is currently running — wait for it to pause or finish, then cancel`),
      );
    }
    const index = task.steps.findIndex((step) => step.result?.status !== 'ok');
    const stepNumber = index === -1 ? task.steps.length : index + 1;
    task.state = 'failed';
    // The marker is what a run in flight in another process sees: it
    // aborts at its next save instead of overwriting this cancellation
    // (`tasks/cancel-guard.ts`). It is cleared when the run's wrapper
    // saves the terminal record.
    task.cancelled = true;
    task.evidence.push(`cancelled by the user at step ${stepNumber} of ${task.steps.length} — the task stops here and never resumes`);
    // A pending question for a cancelled task must not come back: drop its
    // persisted files, so a daemon restart never re-asks them. The
    // in-memory registry keeps its entry until the restart, but
    // `answerQuestion` refuses it — the task is no longer paused-question.
    for (const question of await listPendingQuestions(tasksDir)) {
      if (question.taskId !== task.id) continue;
      try {
        await deletePendingQuestion(question.id, tasksDir);
      } catch {
        // The next restore drops the stale file; the cancel itself stands.
      }
    }
    await saveTaskWithReport(task, tasksDir);
    // The cursor disable is best-effort and swallowed inside: the
    // cancel stands even if the extension is gone, and the extension
    // drops a disable for a task it never enabled, so cancelling a
    // planned (never-run) task is a harmless no-op.
    await disableTaskCursorIfSettled(
      (cursorTaskId, enabled) => host.callTool(TASK_CURSOR_WIRE_ACTION, { taskId: cursorTaskId, enabled }),
      task,
    );
    return textResult(JSON.stringify(taskSummary(task, [])));
  },
};

/**
 * Answer a pending task question and resume the task from the same step.
 * A `yes` to a mutation-approval question records a per-step approval
 * and the resume runs that step; a `no` fails the task with the refusal
 * as evidence. The resume runs in the background, so this returns the
 * task `running` at once — poll `browser_task_status` for its outcome.
 */
export const taskAnswerTool: ToolDefinition = {
  name: 'browser_task_answer',
  summary: 'Answer a task question and resume the task',
  description: 'Answer a pending question by id and resume the task in the background. Yes approves that step only; no fails the task.',
  inputSchema: answerSchema,
  timeoutMs: 10_000,
  handler: async (host: ToolHost, params: Record<string, unknown>): Promise<ToolResult> => {
    const args = parseParams(answerSchema, params, 'browser_task_answer');
    const tasksDir = defaultTasksDir();
    const task = await answerQuestion(args.questionId, args.answer, {
      tasksDir,
      continueWith: (answered) => {
        void resumeTaskInBackground(answered.id, taskRunOptions(host, wireQuestionSend(host), tasksDir, answered.id));
        return Promise.resolve(answered);
      },
    });
    return textResult(JSON.stringify(taskSummary(task)));
  },
};

/** The tab the task's completed steps already bound, if any — the resume re-reads that tab. A step recorded `unknown` executed too, so its tab counts. */
function boundTabOf(task: Task): number | undefined {
  let bound: number | undefined;
  for (const step of task.steps) {
    if (step.result?.status !== 'ok' && step.result?.status !== 'unknown') continue;
    if (typeof step.params.tabId === 'number') bound = step.params.tabId;
  }
  return bound;
}

/**
 * Read the current page for the login re-check: a plain `browser_snapshot`
 * on the tab the task is bound to, through the host — the same read the
 * production runner uses for verification. The task's last known URL is
 * the expected URL, so the re-check can tell the expected site from any
 * other site the user may have reached by takeover. A failed read throws,
 * so the resume fails instead of continuing unread.
 */
async function readPageForResume(host: ToolHost, task: Task): Promise<SessionPage> {
  const tabId = boundTabOf(task);
  const params: Record<string, unknown> = {};
  if (tabId !== undefined) params.tabId = tabId;
  const result = outcomeOf(await host.callTool('browser_snapshot', params));
  if (result.isError) {
    throw new Error(`snapshot unavailable for the login re-check: ${resultText(result)}`);
  }
  const snapshot = pageSnapshotFromResult(result, `browser_snapshot${tabId !== undefined ? ` tab ${tabId}` : ''}`);
  return { ...snapshot, expectedUrl: lastKnownUrl(task) };
}

/**
 * Resume a task paused for login, through the production entry point:
 * re-check the page first (`resumeAfterLogin`), then continue the run in
 * the background from the same step. Refuses — INVALID_ARGUMENT — any
 * task that is not `paused-login`: a planned, running, paused-question,
 * done or failed task has no login pause to resume from, and a missing
 * task was never saved. The resume runs through `taskRunOptions`, so a
 * resumed mutating step still needs its approval (P4): the resume adds a
 * resume path, never an approval bypass. Returns the task `running` at
 * once — poll `browser_task_status` for its outcome.
 */
export const taskResumeTool: ToolDefinition = {
  name: 'browser_task_resume',
  summary: 'Resume a task paused for login',
  description: 'Resume a task paused for login: re-check the page first, then continue from the same step in the background. Refuses tasks not paused for login.',
  inputSchema: taskIdSchema,
  timeoutMs: 10_000,
  handler: async (host: ToolHost, params: Record<string, unknown>): Promise<ToolResult> => {
    const args = parseParams(taskIdSchema, params, 'browser_task_resume');
    const tasksDir = defaultTasksDir();
    const task = await requireTask(args.taskId, tasksDir);
    if (task.state !== 'paused-login') {
      throw new Error(
        formatError(ERROR_CODES.INVALID_ARGUMENT, `cannot resume task ${args.taskId} after login: task is ${task.state}, not paused-login`),
      );
    }
    const resumed = await resumeAfterLogin(args.taskId, {
      tasksDir,
      readPage: (toRead) => readPageForResume(host, toRead),
      continueWith: (toContinue) => {
        void resumeTaskInBackground(toContinue.id, taskRunOptions(host, wireQuestionSend(host), tasksDir, toContinue.id));
        return Promise.resolve(toContinue);
      },
    });
    return textResult(JSON.stringify(taskSummary(resumed, [])));
  },
};
