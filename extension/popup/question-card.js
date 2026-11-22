/**
 * The task question card (specs/011-professional-browsing-layer, Design §5).
 *
 * A separable unit, built to be hosted — not rebuilt — by the Questions
 * panel Task 9 adds to the popup: this module owns the card's markup and
 * nothing else (pure rendering: strings in, strings out — no DOM, no
 * chrome.* — so it is unit-tested in Node, tests/extension-question-card.test.ts).
 * popup.js owns the DOM: it renders the pending questions into the
 * #taskQuestions section and answers through `answerTaskQuestion`.
 *
 * The card renders in the popup document itself, OUTSIDE the shielded tab:
 * the lock shield is injected into the PAGE by overlay.js, while the popup
 * is a separate browser UI surface that is never shielded — so the card
 * stays clickable while the tab is shielded. The card never touches the tab:
 * no overlay import, no chrome.tabs, only enabled buttons.
 */
import { escapeHtml } from './open-tabs-view.js';

/** The options a question offers as buttons: its own, or yes/no for a bare confirm. */
function answerOptions(question) {
  if (Array.isArray(question.options) && question.options.length > 0) return question.options;
  if (question.kind === 'confirm') return ['yes', 'no'];
  return [];
}

/**
 * One question card: the question text and one enabled button per option
 * (or, for a free-text question, an input and a send button). Each button
 * carries the question id and its answer for popup.js's delegation.
 */
export function renderQuestionCard(question) {
  const id = escapeHtml(question.id);
  const taskId = escapeHtml(question.taskId);
  const text = escapeHtml(question.text);
  const options = answerOptions(question);
  const buttons = options
    .map(
      (option) =>
        `<button type="button" class="question-answer" data-action="answerQuestion" data-question-id="${id}" data-answer="${escapeHtml(option)}">${escapeHtml(option)}</button>`,
    )
    .join('');
  const freeText =
    question.kind === 'text'
      ? `<div class="question-input-row"><input type="text" class="question-input" data-answer-input="${id}" placeholder="Type your answer…" autocomplete="off"><button type="button" class="question-answer" data-action="answerQuestion" data-question-id="${id}" data-answer-input="${id}">Send</button></div>`
      : '';
  return `<article class="question-card" data-question-id="${id}" data-task-id="${taskId}">
    <div class="question-task">Task ${taskId} asks:</div>
    <div class="question-text">${text}</div>
    ${buttons ? `<div class="question-options">${buttons}</div>` : ''}
    ${freeText}
  </article>`;
}

/** Every pending question as cards, newest first; '' when none are pending. */
export function renderQuestionCards(questions) {
  if (!Array.isArray(questions) || questions.length === 0) return '';
  return [...questions].reverse().map((question) => renderQuestionCard(question)).join('');
}
