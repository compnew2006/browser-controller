import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  renderEvidenceRows,
  renderTaskRows,
  reportSummaryText,
  taskPanelsSignature,
  tasksFromQuestions,
} from '../extension/popup/task-panels-view.js';
import {
  clearTaskStatus,
  isTaskStatusMessage,
  recordTaskStatus,
  taskStatusList,
} from '../extension/lib/task-status.js';

const repoRoot = join(import.meta.dirname, '..');
const popupHtml = readFileSync(join(repoRoot, 'extension', 'popup', 'popup.html'), 'utf8');
const popupJs = readFileSync(join(repoRoot, 'extension', 'popup', 'popup.js'), 'utf8');

const runningTask = {
  id: 'task-1',
  goal: 'Open the dashboard and confirm it loaded',
  state: 'running',
  steps: [
    { step: 1, tool: 'browser_snapshot', status: 'ok' },
    { step: 2, tool: 'browser_navigate', status: 'not-run' },
  ],
};

const doneTask = {
  id: 'task-2',
  goal: 'Check the balance',
  state: 'done',
  steps: [
    { step: 1, tool: 'browser_snapshot', status: 'ok' },
    { step: 2, tool: 'browser_snapshot', status: 'ok' },
  ],
  report: {
    text: 'ما تم فحصه: الخطوتان.\nالقيم التي وُجدت: Balance: 1,234.56',
    json: {
      taskId: 'task-2',
      goal: 'Check the balance',
      state: 'done',
      checked: [
        { step: 1, tool: 'browser_snapshot', verify: [], status: 'ok' },
        { step: 2, tool: 'browser_snapshot', verify: [], status: 'ok' },
      ],
      values: [{ step: 1, tool: 'browser_snapshot', value: 'Balance: 1,234.56' }],
      sources: ['https://example.test/dashboard'],
      unconfirmed: [],
      notVerified: [],
    },
  },
};

const jsonOnlyTask = {
  id: 'task-3',
  goal: 'Check the invoices',
  state: 'failed',
  steps: [{ step: 1, tool: 'browser_snapshot', status: 'failed' }],
  report: {
    text: '',
    json: {
      taskId: 'task-3',
      goal: 'Check the invoices',
      state: 'failed',
      checked: [{ step: 1, tool: 'browser_snapshot', verify: [], status: 'failed' }],
      values: [{ step: 1, tool: 'browser_snapshot', value: 'Invoices: 42' }],
      sources: ['https://example.test/invoices'],
      unconfirmed: [{ step: 1, tool: 'browser_snapshot', reason: 'the page was never read' }],
      notVerified: [],
    },
  },
};

describe('Tasks panel from taskStatus', () => {
  it('renders a task with steps: state badge, goal, and per-step status', () => {
    const html = renderTaskRows([runningTask]);
    expect(html).toContain('data-state="running"');
    expect(html).toContain('Running');
    expect(html).toContain('Open the dashboard and confirm it loaded');
    expect(html).toContain('browser_snapshot');
    expect(html).toContain('browser_navigate');
    expect(html).toContain('data-status="ok"');
    expect(html).toContain('data-status="not-run"');
    // A running task is visible with its steps, not only while it waits on a question.
    expect(html).not.toContain('Waiting for answer');
  });

  it('renders the 20-task cap and keeps most-recent-first order', () => {
    const tasks = Array.from({ length: 21 }, (_, i) => ({
      id: `task-${String(i).padStart(2, '0')}`,
      goal: `Goal ${i}`,
      state: 'running',
      steps: [],
    }));
    const html = renderTaskRows(tasks);
    expect((html.match(/class="task-row"/g) ?? []).length).toBe(20);
    expect(html.indexOf('Goal 0')).toBeLessThan(html.indexOf('Goal 1'));
    expect(html).not.toContain('Goal 20');
  });

  it('renders nothing for an empty list, and the popup shows the new empty state', () => {
    expect(renderTaskRows([])).toBe('');
    expect(renderTaskRows(undefined)).toBe('');
    expect(popupHtml).toContain('No tasks yet');
    expect(popupJs).toContain('No tasks yet');
  });

  it('renders each task row as a selectable control (Evidence selection)', () => {
    const html = renderTaskRows([runningTask, doneTask], 'task-2');
    expect(html).toContain('data-action="selectTask"');
    expect(html).toContain('data-task-id="task-2"');
    expect(html).toContain('aria-current="true"');
  });
});

describe('Evidence panel from taskStatus', () => {
  it('renders the selected task report summary from report.text', () => {
    const html = renderEvidenceRows([runningTask, doneTask], 'task-2', []);
    expect(html).toContain('data-kind="report"');
    expect(html).toContain('ما تم فحصه: الخطوتان.');
    expect(html).toContain('Balance: 1,234.56');
    expect(html).toContain('Check the balance');
  });

  it('falls back to the structured report.json sections when report.text is empty', () => {
    const summary = reportSummaryText(jsonOnlyTask.report);
    expect(summary).toContain('Invoices: 42');
    expect(summary).toContain('https://example.test/invoices');
    const html = renderEvidenceRows([jsonOnlyTask], 'task-3', []);
    expect(html).toContain('Invoices: 42');
  });

  it('defaults to the most recent task with a report when nothing is selected', () => {
    const html = renderEvidenceRows([doneTask, runningTask], null, []);
    expect(html).toContain('Balance: 1,234.56');
  });

  it('renders "No report yet" for a task that has never settled', () => {
    expect(renderEvidenceRows([runningTask], 'task-1', [])).toBe('');
    expect(renderEvidenceRows([], null, [])).toBe('');
    expect(popupHtml).toContain('No report yet');
    expect(popupJs).toContain('No report yet');
  });

  it('keeps the session Q&A as a secondary view, never labelled as the report', () => {
    const questions = [{ id: 'q-1', taskId: 'task-1', text: 'Which report?', options: ['Sales'], kind: 'choice' }];
    const answers = [{ taskId: 'task-1', questionId: 'q-0', answer: 'Sales' }];
    const html = renderEvidenceRows([runningTask, doneTask], 'task-2', questions, answers);
    expect(html).toContain('Balance: 1,234.56');
    expect(html).toContain('Sales');
    // Exactly one report block; the session rows keep their own kinds.
    expect((html.match(/data-kind="report"/g) ?? []).length).toBe(1);
    expect(html).toContain('data-kind="confirmed"');
    expect(html).toContain('data-kind="waiting"');
    expect(tasksFromQuestions(questions)).toHaveLength(1);
  });
});

describe('taskStatus store (extension/lib/task-status.js)', () => {
  it('records the latest payload keyed by task id and lists it in payload order', () => {
    clearTaskStatus();
    expect(recordTaskStatus([runningTask, doneTask])).toBe(true);
    expect(taskStatusList().map((t) => t.id)).toEqual(['task-1', 'task-2']);
    // A newer payload replaces the entry for the same task id.
    const updated = { ...runningTask, state: 'done' };
    recordTaskStatus([updated, doneTask]);
    expect(taskStatusList().map((t) => t.id)).toEqual(['task-1', 'task-2']);
    expect(taskStatusList()[0]?.state).toBe('done');
    clearTaskStatus();
    expect(taskStatusList()).toEqual([]);
  });

  it('accepts a taskStatus control message and drops a malformed payload', () => {
    expect(isTaskStatusMessage({ type: 'taskStatus', tasks: [runningTask] })).toBe(true);
    expect(isTaskStatusMessage({ type: 'taskStatus', tasks: [{ id: 'x' }] })).toBe(false);
    expect(isTaskStatusMessage({ type: 'taskQuestion', tasks: [runningTask] })).toBe(false);
    expect(recordTaskStatus('nope')).toBe(false);
  });
});

describe('task panels signature guard', () => {
  it('is stable for the same payload and changes when tasks or selection change', () => {
    const questions = [{ id: 'q-1', taskId: 'task-1', text: 'Which report?', kind: 'choice' }];
    const answers: Array<unknown> = [];
    const sig = taskPanelsSignature(questions, answers, [runningTask], null);
    expect(taskPanelsSignature(questions, answers, [runningTask], null)).toBe(sig);
    expect(taskPanelsSignature(questions, answers, [runningTask, doneTask], null)).not.toBe(sig);
    expect(taskPanelsSignature(questions, answers, [runningTask], 'task-1')).not.toBe(sig);
  });
});
