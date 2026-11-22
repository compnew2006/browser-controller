import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderQuestionCard, renderQuestionCards } from '../extension/popup/question-card.js';
import {
  clearTaskQuestions,
  isTaskQuestionMessage,
  peekTaskQuestion,
  pendingTaskQuestions,
  recordTaskQuestion,
  resolveTaskAnswerAck,
  takeTaskQuestion,
  waitForTaskAnswerAck,
} from '../extension/lib/task-questions.js';

const repoRoot = join(import.meta.dirname, '..');
const popupHtml = readFileSync(join(repoRoot, 'extension', 'popup', 'popup.html'), 'utf8');
const popupJs = readFileSync(join(repoRoot, 'extension', 'popup', 'popup.js'), 'utf8');
const questionCardSource = readFileSync(join(repoRoot, 'extension', 'popup', 'question-card.js'), 'utf8');

const choiceQuestion = {
  id: 'q-1',
  taskId: 'task-1',
  text: 'Which report should I open?',
  options: ['Sales', 'Stock'],
  kind: 'choice',
};

describe('question card rendering', () => {
  it('test_question_card_renders_outside_shielded_tab', () => {
    // The card's host is the popup document itself, NOT the page: the
    // Questions section sits in popup.html as a sibling of the tab panels —
    // above <main class="panels">, inside .shell — so it renders even when
    // the tab the task works on is shielded (the lock shield is injected
    // into the PAGE by overlay.js; the popup is a separate browser UI
    // surface and is never shielded). A card trapped inside a shielded tab
    // would lock the user out of answering.
    const questionsAt = popupHtml.indexOf('id="taskQuestions"');
    expect(questionsAt).toBeGreaterThan(-1);
    const panelsAt = popupHtml.indexOf('<main class="panels">');
    expect(panelsAt).toBeGreaterThan(-1);
    expect(questionsAt).toBeLessThan(panelsAt);
    // It is not inside any tab panel: the section between the tabbar and
    // the panels is outside every [data-panel].
    const shellSlice = popupHtml.slice(popupHtml.indexOf('<div class="shell">'), panelsAt);
    expect(shellSlice).toContain('id="taskQuestions"');
    expect(shellSlice).not.toContain('data-panel=');

    // The card module never touches the tab: no overlay/shield import and
    // no chrome.tabs call — it cannot be drawn into (or blocked by) the page.
    expect(questionCardSource).not.toMatch(/import\s+[^;]*overlay\.js/);
    expect(questionCardSource).not.toMatch(/chrome\.tabs\.[a-z]/);

    // And the rendered card stays clickable while the tab is shielded: real
    // enabled buttons, one per option, carrying the answer — no disabled
    // state, no pointer-events:none, no inert wrapper.
    const html = renderQuestionCard(choiceQuestion);
    expect(html).toContain('Which report should I open?');
    expect(html).toContain('data-action="answerQuestion"');
    expect(html).toContain('data-question-id="q-1"');
    expect(html).toContain('data-answer="Sales"');
    expect(html).toContain('data-answer="Stock"');
    expect(html).not.toMatch(/disabled/);
    expect(html).not.toMatch(/pointer-events:\s*none/);
    expect(html).not.toMatch(/<[^>]*\binert\b/);
  });

  it('renders the question text, one button per option, and the task id', () => {
    const html = renderQuestionCard(choiceQuestion);
    expect(html).toContain('data-question-id="q-1"');
    expect(html).toContain('data-task-id="task-1"');
    expect(html.match(/data-action="answerQuestion"/g)).toHaveLength(2);
  });

  it('renders a confirm question as yes/no buttons when no options are given', () => {
    const html = renderQuestionCard({
      id: 'q-2',
      taskId: 'task-1',
      text: 'Allow this change?',
      kind: 'confirm',
    });
    expect(html).toContain('data-answer="yes"');
    expect(html).toContain('data-answer="no"');
  });

  it('renders a free-text question as an input with a send button', () => {
    const html = renderQuestionCard({
      id: 'q-3',
      taskId: 'task-1',
      text: 'What should I search for?',
      kind: 'text',
    });
    expect(html).toContain('<input');
    expect(html).toContain('data-action="answerQuestion"');
    expect(html).toContain('data-answer-input="q-3"');
  });

  it('escapes question text and option values', () => {
    const html = renderQuestionCard({
      id: 'q-4',
      taskId: 'task-1',
      text: '<img src=x onerror=alert(1)>',
      options: ['<b>evil</b>'],
      kind: 'choice',
    });
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>evil');
    expect(html).toContain('&lt;img');
  });

  it('renders several pending questions, newest first, and none when empty', () => {
    expect(renderQuestionCards([])).toBe('');
    const html = renderQuestionCards([
      choiceQuestion,
      { id: 'q-5', taskId: 'task-2', text: 'Second?', kind: 'confirm' },
    ]);
    expect(html).toContain('data-question-id="q-1"');
    expect(html).toContain('data-question-id="q-5"');
    // Newest first: the later question comes first in the markup.
    expect(html.indexOf('data-question-id="q-5"')).toBeLessThan(html.indexOf('data-question-id="q-1"'));
  });
});

describe('pending task questions (extension store)', () => {
  it('records a daemon question message, lists it pending, and takes it on answer', () => {
    clearTaskQuestions();
    const msg = { type: 'taskQuestion', question: choiceQuestion };
    expect(isTaskQuestionMessage(msg)).toBe(true);
    recordTaskQuestion(choiceQuestion);
    expect(pendingTaskQuestions()).toEqual([choiceQuestion]);
    const taken = takeTaskQuestion('q-1');
    expect(taken).toEqual(choiceQuestion);
    expect(pendingTaskQuestions()).toEqual([]);
    expect(takeTaskQuestion('q-1')).toBeUndefined();
    clearTaskQuestions();
  });

  it('rejects malformed question messages instead of recording them', () => {
    clearTaskQuestions();
    expect(isTaskQuestionMessage({ type: 'taskQuestion' })).toBe(false);
    expect(isTaskQuestionMessage({ type: 'taskQuestion', question: { id: 'q-1' } })).toBe(false);
    expect(isTaskQuestionMessage({ type: 'taskQuestion', question: { ...choiceQuestion, text: 42 } })).toBe(false);
    expect(isTaskQuestionMessage({ type: 'other', question: choiceQuestion })).toBe(false);
    expect(isTaskQuestionMessage({ type: 'taskQuestion', question: { ...choiceQuestion, options: 'Sales' } })).toBe(false);
    expect(pendingTaskQuestions()).toEqual([]);
    clearTaskQuestions();
  });

  it('a second question for the same task replaces the first (one card per task)', () => {
    clearTaskQuestions();
    recordTaskQuestion(choiceQuestion);
    recordTaskQuestion({ ...choiceQuestion, id: 'q-9', text: 'Which one now?' });
    const pending = pendingTaskQuestions();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe('q-9');
    clearTaskQuestions();
  });

  it('peeks a question without taking it out', () => {
    clearTaskQuestions();
    recordTaskQuestion(choiceQuestion);
    expect(peekTaskQuestion('q-1')).toEqual(choiceQuestion);
    expect(pendingTaskQuestions()).toEqual([choiceQuestion]);
    expect(peekTaskQuestion('q-9')).toBeUndefined();
    clearTaskQuestions();
  });
});

describe('task answer acknowledgement (taskAnswerAck)', () => {
  it('resolves a waiter with the daemon ack, and ignores acks nobody waits on', async () => {
    const waiting = waitForTaskAnswerAck('q-1', 1000);
    expect(resolveTaskAnswerAck({ type: 'taskAnswerAck', questionId: 'q-1', ok: true })).toBe(true);
    await expect(waiting).resolves.toEqual({ ok: true, error: undefined });
    expect(resolveTaskAnswerAck({ type: 'taskAnswerAck', questionId: 'q-1', ok: true })).toBe(false);
    expect(resolveTaskAnswerAck({ type: 'other', questionId: 'q-1', ok: true })).toBe(false);
    expect(resolveTaskAnswerAck({ type: 'taskAnswerAck', questionId: 'q-2', ok: false, error: 'gone' })).toBe(false);
  });

  it('a missing ack resolves the waiter as not accepted after its timeout', async () => {
    const waiting = waitForTaskAnswerAck('q-1', 10);
    await expect(waiting).resolves.toEqual({ ok: false, error: expect.stringMatching(/did not confirm/) });
  });

  it('the popup reports an answer only once the daemon confirms it', () => {
    expect(popupJs).toContain('Answer confirmed by daemon');
    expect(popupJs).not.toContain("addLog('Answer sent'");
  });
});
