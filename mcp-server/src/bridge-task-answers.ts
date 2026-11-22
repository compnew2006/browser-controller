/**
 * The daemon-side receiver for the extension's `taskAnswer` frames (specs/
 * 011-professional-browsing-layer, Design §5): the popup's answer to a task
 * question, sent over the daemon↔extension WebSocket as
 * `{ type: 'taskAnswer', questionId, answer }`.
 *
 * The bridge's `onmessage` used to handle only `helloAck`/`pong`/
 * `vaultTransport` and otherwise resolve frames against `pendingRequests`
 * by `msg.id`; a `taskAnswer` frame carries no request id, so it was
 * silently dropped and the popup's "Answer sent" was a lie. This module is
 * the receiver: it validates the frame, runs the injected handler (bound by
 * the daemon to `answerQuestion` with the `runTask` resume —
 * `tasks/wiring.ts`, `createTaskAnswerContinuation`), and acknowledges
 * the frame back to the extension as `taskAnswerAck` so the popup reports
 * success only once the daemon actually accepted the answer. The resume
 * itself runs in the background, so the ack settles once the answer is
 * recorded, not once the resumed task finishes.
 *
 * The handler runs asynchronously and never throws into the socket loop:
 * a rejection is logged and acknowledged as `ok: false`, so the extension
 * can re-record the question and let the user retry.
 */
import { createLogger } from './core/logger.js';
import { isRecord } from './core/guards.js';

const log = createLogger('Bridge');

/** Consume a task answer: normally `answerQuestion` with its `runTask` resume. Its promise settles the ack: the extension is told success only once the answer is recorded. */
export type TaskAnswerHandler = (questionId: string, answer: string) => void | Promise<unknown>;

/** The acknowledgement sent back to the extension for one `taskAnswer` frame. */
export interface TaskAnswerAck {
  questionId: string;
  ok: boolean;
  error?: string;
}

/** Send an ack, never throwing: the socket may have gone while the answer was handled. */
function acknowledge(sendAck: (ack: TaskAnswerAck) => void, ack: TaskAnswerAck): void {
  try {
    sendAck(ack);
  } catch {
    // socket gone — close path will fire
  }
}

/**
 * Route one incoming frame. Returns true when it was a `taskAnswer` frame
 * (handled, malformed, or received with no handler set) so the caller
 * stops dispatching it; false for anything else. Never throws.
 */
export function dispatchTaskAnswer(
  msg: unknown,
  handler: TaskAnswerHandler | null,
  sendAck: (ack: TaskAnswerAck) => void,
): boolean {
  if (!isRecord(msg) || msg.type !== 'taskAnswer') return false;
  const questionId = msg.questionId;
  if (typeof questionId !== 'string' || questionId === '') {
    log.warn('taskAnswer frame without a question id — dropped');
    return true;
  }
  const answer = msg.answer;
  if (typeof answer !== 'string' || answer.trim() === '') {
    log.warn(`taskAnswer for question ${questionId} without an answer — dropped`);
    acknowledge(sendAck, { questionId, ok: false, error: 'a task answer needs a non-empty answer' });
    return true;
  }
  if (!handler) {
    log.warn(`taskAnswer for question ${questionId} received with no answer handler — dropped`);
    acknowledge(sendAck, { questionId, ok: false, error: 'the daemon has no task answer handler' });
    return true;
  }
  void Promise.resolve()
    .then(() => handler(questionId, answer))
    .then(
      () => acknowledge(sendAck, { questionId, ok: true }),
      (error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        log.error(`taskAnswer for question ${questionId} was not accepted: ${detail}`);
        acknowledge(sendAck, { questionId, ok: false, error: detail });
      },
    );
  return true;
}
