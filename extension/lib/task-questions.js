/**
 * Pending task questions in the extension (specs/011-professional-browsing-layer, Design §5).
 *
 * Pure module — no DOM, no chrome.* — so it is unit-tested in Node
 * (tests/extension-question-card.test.ts). The router records a question the
 * daemon sent over the WebSocket (`taskQuestion`); the popup reads the
 * pending list through the status payload and renders the card; answering
 * takes the question out again. One card per task: a second question for
 * the same task replaces the first, so the popup never shows two cards
 * fighting over one task.
 */

/** Questions the daemon asked and the user has not answered yet, by task id. */
const pendingByTask = new Map();

/** Whether a value is a question the daemon may ask: id, taskId and text are strings, options (when present) a list of strings. */
export function isTaskQuestion(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (typeof value.id !== 'string' || value.id === '') return false;
  if (typeof value.taskId !== 'string' || value.taskId === '') return false;
  if (typeof value.text !== 'string' || value.text.trim() === '') return false;
  if (value.options !== undefined) {
    if (!Array.isArray(value.options) || value.options.some((option) => typeof option !== 'string')) return false;
  }
  if (value.kind !== undefined && !['choice', 'confirm', 'text'].includes(value.kind)) return false;
  return true;
}

/** Whether a daemon WebSocket message is a question to record. */
export function isTaskQuestionMessage(msg) {
  return !!msg && msg.type === 'taskQuestion' && isTaskQuestion(msg.question);
}

/** Record a pending question, replacing any earlier one for the same task. */
export function recordTaskQuestion(question) {
  if (!isTaskQuestion(question)) return false;
  pendingByTask.set(question.taskId, question);
  return true;
}

/** Every pending question, in the order asked (the card renderer shows the newest first). */
export function pendingTaskQuestions() {
  return [...pendingByTask.values()];
}

/** Take a pending question out by its id (answering it), or undefined when it is not pending. */
export function takeTaskQuestion(id) {
  for (const [taskId, question] of pendingByTask) {
    if (question.id === id) {
      pendingByTask.delete(taskId);
      return question;
    }
  }
  return undefined;
}

/** Read a pending question by its id without taking it out, or undefined when it is not pending. */
export function peekTaskQuestion(id) {
  for (const question of pendingByTask.values()) {
    if (question.id === id) return question;
  }
  return undefined;
}

/**
 * Waiters for the daemon's `taskAnswerAck` (Design §5): `events.js`
 * registers one per answered question, and the router resolves it when the
 * ack lands. A waiter that is never resolved is a lost answer if it is
 * left hanging — so it times out instead, and the caller re-records the
 * question for retry.
 */
const answerWaiters = new Map();

/** Wait for the daemon to accept (or refuse) one sent answer. Resolves `{ ok, error? }`; a missing ack resolves `{ ok: false }` after `timeoutMs`. */
export function waitForTaskAnswerAck(questionId, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      answerWaiters.delete(questionId);
      resolve({ ok: false, error: 'The daemon did not confirm the answer — try again.' });
    }, timeoutMs);
    answerWaiters.set(questionId, { resolve, timer });
  });
}

/** Resolve a waiter with the daemon's `taskAnswerAck` frame; false when it is not an ack, or no answer is waiting for it. */
export function resolveTaskAnswerAck(msg) {
  if (!msg || msg.type !== 'taskAnswerAck' || typeof msg.questionId !== 'string') return false;
  const waiter = answerWaiters.get(msg.questionId);
  if (!waiter) return false;
  clearTimeout(waiter.timer);
  answerWaiters.delete(msg.questionId);
  waiter.resolve({ ok: msg.ok === true, error: typeof msg.error === 'string' ? msg.error : undefined });
  return true;
}

/** Drop every pending question (tests; a daemon restart asks again). */
export function clearTaskQuestions() {
  pendingByTask.clear();
}
