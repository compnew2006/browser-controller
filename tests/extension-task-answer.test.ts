import { vi, describe, it, expect, beforeEach } from 'vitest';

/**
 * The popup answer path, end to end inside the extension (Design §5):
 * popup `answerTaskQuestion` → background `events.js` → `sendJson`
 * `taskAnswer` frame → daemon ack `taskAnswerAck` → router resolves the
 * waiter → popup told success. Covers the take-before-send race (the
 * socket dropping between the connected-check and the send must keep the
 * question pending) and the refusal path (a nack re-records the question
 * so the card comes back).
 */

const sent = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const connState = vi.hoisted(() => ({ connected: true, sendOk: true }));
const listeners = vi.hoisted(() => ({
  message: [] as Array<(...args: unknown[]) => unknown>,
  updated: [] as Array<(...args: unknown[]) => unknown>,
  committed: [] as Array<(...args: unknown[]) => unknown>,
  replaced: [] as Array<(...args: unknown[]) => unknown>,
}));

vi.mock('../extension/lib/connection.js', () => ({
  sendJson: (obj: Record<string, unknown>) => { if (connState.sendOk) sent.push(obj); return connState.sendOk; },
  updateBadge: () => {},
  broadcastStatus: async () => {},
  isWsConnected: () => connState.connected,
  setCurrentActivity: () => {},
  getOpenTabs: async () => [],
  buildStatusPayload: () => ({}),
  applyPort: () => ({}),
  applyToken: () => ({}),
  applyBrowserLabel: async () => ({ success: true }),
  applyEnrollment: async () => {},
}));

const tabStore = new Map<number, { id: number; windowId: number; url: string; title: string; active: boolean }>();
(globalThis as unknown as { chrome: unknown }).chrome = {
  tabs: {
    get: async (id: number) => {
      const t = tabStore.get(id);
      if (!t) throw new Error(`No tab ${id}`);
      return t;
    },
    query: async () => [...tabStore.values()],
    update: async () => ({}),
    remove: async () => ({}),
    create: async () => ({}),
    captureVisibleTab: async () => 'data:image/png;base64,QUJD',
    onRemoved: { addListener: () => {} },
    onReplaced: { addListener: (fn: (...args: unknown[]) => unknown) => { listeners.replaced.push(fn); } },
    onUpdated: { addListener: (fn: (...args: unknown[]) => unknown) => { listeners.updated.push(fn); } },
    onActivated: { addListener: () => {} },
  },
  webNavigation: {
    onCreatedNavigationTarget: { addListener: () => {} },
    onCommitted: { addListener: (fn: (...args: unknown[]) => unknown) => { listeners.committed.push(fn); } },
  },
  scripting: {
    executeScript: async () => [{ result: null }],
  },
  action: { setBadgeBackgroundColor: () => {}, setBadgeText: () => {} },
  storage: {
    session: { get: async () => ({}), set: async () => {} },
    local: { get: async () => ({}), set: async () => {} },
  },
  runtime: {
    id: 'extension-id',
    getURL: (path: string) => `chrome-extension://extension-id/${path}`,
    sendMessage: async () => {},
    onMessage: { addListener: (fn: (...args: unknown[]) => unknown) => { listeners.message.push(fn); } },
  },
  alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
  webRequest: {
    onBeforeRequest: { addListener: () => {} },
    onSendHeaders: { addListener: () => {} },
    onCompleted: { addListener: () => {} },
    onErrorOccurred: { addListener: () => {} },
  },
  debugger: { attach: async () => {}, detach: async () => {}, sendCommand: async () => ({}) },
};

const { handleMessage } = await import('../extension/dispatch/router.js');
const { registerEventListeners } = await import('../extension/events.js');
const { clearTaskQuestions, pendingTaskQuestions, recordTaskQuestion } = await import('../extension/lib/task-questions.js');

registerEventListeners();
const onMessage = listeners.message[0] as (msg: Record<string, unknown>, sender: unknown, respond: (r: unknown) => void) => unknown;

const flush = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const popupSender = { id: 'extension-id', url: 'chrome-extension://extension-id/popup/popup.html' };
const pageSender = { id: 'extension-id', url: 'https://example.com/page' };

function answerViaPopup(questionId: string, answer: string, sender: unknown = popupSender) {
  const responses: unknown[] = [];
  const returned = onMessage({ type: 'answerTaskQuestion', questionId, answer }, sender, (r) => { responses.push(r); });
  return { responses, returned };
}

const choiceQuestion = { id: 'q-1', taskId: 'task-1', text: 'Which report should I open?', options: ['Sales', 'Stock'], kind: 'choice' };

describe('popup answer path (answerTaskQuestion → taskAnswer → taskAnswerAck)', () => {
  beforeEach(() => {
    connState.connected = true;
    connState.sendOk = true;
    sent.length = 0;
    clearTaskQuestions();
    recordTaskQuestion(choiceQuestion);
  });

  it('takes the question only after a successful send, and reports success only once the daemon acks', async () => {
    const { responses, returned } = answerViaPopup('q-1', 'Sales');
    expect(returned).toBe(true); // async response — the ack is still to come
    expect(sent).toEqual([{ type: 'taskAnswer', questionId: 'q-1', answer: 'Sales' }]);
    expect(pendingTaskQuestions()).toEqual([]); // taken once the frame left
    expect(responses).toEqual([]); // not success yet: no ack

    await handleMessage({ type: 'taskAnswerAck', questionId: 'q-1', ok: true });
    await flush();
    expect(responses).toEqual([{ success: true }]);
  });

  it('keeps the question pending when the socket drops between the connected-check and the send', async () => {
    connState.connected = true; // the check passes…
    connState.sendOk = false; // …but the send does not: the socket dropped in between
    const { responses, returned } = answerViaPopup('q-1', 'Sales');
    expect(returned).toBe(false);
    expect(sent).toEqual([]); // nothing left the socket
    expect(responses).toEqual([{ success: false, error: expect.stringMatching(/not connected/) }]);
    expect(pendingTaskQuestions()).toEqual([choiceQuestion]); // the card stays for retry
  });

  it('re-records the question when the daemon refuses the answer, so the card comes back', async () => {
    const { responses } = answerViaPopup('q-1', 'Sales');
    expect(pendingTaskQuestions()).toEqual([]);
    await handleMessage({ type: 'taskAnswerAck', questionId: 'q-1', ok: false, error: 'question not found: q-1' });
    await flush();
    expect(responses).toEqual([{ success: false, error: 'question not found: q-1' }]);
    expect(pendingTaskQuestions()).toEqual([choiceQuestion]);
  });

  it('refuses while disconnected and keeps the question pending', async () => {
    connState.connected = false;
    const { responses, returned } = answerViaPopup('q-1', 'Sales');
    expect(returned).toBe(false);
    expect(sent).toEqual([]);
    expect(responses).toEqual([{ success: false, error: expect.stringMatching(/not connected/) }]);
    expect(pendingTaskQuestions()).toEqual([choiceQuestion]);
  });

  it('a page content script cannot answer for the user', async () => {
    const { responses, returned } = answerViaPopup('q-1', 'Sales', pageSender);
    expect(returned).toBe(false);
    expect(sent).toEqual([]);
    expect(responses).toEqual([]);
    expect(pendingTaskQuestions()).toEqual([choiceQuestion]);
  });

  it('ignores an ack for a question nobody is waiting on', async () => {
    expect(await handleMessage({ type: 'taskAnswerAck', questionId: 'q-99', ok: true })).toBeUndefined();
    expect(pendingTaskQuestions()).toEqual([choiceQuestion]);
  });
});
