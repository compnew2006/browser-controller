import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ExtensionBridge } from '../../mcp-server/src/bridge.js';
import { authenticatedHelloAck, sendAuthInit, testBridgeCredentials } from '../helpers/bridge-auth.js';
import { freePort } from '../helpers/free-port.js';
import { loadTask, saveTask } from '../../mcp-server/src/tasks/store.js';
import { answerQuestion, askQuestion, pendingQuestions } from '../../mcp-server/src/tasks/questions.js';
import type { Task } from '../../mcp-server/src/tasks/types.js';

let dir: string;
const bridges: ExtensionBridge[] = [];
const clients: WebSocket[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-task-answer-bridge-'));
});
afterEach(async () => {
  clients.forEach((c) => { try { c.close(); } catch { /* already closed */ } });
  clients.length = 0;
  bridges.forEach((b) => b.stop());
  bridges.length = 0;
  fs.rmSync(dir, { recursive: true, force: true });
  await new Promise((r) => setTimeout(r, 50));
});

function taskWithSteps(id = 'task-1'): Task {
  return {
    id,
    goal: 'Open the dashboard and confirm it loaded',
    constraints: ['read-only'],
    steps: [
      { tool: 'fake-ok', params: {}, verify: [{ kind: 'no-error-text', value: "isn't working" }] },
      { tool: 'fake-next', params: {}, verify: [{ kind: 'no-error-text', value: "isn't working" }] },
    ],
    state: 'running',
    evidence: [],
  };
}

async function createBridge(withHandler: boolean): Promise<{ bridge: ExtensionBridge; port: number }> {
  const port = await freePort();
  const bridge = new ExtensionBridge({
    port,
    pingIntervalMs: 60_000,
    ...testBridgeCredentials(),
  });
  if (withHandler) {
    bridge.setTaskAnswerHandler((questionId, answer) => answerQuestion(questionId, answer, { tasksDir: dir }));
    bridge.setPendingTaskQuestionsProvider(() => pendingQuestions());
  }
  bridges.push(bridge);
  await bridge.start();
  return { bridge, port };
}

/** Connect a fake extension: answer the daemon hello, collect every frame the bridge sends. */
async function connectClient(port: number): Promise<{ client: WebSocket; frames: Array<Record<string, unknown>> }> {
  const frames: Array<Record<string, unknown>> = [];
  const client = new WebSocket(`ws://localhost:${port}`);
  clients.push(client);
  client.on('message', (data) => {
    const msg = JSON.parse(data.toString()) as Record<string, unknown>;
    frames.push(msg);
    if (msg.type === 'hello') client.send(authenticatedHelloAck(msg));
  });
  await new Promise<void>((resolve, reject) => {
    client.on('open', resolve);
    client.on('error', reject);
  });
  sendAuthInit(client);
  await new Promise((r) => setTimeout(r, 50));
  return { client, frames };
}

async function waitForFrame(
  frames: Array<Record<string, unknown>>,
  pred: (frame: Record<string, unknown>) => boolean,
  timeoutMs = 5000,
): Promise<Record<string, unknown>> {
  const start = Date.now();
  for (;;) {
    const found = frames.find(pred);
    if (found) return found;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for frame; got ${JSON.stringify(frames)}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('taskAnswer over the bridge (popup → bridge → answerQuestion)', () => {
  it('routes a popup answer to answerQuestion, returns the task to running, and acks ok', async () => {
    await saveTask(taskWithSteps(), dir);
    const question = await askQuestion('task-1', 'Which report should I open?', ['Sales', 'Stock'], { tasksDir: dir });
    const { port } = await createBridge(true);
    const { client, frames } = await connectClient(port);

    client.send(JSON.stringify({ type: 'taskAnswer', questionId: question.id, answer: 'Sales' }));
    const ack = await waitForFrame(frames, (f) => f.type === 'taskAnswerAck' && f.questionId === question.id);
    expect(ack).toEqual({ type: 'taskAnswerAck', questionId: question.id, ok: true });

    const task = await loadTask('task-1', dir);
    expect(task?.state).toBe('running');
    expect(task?.evidence.join('\n')).toContain('Sales');
    expect(fs.existsSync(path.join(dir, 'questions', `${question.id}.json`))).toBe(false);
  });

  it('acks ok:false for an unknown question and leaves the task paused', async () => {
    await saveTask(taskWithSteps(), dir);
    const question = await askQuestion('task-1', 'Which report should I open?', ['Sales', 'Stock'], { tasksDir: dir });
    const { port } = await createBridge(true);
    const { client, frames } = await connectClient(port);

    client.send(JSON.stringify({ type: 'taskAnswer', questionId: '00000000-0000-4000-8000-000000000000', answer: 'Sales' }));
    const ack = await waitForFrame(frames, (f) => f.type === 'taskAnswerAck');
    expect(ack.ok).toBe(false);
    expect(ack.error).toMatch(/question not found/);
    expect((await loadTask('task-1', dir))?.state).toBe('paused-question');
    expect(pendingQuestions().map((q) => q.id)).toContain(question.id);
  });

  it('acks ok:false for a malformed answer and keeps the question pending', async () => {
    await saveTask(taskWithSteps(), dir);
    const question = await askQuestion('task-1', 'Which report should I open?', ['Sales', 'Stock'], { tasksDir: dir });
    const { port } = await createBridge(true);
    const { client, frames } = await connectClient(port);

    client.send(JSON.stringify({ type: 'taskAnswer', questionId: question.id, answer: '' }));
    const ack = await waitForFrame(frames, (f) => f.type === 'taskAnswerAck');
    expect(ack.ok).toBe(false);
    expect(pendingQuestions().map((q) => q.id)).toContain(question.id);
    expect((await loadTask('task-1', dir))?.state).toBe('paused-question');
  });

  it('acks ok:false when no answer handler is set, instead of hanging the popup', async () => {
    await saveTask(taskWithSteps(), dir);
    const question = await askQuestion('task-1', 'Which report should I open?', ['Sales', 'Stock'], { tasksDir: dir });
    const { port } = await createBridge(false);
    const { client, frames } = await connectClient(port);

    client.send(JSON.stringify({ type: 'taskAnswer', questionId: question.id, answer: 'Sales' }));
    const ack = await waitForFrame(frames, (f) => f.type === 'taskAnswerAck');
    expect(ack.ok).toBe(false);
    expect(ack.error).toMatch(/no task answer handler/);
    expect((await loadTask('task-1', dir))?.state).toBe('paused-question');
  });

  it('re-asks the pending questions to an extension that (re)connects', async () => {
    await saveTask(taskWithSteps(), dir);
    const question = await askQuestion('task-1', 'Which report should I open?', ['Sales', 'Stock'], { tasksDir: dir });
    const { port } = await createBridge(true);
    const { frames } = await connectClient(port);

    // Earlier tests in this file leave their (unanswered) questions pending
    // in the module registry, so the bridge re-asks those too: match this
    // test's question by id.
    const reasked = await waitForFrame(
      frames,
      (f) => f.type === 'taskQuestion' && (f.question as Record<string, unknown>)?.id === question.id,
    );
    expect(reasked.question).toEqual(expect.objectContaining({ id: question.id, text: 'Which report should I open?' }));
  });
});
