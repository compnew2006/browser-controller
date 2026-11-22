/**
 * The task question card's DOM side (specs/011-professional-browsing-layer, Design §5).
 *
 * Owns the #taskQuestions section in the popup: renders the pending
 * questions into it and answers through the `onAnswer` callback popup.js
 * supplies (which sends `answerTaskQuestion` to the background worker).
 * The markup comes from question-card.js — the separable unit Task 9's
 * Questions panel hosts — this module only swaps it into the section.
 *
 * The section sits outside the tab panels, so the card stays visible and
 * clickable whichever panel is open and while the tab the task works on is
 * shielded (the shield is injected into the page; the popup is never
 * shielded). Rendering is guarded by a signature, like the Open Tabs rows:
 * a rebuild would drop the text the user is typing into a free-text answer.
 */
import { renderQuestionCards } from './question-card.js';

/**
 * Bind the Questions section. `onAnswer(questionId, answer)` fires only
 * for a non-empty answer; an empty free-text Send just nudges the input's
 * placeholder and leaves the card in place.
 */
export function bindTaskQuestions(onAnswer) {
  const questionsEl = document.getElementById('taskQuestions');
  let lastSignature = '';

  questionsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="answerQuestion"]');
    if (!btn) return;
    const questionId = btn.dataset.questionId;
    // A free-text question's button names its input instead of an answer.
    const input = btn.dataset.answerInput
      ? questionsEl.querySelector(`.question-input[data-answer-input="${btn.dataset.answerInput}"]`)
      : null;
    const answer = input ? input.value.trim() : btn.dataset.answer;
    if (!questionId || !answer) {
      if (input) input.placeholder = 'Type an answer first';
      return;
    }
    onAnswer(questionId, answer);
  });

  return {
    render(questions) {
      const list = Array.isArray(questions) ? questions : [];
      const sig = JSON.stringify(list);
      if (sig === lastSignature) return;
      lastSignature = sig;
      questionsEl.innerHTML = renderQuestionCards(list);
      questionsEl.hidden = list.length === 0;
    },
  };
}
