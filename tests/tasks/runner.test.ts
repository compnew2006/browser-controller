import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { saveTask } from '../../mcp-server/src/tasks/store.js';
import { planTask } from '../../mcp-server/src/tasks/planner.js';
import { runTask } from '../../mcp-server/src/tasks/runner.js';
import type { Task } from '../../mcp-server/src/tasks/types.js';
import type { ToolDefinition, ToolResult } from '../../mcp-server/src/tools/types.js';
import { failureResult, textResult } from '../../mcp-server/src/tools/types.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-tasks-runner-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A fake tool that records its calls and answers with a fixed result. */
function fakeTool(
  name: string,
  calls: string[],
  result: ToolResult | Error,
  idempotent = true,
): ToolDefinition {
  return {
    name,
    summary: `Fake ${name} for runner tests`,
    description: `Test-only stand-in for ${name}.`,
    inputSchema: z.object({}).strict(),
    ...(idempotent ? { idempotent: true as const } : {}),
    handler: async () => {
      calls.push(name);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

function twoStepTask(id = 'task-1'): Task {
  return {
    id,
    goal: 'Open the example page and confirm it loaded',
    constraints: ['read-only'],
    steps: [
      { tool: 'fake-ok', params: {}, verify: [{ kind: 'no-error-text', value: "isn't working" }] },
      { tool: 'fake-next', params: {}, verify: [{ kind: 'no-error-text', value: "isn't working" }] },
    ],
    state: 'planned',
    evidence: [],
  };
}

describe('planner', () => {
  it('splits a goal with a URL into navigate and snapshot steps', () => {
    const task = planTask('Open https://example.com and confirm it loaded', ['read-only']);
    expect(task.state).toBe('planned');
    expect(task.goal).toBe('Open https://example.com and confirm it loaded');
    expect(task.constraints).toEqual(['read-only']);
    expect(task.evidence).toEqual([]);
    expect(task.steps[0]?.tool).toBe('browser_navigate');
    expect(task.steps[0]?.params).toEqual({ url: 'https://example.com' });
    expect(task.steps[1]?.tool).toBe('browser_snapshot');
    // Every step carries at least one verify rule.
    for (const step of task.steps) expect(step.verify.length).toBeGreaterThanOrEqual(1);
    expect(task.steps[0]?.verify).toContainEqual({ kind: 'url-contains', value: 'example.com' });
  });

  it('plans a snapshot step when the goal names no URL', () => {
    const task = planTask('Check what the current page shows', []);
    expect(task.steps.map((step) => step.tool)).toEqual(['browser_snapshot']);
    for (const step of task.steps) expect(step.verify.length).toBeGreaterThanOrEqual(1);
  });

  it('strips sentence punctuation after a URL in the goal', () => {
    const task = planTask('Open https://example.com.', []);
    expect(task.steps[0]?.params).toEqual({ url: 'https://example.com' });
    expect(task.steps[0]?.verify).toContainEqual({ kind: 'url-contains', value: 'example.com' });
  });

  it('rejects an empty goal', () => {
    expect(() => planTask('   ', [])).toThrowError(/goal/);
  });
});

describe('runner', () => {
  it('test_runner_stops_at_failed_verification', async () => {
    const calls: string[] = [];
    const tools = new Map<string, ToolDefinition>([
      ['fake-ok', fakeTool('fake-ok', calls, textResult('page loaded'))],
      ['fake-next', fakeTool('fake-next', calls, textResult('next page'))],
    ]);
    await saveTask(twoStepTask(), dir);

    const done = await runTask('task-1', {
      tasksDir: dir,
      tools,
      verify: () => ({ ok: false, evidence: 'page shows an error' }),
    });

    expect(done.state).toBe('failed');
    expect(done.steps[0]?.result?.status).toBe('verify-failed');
    expect(done.steps[1]?.result).toBeUndefined();
    expect(calls).toEqual(['fake-ok']);
    expect(done.evidence.join('\n')).toContain('page shows an error');
  });

  it('runs every step in order and finishes done when all verify', async () => {
    const calls: string[] = [];
    const tools = new Map<string, ToolDefinition>([
      ['fake-ok', fakeTool('fake-ok', calls, textResult('page loaded'))],
      ['fake-next', fakeTool('fake-next', calls, textResult('next page'))],
    ]);
    await saveTask(twoStepTask(), dir);

    const done = await runTask('task-1', {
      tasksDir: dir,
      tools,
      verify: () => ({ ok: true, evidence: 'checked' }),
    });

    expect(done.state).toBe('done');
    expect(calls).toEqual(['fake-ok', 'fake-next']);
    expect(done.steps.map((step) => step.result?.status)).toEqual(['ok', 'ok']);
    expect(done.evidence.length).toBe(2);
  });

  it('stops at a tool that returns an error result', async () => {
    const calls: string[] = [];
    const tools = new Map<string, ToolDefinition>([
      ['fake-ok', fakeTool('fake-ok', calls, failureResult('NAVIGATION_FAILED: no network'))],
      ['fake-next', fakeTool('fake-next', calls, textResult('next page'))],
    ]);
    await saveTask(twoStepTask(), dir);

    const done = await runTask('task-1', {
      tasksDir: dir,
      tools,
      verify: () => ({ ok: true, evidence: 'checked' }),
    });

    expect(done.state).toBe('failed');
    expect(done.steps[0]?.result?.status).toBe('failed');
    expect(done.steps[0]?.result?.detail).toContain('NAVIGATION_FAILED');
    expect(calls).toEqual(['fake-ok']);
  });

  it('stops at a tool that throws', async () => {
    const calls: string[] = [];
    const tools = new Map<string, ToolDefinition>([
      ['fake-ok', fakeTool('fake-ok', calls, new Error('TIMEOUT: tab did not respond'))],
      ['fake-next', fakeTool('fake-next', calls, textResult('next page'))],
    ]);
    await saveTask(twoStepTask(), dir);

    const done = await runTask('task-1', { tasksDir: dir, tools });
    expect(done.state).toBe('failed');
    expect(done.steps[0]?.result?.status).toBe('failed');
    expect(done.steps[0]?.result?.detail).toContain('TIMEOUT');
    expect(calls).toEqual(['fake-ok']);
  });

  it('refuses a mutating step without explicit approval and never runs it', async () => {
    const calls: string[] = [];
    const tools = new Map<string, ToolDefinition>([
      ['fake-click', fakeTool('fake-click', calls, textResult('clicked'), false)],
    ]);
    await saveTask(
      {
        id: 'task-1',
        goal: 'Click the submit button',
        constraints: ['read-only'],
        steps: [{ tool: 'fake-click', params: {}, verify: [{ kind: 'no-error-text', value: "isn't working" }] }],
        state: 'planned',
        evidence: [],
      },
      dir,
    );

    const done = await runTask('task-1', { tasksDir: dir, tools });
    expect(done.state).toBe('failed');
    expect(calls).toEqual([]);
    expect(done.steps[0]?.result?.status).toBe('failed');
    expect(done.steps[0]?.result?.detail).toMatch(/refused.*approval/i);
    expect(done.evidence.join('\n')).toMatch(/refused.*approval/i);
  });

  it('runs a mutating step when the task explicitly allows mutations', async () => {
    const calls: string[] = [];
    const tools = new Map<string, ToolDefinition>([
      ['fake-click', fakeTool('fake-click', calls, textResult('clicked'), false)],
    ]);
    await saveTask(
      {
        id: 'task-1',
        goal: 'Click the submit button',
        constraints: ['allow-mutations'],
        steps: [{ tool: 'fake-click', params: {}, verify: [{ kind: 'no-error-text', value: "isn't working" }] }],
        state: 'planned',
        evidence: [],
      },
      dir,
    );

    const done = await runTask('task-1', {
      tasksDir: dir,
      tools,
      verify: () => ({ ok: true, evidence: 'checked' }),
    });
    expect(done.state).toBe('done');
    expect(calls).toEqual(['fake-click']);
  });

  it('fails a step whose tool is not registered and runs nothing after it', async () => {
    const calls: string[] = [];
    const tools = new Map<string, ToolDefinition>([
      ['fake-next', fakeTool('fake-next', calls, textResult('next page'))],
    ]);
    await saveTask(
      {
        ...twoStepTask(),
        steps: [
          { tool: 'no-such-tool', params: {}, verify: [{ kind: 'no-error-text', value: "isn't working" }] },
          { tool: 'fake-next', params: {}, verify: [{ kind: 'no-error-text', value: "isn't working" }] },
        ],
      },
      dir,
    );

    const done = await runTask('task-1', { tasksDir: dir, tools });
    expect(done.state).toBe('failed');
    expect(done.steps[0]?.result?.status).toBe('failed');
    expect(done.steps[0]?.result?.detail).toContain('unknown tool');
    expect(calls).toEqual([]);
  });

  it('resumes from the first unfinished step and keeps completed work', async () => {
    const calls: string[] = [];
    const tools = new Map<string, ToolDefinition>([
      ['fake-ok', fakeTool('fake-ok', calls, textResult('page loaded'))],
      ['fake-next', fakeTool('fake-next', calls, textResult('next page'))],
    ]);
    const task = twoStepTask();
    task.steps[0]!.result = { status: 'ok', detail: 'already done' };
    task.state = 'paused-login';
    await saveTask(task, dir);

    const done = await runTask('task-1', {
      tasksDir: dir,
      tools,
      verify: () => ({ ok: true, evidence: 'checked' }),
    });
    expect(done.state).toBe('done');
    expect(calls).toEqual(['fake-next']);
    expect(done.steps[0]?.result).toEqual({ status: 'ok', detail: 'already done' });
  });

  it('rejects a task that was never saved', async () => {
    await expect(runTask('missing', { tasksDir: dir })).rejects.toThrowError(/not found/);
  });
});
