import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadTask, saveTask } from '../../mcp-server/src/tasks/store.js';
import { planTask } from '../../mcp-server/src/tasks/planner.js';
import { askQuestion } from '../../mcp-server/src/tasks/questions.js';
import { listPendingQuestions } from '../../mcp-server/src/tasks/question-store.js';
import { runTaskWithReport, taskRunOptions, isTaskRunning, configureTaskRunner, createTaskAnswerContinuation } from '../../mcp-server/src/tasks/wiring.js';
import { routeTaskQuestion } from '../../mcp-server/src/tasks/task-question-route.js';
import { taskStartTool, taskStatusTool, taskCancelTool, taskAnswerTool } from '../../mcp-server/src/tasks/tools.js';
import { toolMap } from '../../mcp-server/src/tools/registry.js';
import { TASK_QUESTION_WIRE_ACTION } from '../../mcp-server/src/protocol/wire-tools.js';
import type { Task } from '../../mcp-server/src/tasks/types.js';
import type { ToolHost, ToolResult } from '../../mcp-server/src/tools/types.js';

let dir: string;
let stateDir: string;
let previousStateDir: string | undefined;

beforeEach(() => {
  // The tools resolve their directory through defaultTasksDir(), which is
  // `<BC_STATE_DIR>/tasks` — the explicit dir the tests pass around must be
  // that same subdirectory, or the tools and the tests read different files.
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-task-tools-'));
  previousStateDir = process.env.BC_STATE_DIR;
  process.env.BC_STATE_DIR = stateDir;
  dir = path.join(stateDir, 'tasks');
});

afterEach(() => {
  configureTaskRunner();
  if (previousStateDir === undefined) delete process.env.BC_STATE_DIR;
  else process.env.BC_STATE_DIR = previousStateDir;
  fs.rmSync(stateDir, { recursive: true, force: true });
});

/** A fake browser host: answers the tools the planner emits, and records every call. */
function makeFakeHost(): ToolHost & { calls: Array<{ tool: string; params: Record<string, unknown> }>; sessionId: string } {
  const calls: Array<{ tool: string; params: Record<string, unknown> }> = [];
  return {
    calls,
    sessionId: 'test-session-1',
    async callTool(tool: string, params: Record<string, unknown>) {
      calls.push({ tool, params });
      if (tool === 'browser_navigate') return { success: true, tabId: 42, text: 'loaded', url: 'https://example.com' };
      if (tool === 'browser_evaluate') return { success: true, text: 'stable' };
      if (tool === 'browser_snapshot') {
        return { success: true, tabId: typeof params.tabId === 'number' ? params.tabId : 42, text: 'page text', url: 'https://example.com' };
      }
      if (tool === 'browser_tabs') {
        return { success: true, text: '7 [own] Example https://example.com', tabs: [{ tabId: 7, role: 'own' }], openTabCount: 1 };
      }
      if (tool === 'browser_click') return { success: true, text: 'clicked' };
      if (tool === TASK_QUESTION_WIRE_ACTION) return { success: true, sent: true };
      throw new Error(`unexpected tool call: ${tool}`);
    },
  };
}

function textOf(result: ToolResult): string {
  const first = result.content.find((item) => item.type === 'text');
  if (!first || first.type !== 'text') throw new Error('tool result has no text');
  return first.text;
}

function jsonOf(result: ToolResult): Record<string, unknown> {
  return JSON.parse(textOf(result)) as Record<string, unknown>;
}

/** Poll the saved task until `check` holds, or fail after `timeoutMs`. */
async function waitForTask(id: string, check: (task: Task) => boolean, timeoutMs = 10_000): Promise<Task> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const task = await loadTask(id, dir);
    if (task && check(task)) return task;
    if (Date.now() > deadline) throw new Error(`task ${id} did not reach the expected state in ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('browser_task tools', () => {
  it('test_task_start_returns_task_id', { timeout: 30_000 }, async () => {
    const host = makeFakeHost();
    const result = await taskStartTool.handler(host, {
      goal: 'Open https://example.com and confirm it loaded',
      constraints: ['read-only'],
    });
    expect(result.isError).toBeUndefined();
    const payload = jsonOf(result);
    expect(typeof payload.taskId).toBe('string');
    expect(payload.state).toBe('planned');
    expect(payload.steps).toBe(2);
    // The background run finishes the planned steps through the fake host.
    const done = await waitForTask(String(payload.taskId), (task) => task.state === 'done' && task.report?.json.state === 'done');
    expect(done.sessionId).toBe('test-session-1');
    expect(done.report).toBeDefined();
    expect(done.report?.text).toContain('ما تم فحصه');
    expect(done.report?.json.checked).toHaveLength(2);
    expect(done.report?.json.state).toBe('done');
    expect(host.calls.some((call) => call.tool === 'browser_navigate')).toBe(true);
    expect(host.calls.some((call) => call.tool === 'browser_snapshot')).toBe(true);
  });

  it('start refuses an empty goal', async () => {
    const host = makeFakeHost();
    await expect(taskStartTool.handler(host, { goal: '   ' })).rejects.toThrowError(/INVALID_ARGUMENT/);
  });

  it('status returns the task with its report; unknown tasks fail', { timeout: 30_000 }, async () => {
    const host = makeFakeHost();
    const started = jsonOf(await taskStartTool.handler(host, { goal: 'Open https://example.com and confirm it loaded' }));
    const done = await waitForTask(String(started.taskId), (task) => task.state === 'done' && task.report?.json.state === 'done');
    const status = jsonOf(await taskStatusTool.handler(host, { taskId: done.id }));
    expect(status.state).toBe('done');
    expect(status.report).toBeDefined();
    expect((status.steps as Array<{ status: string }>).map((step) => step.status)).toEqual(['ok', 'ok']);
    await expect(taskStatusTool.handler(host, { taskId: 'missing' })).rejects.toThrowError(/task not found: missing/);
  });

  it('cancel fails a planned task, persists its report, and drops its pending questions', async () => {
    const host = makeFakeHost();
    const task = planTask('Open https://example.com and confirm it loaded');
    await saveTask(task, dir);
    const question = await askQuestion(task.id, 'Proceed?', ['yes', 'no'], { kind: 'confirm', tasksDir: dir });
    expect((await listPendingQuestions(dir)).map((entry) => entry.id)).toContain(question.id);
    const cancelled = jsonOf(await taskCancelTool.handler(host, { taskId: task.id }));
    expect(cancelled.state).toBe('failed');
    const stored = await loadTask(task.id, dir);
    expect(stored?.evidence.some((line) => line.startsWith('cancelled by the user'))).toBe(true);
    expect(stored?.report?.json.state).toBe('failed');
    expect(await listPendingQuestions(dir)).toEqual([]);
    await expect(taskCancelTool.handler(host, { taskId: task.id })).rejects.toThrowError(/cannot cancel task .* is failed/);
  });

  it('cancel refuses a task this process is currently running', { timeout: 30_000 }, async () => {
    const host = makeFakeHost();
    let release!: (task: Task) => void;
    const held = new Promise<Task>((resolve) => {
      release = resolve;
    });
    configureTaskRunner(() => held);
    const started = jsonOf(await taskStartTool.handler(host, { goal: 'Open https://example.com and confirm it loaded' }));
    const id = String(started.taskId);
    await waitForTask(id, () => isTaskRunning(id));
    await expect(taskCancelTool.handler(host, { taskId: id })).rejects.toThrowError(/currently running/);
    const planned = await loadTask(id, dir);
    release(planned!);
    await waitForTask(id, () => !isTaskRunning(id));
  });

  it('answer resumes a paused task from the same step', { timeout: 30_000 }, async () => {
    const host = makeFakeHost();
    const task = planTask('Open https://example.com and confirm it loaded');
    await saveTask(task, dir);
    const question = await askQuestion(task.id, 'Proceed?', ['yes', 'no'], { kind: 'confirm', tasksDir: dir });
    const answered = jsonOf(await taskAnswerTool.handler(host, { questionId: question.id, answer: 'yes' }));
    // The answer is recorded and the resume runs in the background, so the
    // tool returns promptly with the task running — it does not block on it.
    expect(answered.state).toBe('running');
    const done = await waitForTask(task.id, (entry) => entry.state === 'done' && entry.report?.json.state === 'done');
    expect(done.evidence.some((line) => line.includes(`answer to question ${question.id}`))).toBe(true);
    expect(done.report?.json.state).toBe('done');
    await expect(taskAnswerTool.handler(host, { questionId: question.id, answer: 'yes' })).rejects.toThrowError(
      /question not found/,
    );
  });

  it('a mutating step asks through the internal wire action, and yes resumes it', { timeout: 30_000 }, async () => {
    const host = makeFakeHost();
    const task: Task = {
      id: 'task-mutating',
      goal: 'Click the button',
      constraints: [],
      steps: [
        { tool: 'browser_navigate', params: { url: 'https://example.com' }, verify: [{ kind: 'url-contains', value: 'example.com' }] },
        { tool: 'browser_click', params: { target: 'e1' }, verify: [{ kind: 'no-error-text', value: "isn't working" }] },
      ],
      state: 'planned',
      evidence: [],
    };
    await saveTask(task, dir);
    const send = async (message: { type: 'taskQuestion'; question: unknown }) => {
      await host.callTool(TASK_QUESTION_WIRE_ACTION, { question: message.question });
    };
    const paused = await runTaskWithReport(task.id, taskRunOptions(host, send, dir));
    expect(paused.state).toBe('paused-question');
    // The question reached the daemon through the wire action, not a direct bridge call.
    const sent = host.calls.find((call) => call.tool === TASK_QUESTION_WIRE_ACTION);
    expect(sent).toBeDefined();
    expect((sent?.params.question as { text: string }).text).toContain('browser_click');
    // The pause path persists a report too.
    expect(paused.report?.json.state).toBe('paused-question');
    expect(paused.report?.json.unconfirmed.length).toBeGreaterThan(0);
    const pending = await listPendingQuestions(dir);
    expect(pending).toHaveLength(1);
    const answered = jsonOf(await taskAnswerTool.handler(host, { questionId: pending[0]!.id, answer: 'yes' }));
    expect(answered.state).toBe('running');
    const done = await waitForTask(task.id, (entry) => entry.state === 'done' && entry.report?.json.state === 'done');
    expect(done.constraints).toContain('allow-mutations:step:1');
    expect(host.calls.some((call) => call.tool === 'browser_click')).toBe(true);
    expect(done.report?.json.state).toBe('done');
  });

  it('the daemon answer continuation resumes with the task session on the bridge host', async () => {
    const bridgeCalls: Array<{ tool: string; params: Record<string, unknown>; sessionId?: string }> = [];
    const controlCalls: Array<{ type: string; payload: Record<string, unknown> }> = [];
    let runnerCalledWith = '';
    let release!: (task: Task) => void;
    const held = new Promise<Task>((resolve) => {
      release = resolve;
    });
    configureTaskRunner((id) => {
      runnerCalledWith = id;
      return held;
    });
    const task = planTask('Open https://example.com and confirm it loaded');
    task.sessionId = 'sess-9';
    await saveTask(task, dir);
    const question = await askQuestion(task.id, 'Proceed?', ['yes', 'no'], { kind: 'confirm', tasksDir: dir });
    const bridge = {
      async callTool(tool: string, params: Record<string, unknown>, sessionId?: string) {
        bridgeCalls.push({ tool, params, sessionId });
        return { success: true };
      },
      sendControl(type: string, payload: Record<string, unknown>) {
        controlCalls.push({ type, payload });
      },
    };
    const handler = createTaskAnswerContinuation(bridge);
    // The handler resolves once the answer is recorded — it must not wait
    // for the resumed run, or the popup ack would hang behind it.
    const answered = await handler(question.id, 'yes');
    expect(answered.state).toBe('running');
    expect(runnerCalledWith).toBe(task.id);
    // The resumed run acts on the bridge as the task's own session, so tabs
    // the session owns stay actable on instead of TAB_LOCKED.
    const resumed = await waitForTask(task.id, () => isTaskRunning(task.id));
    expect(resumed.state).toBe('running');
    release(resumed);
    await waitForTask(task.id, () => !isTaskRunning(task.id));
  });

  it('the daemon question route forwards a valid question and refuses a malformed one', () => {
    const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const bridge = {
      sendControl(type: string, payload: Record<string, unknown>) {
        sent.push({ type, payload });
      },
    };
    const question = { id: '550e8400-e29b-41d4-a716-446655440000', taskId: 'task-1', text: 'Proceed?', options: ['yes', 'no'], kind: 'confirm' as const };
    const ok = routeTaskQuestion(bridge, { question });
    expect(ok).toEqual({ success: true, result: { sent: true, questionId: question.id } });
    expect(sent).toEqual([{ type: 'taskQuestion', payload: { question } }]);
    const bad = routeTaskQuestion(bridge, { question: { id: 'x', taskId: 'task-1', text: '' } });
    expect(bad.success).toBe(false);
    expect(bad.error).toMatch(/INVALID_ARGUMENT/);
    expect(sent).toHaveLength(1);
  });

  it('registers the four tools in the tool registry', () => {
    for (const name of ['browser_task_start', 'browser_task_status', 'browser_task_cancel', 'browser_task_answer']) {
      expect(toolMap.get(name)?.name).toBe(name);
    }
    expect(toolMap.get('browser_task_status')?.idempotent).toBe(true);
    expect(toolMap.get('browser_task_start')?.idempotent).toBe(undefined);
  });
});
