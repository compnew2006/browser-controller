/**
 * The task MCP tools (specs/011-professional-browsing-layer, Task 8):
 * `browser_task_start`, `browser_task_status`, `browser_task_cancel`,
 * `browser_task_answer`. They compose what Tasks 1–7 built — plan, save,
 * run, verify, session, evidence, questions, recovery — into the four
 * calls an agent drives a task with.
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
import { textResult } from '../tools/types.js';
import { ERROR_CODES, formatError } from '../core/error-codes.js';
import { defaultTasksDir, loadTask, saveTask } from './store.js';
import { planTask } from './planner.js';
import { answerQuestion } from './questions.js';
import { deletePendingQuestion, listPendingQuestions } from './question-store.js';
import { saveTaskWithReport } from './reporting.js';
import { isTaskRunning, resumeTaskInBackground, taskRunOptions, wireQuestionSend } from './wiring.js';
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
  description: 'Plan a goal into verified steps and run the task in the background. Returns the task id and planned state; poll browser_task_status. Mutating steps need approval.',
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
    resumeTaskInBackground(task.id, taskRunOptions(host, wireQuestionSend(host), tasksDir));
    return textResult(
      JSON.stringify({ taskId: task.id, state: task.state, goal: task.goal, steps: task.steps.length, constraints: task.constraints }),
    );
  },
};

/** Read a task: its state, step outcomes, evidence, pending questions, and its evidence report when one exists. */
export const taskStatusTool: ToolDefinition = {
  name: 'browser_task_status',
  summary: "Read a task's state, steps, evidence and report",
  description: 'Read a task by id: state, step outcomes, evidence, pending questions, and the evidence report when the task has settled or paused.',
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
 * evidence and its evidence report persisted. A finished task cannot be
 * cancelled, and a task this process is currently running cannot be
 * either — the runner would overwrite the cancelled record with its
 * next step save; wait for it to pause or finish, then cancel.
 */
export const taskCancelTool: ToolDefinition = {
  name: 'browser_task_cancel',
  summary: 'Cancel a planned or paused task',
  description: 'Cancel a planned or paused task: it fails with the cancellation recorded and its evidence report saved. A finished task, or one currently running, cannot be cancelled.',
  inputSchema: taskIdSchema,
  timeoutMs: 10_000,
  handler: async (_host: ToolHost, params: Record<string, unknown>): Promise<ToolResult> => {
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
  description: 'Answer a pending task question by id and resume the task from the same step in the background. A yes to a mutation question approves that step only; a no fails the task.',
  inputSchema: answerSchema,
  timeoutMs: 10_000,
  handler: async (host: ToolHost, params: Record<string, unknown>): Promise<ToolResult> => {
    const args = parseParams(answerSchema, params, 'browser_task_answer');
    const tasksDir = defaultTasksDir();
    const task = await answerQuestion(args.questionId, args.answer, {
      tasksDir,
      continueWith: (answered) => {
        resumeTaskInBackground(answered.id, taskRunOptions(host, wireQuestionSend(host), tasksDir));
        return Promise.resolve(answered);
      },
    });
    return textResult(JSON.stringify(taskSummary(task)));
  },
};
