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
 * Questions live in a module-level registry, keyed by question id — the task
 * shape from Task 1 has no questions field, so they are not persisted in the
 * task file. The pause itself IS persisted (state `paused-question` + the
 * step number in the evidence, via the store), so a restart still knows the
 * task is waiting; the question text is also in the evidence, so what was
 * asked survives even if the registry does not.
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
import { loadTask, saveTask } from './store.js';
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

/** The per-step mutation-approval constraint a `yes` answer records on the task. */
export function mutationApprovalConstraint(stepIndex: number): string {
  return `allow-mutations:step:${stepIndex}`;
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
 * never runs. Throws when the question is unknown (never asked, or already
 * answered), when the answer is not one of the question's options, or when
 * the task is not `paused-question`.
 */
export async function answerQuestion(
  id: string,
  answer: string,
  options: AnswerQuestionOptions = {},
): Promise<Task> {
  const question = pending.get(id);
  if (!question) throw new Error(`question not found: ${id}`);
  if (question.options && !question.options.includes(answer)) {
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
    await saveTask(task, options.tasksDir);
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
  task.evidence.push(
    `answer to question ${id} at step ${index + 1} of ${task.steps.length}: ${answer} — resuming from the same step`,
  );
  await saveTask(task, options.tasksDir);
  if (options.continueWith) return options.continueWith(task);
  return task;
}
