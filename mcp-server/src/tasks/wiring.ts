/**
 * The Task 8 wiring: how a task run is driven, in either process.
 *
 * The product runs in two processes, and this module is where that split
 * is dealt with instead of being papered over:
 * - The MCP client process runs the `browser_task_*` tools. Its host is
 *   the daemon client, so a step runs as the agent's own session (the
 *   daemon attaches the session server-side), and a question reaches the
 *   extension through the internal wire action
 *   (`TASK_QUESTION_WIRE_ACTION`, intercepted by the daemon's `routeCall`
 *   and delivered with `bridge.sendControl` — the MCP process has no
 *   bridge of its own to call).
 * - The daemon process owns the bridge. Its answer receiver
 *   (`createTaskAnswerContinuation`) resumes a task the popup answered,
 *   driving steps through a `ToolHost` adapter over `bridge.callTool` as
 *   the session recorded on the task (`task.sessionId`) — the session
 *   that opened the task's tabs — and sending questions straight to
 *   `bridge.sendControl`.
 *
 * Both drivers run the task through `runTaskWithReport`: `runTask` plus
 * the save-into-task-record hook (`reporting.ts`), plus a guard for a
 * task cancelled from outside while the run was in flight (see below).
 * The resume is always backgrounded (`resumeTaskInBackground`): the
 * popup's answer is acknowledged once the answer is recorded, not once
 * the resumed task finishes — awaiting the whole resume would push the
 * ack past the popup's 5 s waiter and re-record an answered question.
 * The MCP answer tool backgrounds it for the same reason (a tool call
 * must not block on a whole task).
 *
 * In-flight tracking: `runTaskWithReport` marks a task running while it
 * executes, in this process's module state. `browser_task_cancel` refuses
 * a task that is running here — wait for it to pause or finish, then
 * cancel; a task that merely says `running` in its file but is not
 * running here (a stale record after a restart) can still be cancelled.
 * The set is per-process, so a daemon-side resume is invisible to the
 * MCP process's cancel and vice versa — but a cross-process cancel is
 * still durable: the cancel marks the stored record (`Task.cancelled`),
 * and the runner re-checks the stored record before every save
 * (`tasks/cancel-guard.ts`) and aborts at the next one, so the run
 * never overwrites the cancellation. The marker is cleared when this
 * wrapper saves the terminal record, so the stored record keeps the
 * cancellation as evidence, not as a live signal.
 *
 * The runner itself is injectable (`configureTaskRunner`) for tests:
 * production never calls it, and it restores the real runner when called
 * with no argument.
 */
import { randomUUID } from 'node:crypto';
import { createLogger } from '../core/logger.js';
import { TASK_LOCK_RELEASE_WIRE_ACTION, TASK_QUESTION_WIRE_ACTION } from '../protocol/wire-tools.js';
import type { ActivityContextFrame } from '../protocol/frames.js';
import type { TaskAnswerHandler } from '../bridge-task-answers.js';
import { createActivityContext, type ToolActivity, type ToolHost } from '../tools/types.js';
import { answerQuestion, askQuestion, type QuestionSendFn } from './questions.js';
import { runTask, type RunTaskOptions } from './runner.js';
import { loadTask } from './store.js';
import { saveTaskWithReport } from './reporting.js';
import type { Task } from './types.js';

const log = createLogger('TaskWiring');

/** The daemon side of the wire: a bridge that can run tools and send control messages. */
export interface TaskBridge {
  callTool(
    tool: string,
    params: Record<string, unknown>,
    sessionId?: string,
    signal?: AbortSignal,
    agentName?: string,
    activityContext?: ActivityContextFrame,
  ): Promise<unknown>;
  sendControl(type: string, payload?: Record<string, unknown>): void;
}

/** The `ToolHost` the daemon drives a resumed task with: the bridge, as one session. */
export function daemonToolHost(bridge: TaskBridge, sessionId?: string): ToolHost {
  return {
    callTool: (tool, params, activity) =>
      bridge.callTool(tool, params, sessionId, undefined, undefined, toFrame(activity)),
  };
}

/** A tool activity as a protocol frame: a batch-finished marker is not a call context, so it is dropped. */
function toFrame(activity: ToolActivity | undefined): ActivityContextFrame | undefined {
  if (!activity || 'kind' in activity) return undefined;
  return activity;
}

/**
 * The `runTask` options for a driven run: the host, plus the question
 * protocol wired to `send` — the runner asks through it instead of
 * failing a mutating step outright, and the answer resumes from the same
 * step with the approval the answer recorded.
 */
export function taskRunOptions(host: ToolHost, send: QuestionSendFn, tasksDir?: string, taskId?: string): RunTaskOptions {
  const taskHost: ToolHost = taskId ? {
    ...(host.sessionId !== undefined ? { sessionId: host.sessionId } : {}),
    callTool: (tool, params, activity) => {
      if (tool === TASK_LOCK_RELEASE_WIRE_ACTION || tool === TASK_QUESTION_WIRE_ACTION) {
        return host.callTool(tool, params, activity);
      }
      if (activity && 'kind' in activity) return host.callTool(tool, params, activity);
      const needsTaskContext = tool.startsWith('browser_') && tool !== 'browser_batch' && !tool.startsWith('browser_task_');
      const context = activity ?? createActivityContext(tool) ?? (needsTaskContext ? { eventId: randomUUID() } : undefined);
      return host.callTool(tool, params, context ? { ...context, taskId } : activity);
    },
  } : host;
  return {
    ...(tasksDir !== undefined ? { tasksDir } : {}),
    host: taskHost,
    ...(taskId ? { releaseTaskLock: (settledTaskId: string) => host.callTool(TASK_LOCK_RELEASE_WIRE_ACTION, { taskId: settledTaskId }) } : {}),
    questions: {
      ask: (input) =>
        askQuestion(input.taskId, input.text, input.options, {
          ...(tasksDir !== undefined ? { tasksDir } : {}),
          kind: input.kind,
          context: input.context,
          send,
        }),
    },
  };
}

/** The question send for the MCP process: the internal wire action, which the daemon delivers to the extension. */
export function wireQuestionSend(host: ToolHost): QuestionSendFn {
  return async (message) => {
    await host.callTool(TASK_QUESTION_WIRE_ACTION, { question: message.question });
  };
}

/** Tasks this process is currently executing, by id. */
const runningTasks = new Set<string>();

/** Whether this process is currently executing the task. */
export function isTaskRunning(id: string): boolean {
  return runningTasks.has(id);
}

type TaskRunnerFn = (id: string, options: RunTaskOptions) => Promise<Task>;
let runTaskImpl: TaskRunnerFn = (id, options) => runTask(id, options);

/** Replace the runner (tests only); called with no argument it restores the real one. */
export function configureTaskRunner(fn?: TaskRunnerFn): void {
  runTaskImpl = fn ?? ((id, options) => runTask(id, options));
}

/**
 * Run a task and persist its evidence report on the settled record.
 * When the stored record was failed from outside while this run was in
 * flight — a cancel — the stored outcome wins: the run's result is
 * discarded and the stored task is reported instead. The marker decides,
 * not the state: a stored record carrying the cancel marker wins even
 * when the run failed a step on its own, so both records are `failed`
 * and the state comparison alone would let the run's record overwrite
 * the cancellation evidence with the step failure. That reconciliation
 * covers only the window between the runner's final save and this load:
 * a cancel landing earlier in the run is caught by the runner itself,
 * which re-checks the stored record before every save and aborts on
 * the cancel marker (`tasks/cancel-guard.ts`) instead of overwriting it.
 */
export async function runTaskWithReport(id: string, options: RunTaskOptions = {}): Promise<Task> {
  runningTasks.add(id);
  try {
    const task = await runTaskImpl(id, options);
    let stored: Task | null = null;
    try {
      stored = await loadTask(id, options.tasksDir);
    } catch {
      // The stored record cannot be read: keep the run's own result, which
      // the save below writes over whatever is there.
    }
    // The stored record wins when it carries the cancel marker — even
    // when the run failed a step on its own, so both records are
    // `failed` and the state comparison alone would let the run's
    // record overwrite the cancellation evidence with the step failure
    // — or when it was failed from outside while the run did not itself
    // fail. The marker did its job once the run returned; the terminal
    // record keeps the cancellation as evidence, not as a live signal.
    if (stored && (stored.cancelled === true || (stored.state === 'failed' && task.state !== 'failed'))) {
      delete stored.cancelled;
      return saveTaskWithReport(stored, options.tasksDir);
    }
    delete task.cancelled;
    return saveTaskWithReport(task, options.tasksDir);
  } finally {
    try {
      await options.releaseTaskLock?.(id);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      log.warn(`task ${id} input-lock release failed: ${detail}`);
    }
    runningTasks.delete(id);
  }
}

/** Drive a task in the background: the caller returns at once, and a failed resume is logged, never thrown. */
export function resumeTaskInBackground(id: string, options: RunTaskOptions): void {
  void runTaskWithReport(id, options).catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    log.warn(`background run of task ${id} failed: ${detail}`);
  });
}

/**
 * The daemon answer receiver's continuation (Task 6 handoff): an answer
 * recorded by `answerQuestion` resumes the task with `runTask` on the
 * daemon's bridge host, as the task's own session. The resume is
 * backgrounded — this function returns the task `running` as soon as the
 * answer is recorded, so the popup's `taskAnswerAck` is not held behind
 * the whole resumed run. Questions a resumed run asks go straight to
 * `bridge.sendControl`, which is the daemon's own channel.
 */
export function createTaskAnswerContinuation(bridge: TaskBridge): TaskAnswerHandler {
  return (questionId, answer) =>
    answerQuestion(questionId, answer, {
      continueWith: (task) => {
        const host = daemonToolHost(bridge, task.sessionId);
        const send: QuestionSendFn = (message) => {
          bridge.sendControl(message.type, { question: message.question });
        };
        resumeTaskInBackground(task.id, taskRunOptions(host, send, undefined, task.id));
        return Promise.resolve(task);
      },
    });
}
