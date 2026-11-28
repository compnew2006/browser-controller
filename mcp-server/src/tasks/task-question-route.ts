/**
 * The daemon side of the MCP process's question send (Task 8 ask binding).
 *
 * The MCP client process has no bridge, so it cannot call
 * `bridge.sendControl` itself: it sends the question as the internal wire
 * action `TASK_QUESTION_WIRE_ACTION` over the IPC `call` path, and the
 * daemon intercepts that action in `routeCall` before the memory/vault
 * routing and delivers it here — the same shape as the daemon-owned
 * memory tools, which `routeCall` intercepts the same way, and the same
 * internal-action pattern as `browser_classify_action`, which the MCP
 * process sends the same way.
 *
 * The question is validated with the question store's own validator
 * before anything is sent, so a malformed frame is refused with
 * `INVALID_ARGUMENT` instead of reaching the popup as a card with no
 * text. Only the question's own fields are forwarded: nothing else from
 * the IPC params crosses to the extension.
 */
import { isRecord } from '../core/guards.js';
import { ERROR_CODES, formatError } from '../core/error-codes.js';
import { validatePendingQuestion } from './question-store.js';
import { pushTaskStatus } from './task-status.js';

/** The bridge's control channel, structurally — this module never imports the bridge itself. */
export interface QuestionBridge {
  sendControl(type: string, payload?: Record<string, unknown>): void;
}

/** Deliver one question to the extension, or refuse it. The result is the IPC `call` outcome. */
export function routeTaskQuestion(
  bridge: QuestionBridge,
  params: Record<string, unknown>,
  tasksDir?: string,
): { success: true; result: { sent: boolean; questionId: string } } | { success: false; error: string } {
  if (!isRecord(params) || !('question' in params)) {
    return { success: false, error: formatError(ERROR_CODES.INVALID_ARGUMENT, 'a task question send needs a question') };
  }
  try {
    const question = validatePendingQuestion(params.question);
    bridge.sendControl('taskQuestion', { question });
    // The ask paused the task before sending (questions.ts), so the task
    // files already carry the pause: push the list at this pause moment.
    void pushTaskStatus(bridge, tasksDir);
    return { success: true, result: { sent: true, questionId: question.id } };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { success: false, error: formatError(ERROR_CODES.INVALID_ARGUMENT, detail) };
  }
}
