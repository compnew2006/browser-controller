import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ExtensionBridge } from '../../mcp-server/src/bridge.js';
import { authenticatedHelloAck, sendAuthInit, testBridgeCredentials } from '../helpers/bridge-auth.js';
import { freePort } from '../helpers/free-port.js';
import { loadTask, saveTask } from '../../mcp-server/src/tasks/store.js';
import { saveTaskWithReport } from '../../mcp-server/src/tasks/reporting.js';
import { answerQuestion, askQuestion, pendingQuestions } from '../../mcp-server/src/tasks/questions.js';
import { routeTaskQuestion } from '../../mcp-server/src/tasks/task-question-route.js';
import { routeTaskLockRelease } from '../../mcp-server/src/tasks/task-lock-release-route.js';
import { pushTaskStatus } from '../../mcp-server/src/tasks/task-status.js';
import {
  configureTaskRunner,
  createTaskAnswerContinuation,
} from '../../mcp-server/src/tasks/wiring.js';
import { TASK_LOCK_RELEASE_WIRE_ACTION } from '../../mcp-server/src/protocol/wire-tools.js';
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

function taskWithSteps(id = 'task-1', state: Task['state'] = 'running'): Task {
  return {
    id,
    goal: 'Open the dashboard and confirm it loaded',
    constraints: ['read-only'],
    steps: [
      { tool: 'fake-ok', params: {}, verify: [{ kind: 'no-error-text', value: "isn't working" }] },
      { tool: 'fake-next', params: {}, verify: [{ kind: 'no-error-text', value: "isn't working" }] },
    ],
    state,
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

describe('taskStatus over the bridge (daemon → popup task list + evidence)', () => {
  /** Whether a frame is a taskStatus push whose tasks include `taskId` in `state`. */
  function statusHas(frame: Record<string, unknown>, taskId: string, state: string): boolean {
    if (frame.type !== 'taskStatus' || !Array.isArray(frame.tasks)) return false;
    return (frame.tasks as Array<Record<string, unknown>>).some((t) => t.id === taskId && t.state === state);
  }

  it('pushes taskStatus on (re)connect, most-recent-first, with steps and the settled report', async () => {
    const older = taskWithSteps('task-old');
    await saveTask(older, dir);
    const newer = taskWithSteps('task-new', 'done');
    await saveTaskWithReport(newer, dir);
    // The done task is the most recent write, so it leads the list.
    const { bridge, port } = await createBridge(true);
    // Production wires the push into the pending-questions provider
    // (daemon-bridge.ts); the test does the same with its own tasks dir.
    bridge.setPendingTaskQuestionsProvider(() => {
      void pushTaskStatus(bridge, dir);
      return pendingQuestions();
    });
    const { frames } = await connectClient(port);

    const frame = await waitForFrame(frames, (f) => f.type === 'taskStatus');
    const tasks = frame.tasks as Array<Record<string, unknown>>;
    expect(tasks.map((t) => t.id)).toEqual(['task-new', 'task-old']);
    const settled = tasks[0];
    expect(settled?.state).toBe('done');
    expect(settled?.goal).toBe('Open the dashboard and confirm it loaded');
    expect(settled?.steps).toEqual([
      { step: 1, tool: 'fake-ok', status: 'not-run' },
      { step: 2, tool: 'fake-next', status: 'not-run' },
    ]);
    expect(typeof (settled?.report as Record<string, unknown>)?.text).toBe('string');
    expect(tasks[1]).not.toHaveProperty('report');
  });

  it('pushes taskStatus on pause, and a task that settles after the push is reflected in the next push', async () => {
    await saveTask(taskWithSteps('task-pause'), dir);
    const question = await askQuestion('task-pause', 'Which report should I open?', ['Sales', 'Stock'], { tasksDir: dir });
    const { bridge, port } = await createBridge(true);
    const { frames } = await connectClient(port);

    routeTaskQuestion(bridge, { question }, dir);
    const paused = await waitForFrame(frames, (f) => statusHas(f, 'task-pause', 'paused-question'));
    expect((paused.tasks as Array<Record<string, unknown>>).find((t) => t.id === 'task-pause')).toMatchObject({
      id: 'task-pause',
      state: 'paused-question',
      steps: [
        { step: 1, tool: 'fake-ok', status: 'not-run' },
        { step: 2, tool: 'fake-next', status: 'not-run' },
      ],
    });

    // The task settles after the pause push: the next push (here, the
    // run-end the daemon observes as the lock release) carries done + report.
    const stored = await loadTask('task-pause', dir);
    stored!.state = 'done';
    await saveTaskWithReport(stored!, dir);
    routeTaskLockRelease(bridge, 'session-1', { taskId: 'task-pause' }, dir);
    const settled = await waitForFrame(frames, (f) => statusHas(f, 'task-pause', 'done'));
    const entry = (settled.tasks as Array<Record<string, unknown>>).find((t) => t.id === 'task-pause');
    expect(entry?.state).toBe('done');
    expect(typeof (entry?.report as Record<string, unknown>)?.text).toBe('string');
  });

  it('pushes taskStatus on resume and again on settle, resume first', async () => {
    await saveTask(taskWithSteps('task-resume'), dir);
    const question = await askQuestion('task-resume', 'Which report should I open?', ['Sales', 'Stock'], { tasksDir: dir });
    const { bridge, port } = await createBridge(true);
    // The daemon-side answer continuation drives the resumed run; the
    // runner is faked (no browser) and the lock release resolves at once.
    configureTaskRunner(async (id, options) => {
      const task = await loadTask(id, options.tasksDir);
      if (!task) throw new Error(`task not found: ${id}`);
      task.state = 'done';
      return task;
    });
    try {
      const fakeBridge = {
        callTool: async (tool: string) => {
          if (tool === TASK_LOCK_RELEASE_WIRE_ACTION) return { released: true };
          throw new Error(`unexpected tool in test: ${tool}`);
        },
        sendControl: (type: string, payload: Record<string, unknown> = {}) => {
          bridge.sendControl(type, payload);
        },
      };
      bridge.setTaskAnswerHandler(createTaskAnswerContinuation(fakeBridge, dir));
      const { client, frames } = await connectClient(port);

      client.send(JSON.stringify({ type: 'taskAnswer', questionId: question.id, answer: 'Sales' }));
      const ack = await waitForFrame(frames, (f) => f.type === 'taskAnswerAck' && f.questionId === question.id);
      expect(ack.ok).toBe(true);

      const resumed = await waitForFrame(frames, (f) => statusHas(f, 'task-resume', 'running'));
      const settled = await waitForFrame(frames, (f) => statusHas(f, 'task-resume', 'done'));
      expect(frames.indexOf(resumed)).toBeLessThan(frames.indexOf(settled));
      const entry = (settled.tasks as Array<Record<string, unknown>>).find((t) => t.id === 'task-resume');
      expect(entry?.state).toBe('done');
      expect(typeof (entry?.report as Record<string, unknown>)?.text).toBe('string');
      expect((await loadTask('task-resume', dir))?.state).toBe('done');
    } finally {
      configureTaskRunner();
    }
  });
});
