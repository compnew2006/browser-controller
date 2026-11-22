/**
 * The human question protocol (specs/011-professional-browsing-layer, Design §5).
 *
 * A question is `{ id, taskId, text, options?, kind }`. Asking one pauses the
 * task in `paused-question` at its current step and sends the question to the
 * extension over the daemon↔extension WebSocket channel — the same channel
 * the bridge already uses for control messages (`bridge.sendControl`), never
 * a second channel. The user's answer returns the task to `running` from the
 * same step, never from the start. Only a choice that changes the outcome
 * and the original request did not determine is ever asked.
 *
 * This module never imports the runner: the continuation after an answer is
 * injected (`continueWith`, normally `runTask`), the same pattern `session.ts`
 * uses for `resumeAfterLogin`. The send side is injected too (`send`,
 * normally bound to `bridge.sendControl('taskQuestion', …)` by the daemon):
 * this module owns the pause/resume bookkeeping, the channel owns delivery.
 *
 * Questions live in a module-level registry, keyed by question id, and are
 * also persisted — one file per question under `<tasksDir>/questions/`
 * (`question-store.ts`, on the task store's own pattern) — because the task
 * shape from Task 1 has no questions field, so they cannot live in the task
 * file. The pause itself IS persisted too (state `paused-question` + the
 * step number in the evidence, via the store), so a restart still knows the
 * task is waiting; the persisted file is what makes it answerable after
 * one: `answerQuestion` loads a question from disk when the registry no
 * longer holds it, and `restorePendingQuestions` rehydrates the registry
 * (and re-asks the questions) at daemon start. A question file is deleted
 * the moment its answer lands.
 *
 * Mutation approval (binding ruling P4, second approval path): a question
 * may carry `context` naming the mutating step it approves. Answering `yes`
 * records a per-step approval constraint on the task
 * (`allow-mutations:step:<n>`, via `mutationApprovalConstraint`), so a later
 * resume runs that step without re-asking — and only that step. Answering
 * `no` fails the task with the refusal recorded as evidence, exactly as the
 * runner's refusal without a question does.
 */
import { randomUUID } from 'node:crypto';
import { defaultTasksDir, loadTask, saveTask } from './store.js';
import { saveTaskWithReport } from './reporting.js';
import { deletePendingQuestion, listPendingQuestions, loadPendingQuestion, savePendingQuestion } from './question-store.js';
import type { Task } from './types.js';

/** The kind of a question: a choice between options, a yes/no confirmation, or a free-text answer. */
export type QuestionKind = 'choice' | 'confirm' | 'text';

/** The mutating step a question approves, when the question is a mutation approval. */
export interface QuestionContext {
  stepIndex: number;
  tool: string;
  params: Record<string, unknown>;
}

/** A question asked of the user: what to ask, what to answer with, and which task waits for it. */
export interface Question {
  id: string;
  taskId: string;
  text: string;
  options?: string[];
  kind: QuestionKind;
  context?: QuestionContext;
}

/** Send a question to the extension on the daemon↔extension channel. */
export type QuestionSendFn = (message: { type: 'taskQuestion'; question: Question }) => void | Promise<void>;

/** How `askQuestion` pauses the task and delivers the question. */
export interface AskQuestionOptions {
  tasksDir?: string;
  /** The step the task stopped at; defaults to the first unfinished step. */
  stepIndex?: number;
  kind?: QuestionKind;
  /** The mutating step this question approves, when it is a mutation approval. */
  context?: QuestionContext;
  /**
   * Deliver the question to the extension — normally bound to
   * `bridge.sendControl('taskQuestion', …)`. When omitted the question is
   * still registered and the task still pauses; the caller (e.g. the
   * `browser_task_answer` tool) can answer it without the popup.
   */
  send?: QuestionSendFn;
}

/** How `answerQuestion` continues the task once answered. */
export interface AnswerQuestionOptions {
  tasksDir?: string;
  /**
   * Continue executing the task once the answer is recorded — normally
   * `runTask`, which resumes from the first unfinished step. When omitted
   * the task is left `running` for the caller to continue.
   */
  continueWith?: (task: Task) => Promise<Task>;
}

/** Pending questions by id: asked, not yet answered. */
const pending = new Map<string, Question>();

/** Every question asked and not yet answered. */
export function pendingQuestions(): Question[] {
  return [...pending.values()].map((question) => ({ ...question }));
}

/**
 * Rehydrate the registry from the persisted pending questions — the daemon
 * calls this at start, before any extension can connect, so a restart
 * neither loses the questions nor wedges their tasks. A persisted question
 * whose task is gone, or is no longer `paused-question`, is stale: its file
 * is deleted and it is not restored. Returns the questions that are still
 * waiting.
 */
export async function restorePendingQuestions(tasksDir: string = defaultTasksDir()): Promise<Question[]> {
  const restored: Question[] = [];
  for (const question of await listPendingQuestions(tasksDir)) {
    let task: Task | null = null;
    try {
      task = await loadTask(question.taskId, tasksDir);
    } catch {
      // A task file that cannot be read is stale: its question goes with it.
    }
    if (!task || task.state !== 'paused-question') {
      await deletePendingQuestion(question.id, tasksDir);
      continue;
    }
    pending.set(question.id, question);
    restored.push({ ...question });
  }
  return restored;
}

/** Forget a persisted question once its answer has landed; a stale file is dropped by the next restore. */
async function forgetPersistedQuestion(id: string, tasksDir?: string): Promise<void> {
  try {
    await deletePendingQuestion(id, tasksDir ?? defaultTasksDir());
  } catch {
    // The answer already landed; the file is harmless until restore drops it.
  }
}

/** The per-step mutation-approval constraint a `yes` answer records on the task. */
export function mutationApprovalConstraint(stepIndex: number): string {
  return `allow-mutations:step:${stepIndex}`;
}

/**
 * Param keys whose values must never reach a question, task evidence, or a
 * persisted question file: a mutating step's params can carry typed or
 * filled text, including credentials. Matching is by substring on the
 * lower-cased key, so `password`, `currentPassword`, `apiKey` and the like
 * are all caught; a key that merely contains one of these words is
 * dropped too — a dropped harmless param is safer than a leaked secret.
 */
const SENSITIVE_PARAM_KEYS = ['password', 'passwd', 'pwd', 'secret', 'token', 'credential', 'apikey', 'api_key', 'auth', 'otp', 'pin'];

/** Whether a param key names a value that must never be shown. */
function isSensitiveParamKey(key: string): boolean {
  const lowered = key.toLowerCase();
  return SENSITIVE_PARAM_KEYS.some((sensitive) => lowered.includes(sensitive));
}

/**
 * A mutating step's params as a question-safe summary: sensitive keys are
 * dropped outright, and every other value is shown as a short string,
 * truncated — so a long typed value cannot smuggle a secret past the
 * key list either. The shape stays a params object, so it can stand in
 * for the raw params wherever a question context is persisted.
 */
export function redactParamsForQuestion(params: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (isSensitiveParamKey(key)) continue;
    const shown = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
    redacted[key] = shown.length > 40 ? `${shown.slice(0, 40)}…` : shown;
  }
  return redacted;
}

/**
 * The mutation-approval question text: the step, the tool, and a redacted,
 * truncated param summary — never raw param values. Capped at 200 chars,
 * so a step with many params cannot flood the popup card or the evidence.
 */
export function mutationApprovalQuestionText(stepIndex: number, tool: string, params: Record<string, unknown>): string {
  const summary = Object.entries(redactParamsForQuestion(params))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(', ');
  const text = `Allow step ${stepIndex + 1} (${tool}) to change site data?${summary === '' ? '' : ` ${summary}`}`;
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/** The first step without an `ok` result — where a resume continues from — or the last step when all are done. */
function firstUnfinishedStep(task: Task): number {
  const index = task.steps.findIndex((step) => step.result?.status !== 'ok');
  return index === -1 ? Math.max(0, task.steps.length - 1) : index;
}

/**
 * Pause a task for a question: state `paused-question`, the current step
 * number in the evidence, saved. Throws when the task was never saved or is
 * already finished; pausing a finished task would rewrite its outcome.
 */
export async function pauseForQuestion(taskId: string, stepIndex?: number, tasksDir?: string): Promise<Task> {
  const task = await loadTask(taskId, tasksDir);
  if (!task) throw new Error(`task not found: ${taskId}`);
  if (task.state === 'done' || task.state === 'failed') {
    throw new Error(`cannot pause task ${taskId} for a question: task is ${task.state}`);
  }
  if (stepIndex !== undefined && (!Number.isSafeInteger(stepIndex) || stepIndex < 0 || stepIndex >= task.steps.length)) {
    throw new Error(`cannot pause task ${taskId} for a question: step index ${stepIndex} is out of range`);
  }
  const index = stepIndex ?? firstUnfinishedStep(task);
  task.state = 'paused-question';
  // The report describes the state the task settled in; the pause leaves
  // it, so the record carries no report until the task settles again —
  // otherwise a reader would see a report that claims the task is still
  // in its earlier state while it waits on a question.
  delete task.report;
  task.evidence.push(
    `paused for question at step ${index + 1} of ${task.steps.length} — waiting for the user's answer; resumes from the same step, never from the start`,
  );
  await saveTask(task, tasksDir);
  return task;
}

/**
 * Ask the user a question: pause the task in `paused-question` at its
 * current step and send the question to the extension. The question stays
 * pending until `answerQuestion` consumes it. A failure to deliver the
 * question does not unpause the task — the question is still pending and
 * answerable (e.g. through the `browser_task_answer` tool), and the failure
 * is recorded as evidence.
 */
export async function askQuestion(
  taskId: string,
  text: string,
  options?: string[],
  opts: AskQuestionOptions = {},
): Promise<Question> {
  const trimmed = text.trim();
  if (trimmed === '') throw new Error('a question needs text to ask');
  const kind = opts.kind ?? (options !== undefined ? 'choice' : 'text');
  if (kind === 'choice') {
    if (!options || options.length === 0) throw new Error('a choice question needs at least one option');
  }
  if (options !== undefined) {
    if (options.length === 0) throw new Error('a question needs at least one option');
    if (options.some((option) => typeof option !== 'string' || option.trim() === '')) {
      throw new Error('a question needs non-empty string options');
    }
  }
  if (kind === 'text' && options !== undefined) {
    throw new Error('a free-text question takes no options');
  }
  const task = await pauseForQuestion(taskId, opts.stepIndex ?? opts.context?.stepIndex, opts.tasksDir);
  const index = opts.stepIndex ?? opts.context?.stepIndex ?? firstUnfinishedStep(task);
  const resolvedOptions =
    kind === 'confirm' ? (options ?? ['yes', 'no']) : kind === 'choice' ? [...options!] : undefined;
  const question: Question = {
    id: randomUUID(),
    taskId,
    text: trimmed,
    ...(resolvedOptions ? { options: resolvedOptions } : {}),
    kind,
    ...(opts.context ? { context: opts.context } : {}),
  };
  pending.set(question.id, question);
  // Persist before delivering: a daemon restart between the ask and the
  // answer must not lose the question. A persist failure does not unpause
  // the task — the question stays pending in memory and answerable this
  // session, and the failure is recorded as evidence, like a send failure.
  try {
    await savePendingQuestion(question, opts.tasksDir ?? defaultTasksDir());
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    task.evidence.push(`question ${question.id} could not be persisted: ${detail} — the question stays pending in memory only and will not survive a restart`);
  }
  task.evidence.push(`question ${question.id} at step ${index + 1} of ${task.steps.length}: ${trimmed}`);
  await saveTask(task, opts.tasksDir);
  if (opts.send) {
    try {
      await opts.send({ type: 'taskQuestion', question });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      task.evidence.push(`question ${question.id} could not be sent to the extension: ${detail} — the question stays pending and can still be answered`);
      await saveTask(task, opts.tasksDir);
    }
  }
  return question;
}

/** Whether an answer counts as approval for a mutation-approval question. */
function isApproval(answer: string): boolean {
  return answer.trim().toLowerCase() === 'yes';
}

/**
 * Answer a pending question: record the answer as evidence and return the
 * task to `running` from the same step. A `yes` to a mutation-approval
 * question records the per-step approval on the task first, so the resume
 * runs that step without re-asking; a `no` fails the task instead, with the
 * refusal recorded as evidence and the step marked failed — the continuation
 * never runs. Throws when the question is unknown (never asked, already
 * answered, or its persisted file is gone), when the answer is not one of
 * the question's options, or when the task is not `paused-question`.
 */
export async function answerQuestion(
  id: string,
  answer: string,
  options: AnswerQuestionOptions = {},
): Promise<Task> {
  // The registry is in-memory: after a daemon restart it is empty, so a
  // question asked before the restart is loaded back from its persisted
  // file here instead of throwing "question not found" for a task that is
  // visibly still waiting.
  let question = pending.get(id);
  if (!question) {
    question = (await loadPendingQuestion(id, options.tasksDir ?? defaultTasksDir())) ?? undefined;
    if (question) pending.set(question.id, question);
  }
  if (!question) throw new Error(`question not found: ${id}`);
  // The options check is case-insensitive, like `isApproval` below: an
  // answer of "Yes" to a `['yes', 'no']` question is the same answer.
  if (question.options && !question.options.some((option) => option.toLowerCase() === answer.trim().toLowerCase())) {
    throw new Error(`answer "${answer}" is not one of the options for question ${id}`);
  }
  if (question.kind === 'text' && answer.trim() === '') {
    throw new Error(`question ${id} needs a non-empty answer`);
  }
  const task = await loadTask(question.taskId, options.tasksDir);
  if (!task) throw new Error(`task not found: ${question.taskId}`);
  if (task.state !== 'paused-question') {
    throw new Error(`cannot answer question ${id}: task ${question.taskId} is ${task.state}, not paused-question`);
  }
  const index = question.context?.stepIndex ?? firstUnfinishedStep(task);
  pending.delete(id);

  if (question.context && !isApproval(answer)) {
    // The user declined the mutation: fail exactly as the runner's refusal
    // without a question does — the step never runs, the refusal is evidence.
    const step = task.steps[index];
    const detail =
      `refused: user declined to allow mutating tool ${question.context.tool} at step ${index + 1} ` +
      `(needs explicit approval)`;
    if (step) step.result = { status: 'failed', detail };
    task.evidence.push(`answer to question ${id} at step ${index + 1} of ${task.steps.length}: ${answer} — ${detail}`);
    task.state = 'failed';
    await saveTaskWithReport(task, options.tasksDir);
    await forgetPersistedQuestion(id, options.tasksDir);
    return task;
  }

  if (question.context && isApproval(answer)) {
    const constraint = mutationApprovalConstraint(question.context.stepIndex);
    if (!task.constraints.includes(constraint)) task.constraints.push(constraint);
    task.evidence.push(
      `user approved mutating tool ${question.context.tool} at step ${index + 1} of ${task.steps.length} (question ${id}) — approval recorded for that step only`,
    );
  }
  task.state = 'running';
  // The report describes the paused state; the answer leaves it, so the
  // record carries no report until the resumed run settles again.
  delete task.report;
  task.evidence.push(
    `answer to question ${id} at step ${index + 1} of ${task.steps.length}: ${answer} — resuming from the same step`,
  );
  await saveTask(task, options.tasksDir);
  await forgetPersistedQuestion(id, options.tasksDir);
  if (options.continueWith) return options.continueWith(task);
  return task;
}
