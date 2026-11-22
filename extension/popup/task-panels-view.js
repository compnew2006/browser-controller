/**
 * The Tasks and Evidence panels (specs/011-professional-browsing-layer, Design §7).
 *
 * Pure rendering, on the open-tabs-view.js pattern: strings in, strings out —
 * no DOM, no chrome.* — so it is unit-tested in Node (tests/popup-responsive.test.ts).
 * popup.js owns the DOM: it renders these rows into the Tasks tab panel.
 *
 * What the popup can honestly show: the daemon sends the popup no task list
 * and no evidence report — the status payload carries only the pending
 * questions (extension/lib/connection.js). So a task appears here exactly
 * while it waits on a question (state paused-question, grouped by task id),
 * and the Evidence panel lists what the popup itself has seen: the questions
 * still waiting, and the answers confirmed in this popup session. A task
 * with no pending question is invisible here; that is a data gap, not a
 * rendering choice — the full server-side evidence report (Task 5) has no
 * popup endpoint yet. Nothing here invents steps, numbers, or outcomes.
 * FR-018 (Tasks as state AND steps, Evidence as the report summary) is
 * therefore NOT delivered by these panels: the copy says what the panels
 * actually show instead of overclaiming, and the endpoint that would
 * deliver it is a documented follow-up (see
 * docs/superpowers/plans/2026-11-22-professional-browsing-layer-endpoint-followup.md).
 */
import { escapeHtml } from './open-tabs-view.js';

/** Pending questions grouped by task: one entry per task, newest question first. */
export function tasksFromQuestions(questions) {
  if (!Array.isArray(questions)) return [];
  const byTask = new Map();
  for (const question of [...questions].reverse()) {
    if (!question || typeof question.taskId !== 'string') continue;
    if (!byTask.has(question.taskId)) {
      byTask.set(question.taskId, {
        taskId: question.taskId,
        state: 'paused-question',
        waitingOn: typeof question.text === 'string' ? question.text : '',
        questionId: question.id,
      });
    }
  }
  return [...byTask.values()];
}

/** One row per waiting task: state badge, task name, the question it waits on. */
export function renderTaskRows(questions) {
  return tasksFromQuestions(questions)
    .map(
      (task) => `<div class="task-row">
        <span class="task-state" data-state="${escapeHtml(task.state)}">Waiting for answer</span>
        <span class="task-name">Task ${escapeHtml(task.taskId)}</span>
        <span class="task-waiting">${escapeHtml(task.waitingOn)}</span>
      </div>`,
    )
    .join('');
}

/**
 * Evidence rows: every pending question (still waiting) and every answer
 * confirmed in this popup session (resolved). `answers` are
 * { taskId, questionId, answer } entries popup.js records on the daemon ack.
 */
export function renderEvidenceRows(questions, answers) {
  const waiting = tasksFromQuestions(questions).map(
    (task) => `<div class="evidence-row">
      <span class="evidence-kind" data-kind="waiting">Waiting</span>
      <span class="evidence-text">Task ${escapeHtml(task.taskId)}: ${escapeHtml(task.waitingOn)}</span>
    </div>`,
  );
  const confirmed = (Array.isArray(answers) ? answers : []).map(
    (entry) => `<div class="evidence-row">
      <span class="evidence-kind" data-kind="confirmed">Confirmed</span>
      <span class="evidence-text">Task ${escapeHtml(entry.taskId || '')}: ${escapeHtml(entry.answer || '')}</span>
    </div>`,
  );
  return [...waiting, ...confirmed].join('');
}

/** Rebuild guard, like openTabsSignature: skip re-rendering when nothing changed. */
export function taskPanelsSignature(questions, answers) {
  return JSON.stringify([Array.isArray(questions) ? questions : [], Array.isArray(answers) ? answers : []]);
}
