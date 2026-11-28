/**
 * The Tasks and Evidence panels (specs/011-professional-browsing-layer, Design §7; FR-018).
 *
 * Pure rendering, on the open-tabs-view.js pattern: strings in, strings out —
 * no DOM, no chrome.* — so it is unit-tested in Node (tests/popup-task-panels.test.ts).
 * popup.js owns the DOM: it renders these rows into the Tasks tab panel.
 *
 * What the popup shows now: the daemon pushes the task list as `taskStatus`
 * (extension/lib/task-status.js), re-read from the task files on pause,
 * resume, settle, and (re)connect — so a task appears here with its state
 * AND its steps, running or waiting, and the Evidence panel shows the
 * selected task's persisted evidence report. The session Q&A list stays
 * below the report as a secondary view, labelled by its own kinds
 * (waiting/confirmed), never as the report. Nothing here invents steps,
 * numbers, or outcomes: a task with no report shows "No report yet", and
 * an empty list shows "No tasks yet".
 */
import { escapeHtml } from './open-tabs-view.js';

/** The most tasks the panels ever render, mirroring the daemon's cap. */
export const TASK_PANELS_MAX_TASKS = 20;

/** The state badge label for a task state. */
export function taskStateLabel(state) {
  switch (state) {
    case 'running': return 'Running';
    case 'paused-question': return 'Waiting for answer';
    case 'paused-login': return 'Waiting for login';
    case 'planned': return 'Planned';
    case 'done': return 'Done';
    case 'failed': return 'Failed';
    default: return typeof state === 'string' ? state : '';
  }
}

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

/**
 * One selectable row per task from the `taskStatus` list: state badge,
 * goal, and its steps with per-step status. A running task is visible
 * with its steps, not only a task waiting on a question. Rows are
 * buttons: selecting one shows its report in the Evidence panel.
 */
export function renderTaskRows(tasks, selectedTaskId) {
  const list = (Array.isArray(tasks) ? tasks : []).slice(0, TASK_PANELS_MAX_TASKS);
  return list
    .map((task) => {
      const steps = (Array.isArray(task.steps) ? task.steps : [])
        .map(
          (step) => `<span class="task-step" data-status="${escapeHtml(step.status)}">${escapeHtml(String(step.step))} · ${escapeHtml(step.tool)} — ${escapeHtml(step.status)}</span>`,
        )
        .join('');
      const selected = typeof selectedTaskId === 'string' && task.id === selectedTaskId;
      return `<button type="button" class="task-row" data-action="selectTask" data-task-id="${escapeHtml(task.id)}"${selected ? ' aria-current="true"' : ''}>
        <span class="task-state" data-state="${escapeHtml(task.state)}">${escapeHtml(taskStateLabel(task.state))}</span>
        <span class="task-name">${escapeHtml(task.goal)}</span>
        <span class="task-steps">${steps}</span>
      </button>`;
    })
    .join('');
}

/**
 * The report summary for one task: the persisted `report.text`, falling
 * back to the structured `report.json` sections when the text is empty.
 * Returns '' when there is no report at all.
 */
export function reportSummaryText(report) {
  if (!report || typeof report !== 'object') return '';
  if (typeof report.text === 'string' && report.text.trim() !== '') return report.text;
  const json = report.json;
  if (!json || typeof json !== 'object') return '';
  const lines = [];
  if (Array.isArray(json.values) && json.values.length > 0) {
    const values = json.values.map((value) => value.value).filter((value) => typeof value === 'string');
    if (values.length > 0) {
      lines.push(`Found: ${values.slice(0, 5).join('; ')}${values.length > 5 ? ` (+${values.length - 5} more)` : ''}`);
    }
  }
  if (Array.isArray(json.sources) && json.sources.length > 0) {
    lines.push(`Sources: ${json.sources.join(', ')}`);
  }
  if (Array.isArray(json.checked) && json.checked.length > 0) {
    const counts = {};
    for (const checked of json.checked) {
      if (typeof checked.status === 'string') counts[checked.status] = (counts[checked.status] ?? 0) + 1;
    }
    lines.push(`Checked: ${Object.entries(counts).map(([status, count]) => `${count} ${status}`).join(', ')}`);
  }
  if (Array.isArray(json.unconfirmed) && json.unconfirmed.length > 0) {
    lines.push(`Unconfirmed: ${json.unconfirmed.map((item) => item.reason).join('; ')}`);
  }
  if (Array.isArray(json.notVerified) && json.notVerified.length > 0) {
    lines.push(`Not verified: ${json.notVerified.map((item) => item.reason).join('; ')}`);
  }
  return lines.join('\n');
}

/**
 * Evidence: the selected task's report summary first, then the
 * popup-session Q&A as a secondary view — the session rows keep their own
 * kinds (waiting/confirmed) and are never labelled as the report. With no
 * selected task, the most recent task with a report is shown; with no
 * report anywhere, this returns '' and the popup shows "No report yet".
 * `answers` are { taskId, questionId, answer } entries popup.js records
 * on the daemon ack.
 */
export function renderEvidenceRows(tasks, selectedTaskId, questions, answers) {
  const list = Array.isArray(tasks) ? tasks : [];
  const selected = list.find((task) => task.id === selectedTaskId)
    ?? list.find((task) => task.report)
    ?? null;
  const reportBlock = selected?.report
    ? `<div class="evidence-report">
      <span class="evidence-kind" data-kind="report">Report · ${escapeHtml(selected.goal)}</span>
      <div class="evidence-report-text">${escapeHtml(reportSummaryText(selected.report))}</div>
    </div>`
    : '';
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
  return [reportBlock, ...waiting, ...confirmed].join('');
}

/** Rebuild guard, like openTabsSignature: skip re-rendering when nothing changed. */
export function taskPanelsSignature(questions, answers, tasks, selectedTaskId) {
  return JSON.stringify([
    Array.isArray(questions) ? questions : [],
    Array.isArray(answers) ? answers : [],
    Array.isArray(tasks) ? tasks : [],
    typeof selectedTaskId === 'string' ? selectedTaskId : null,
  ]);
}
