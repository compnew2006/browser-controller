import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import {
  backoffForAttempt,
  errorCodeOf,
  reconcileUnknown,
  RETRY_POLICY,
  shouldRetry,
} from '../../mcp-server/src/tasks/recovery.js';
import { loadTask, saveTask } from '../../mcp-server/src/tasks/store.js';
import { runTask } from '../../mcp-server/src/tasks/runner.js';
import type { VerifyStepFn } from '../../mcp-server/src/tasks/runner.js';
import { resumeAfterLogin } from '../../mcp-server/src/tasks/session.js';
import { answerQuestion, askQuestion } from '../../mcp-server/src/tasks/questions.js';
import { buildEvidenceReport } from '../../mcp-server/src/tasks/evidence.js';
import { verifyStep } from '../../mcp-server/src/tasks/verify.js';
import type { PageSnapshot, VerifyOutcome } from '../../mcp-server/src/tasks/verify.js';
import type { Task } from '../../mcp-server/src/tasks/types.js';
import type { ToolDefinition, ToolHost, ToolResult } from '../../mcp-server/src/tools/types.js';
import { failureResult, outcomeOf, textResult } from '../../mcp-server/src/tools/types.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-tasks-recovery-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A host fake tools ignore; its only job is to let the runner call the snapshot tool. */
const dummyHost: ToolHost = {
  callTool: async () => {
    throw new Error('no extension in test');
  },
};

const tabSchema = z.object({ tabId: z.number().optional() }).strict();

/**
 * A fake tool that plays a script: one result (or throw) per call, holding
 * on the last entry when the runner retries past the end of the script.
 */
function scriptedTool(
  name: string,
  calls: string[],
  script: Array<ToolResult | Error>,
  idempotent = true,
  inputSchema: z.ZodObject<z.ZodRawShape> = z.object({}).strict(),
  onCall?: (params: Record<string, unknown>) => void,
): ToolDefinition {
  let n = 0;
  return {
    name,
    summary: `Fake ${name} for recovery tests`,
    description: `Test-only stand-in for ${name}.`,
    inputSchema,
    ...(idempotent ? { idempotent: true as const } : {}),
    handler: async (_host, params) => {
      calls.push(name);
      onCall?.(params);
      const next = script[Math.min(n, script.length - 1)]!;
      n += 1;
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

/** A fake `browser_snapshot` answering with fixed page text. */
function snapshotTool(calls: string[], text: string): ToolDefinition {
  return scriptedTool('browser_snapshot', calls, [textResult(text)], true, tabSchema);
}

/** A verifier that plays outcomes in order, holding on the last one. */
function verifyInSequence(outcomes: VerifyOutcome[]): VerifyStepFn {
  let n = 0;
  return () => {
    const outcome = outcomes[Math.min(n, outcomes.length - 1)]!;
    n += 1;
    return outcome;
  };
}

/** One read step through `fake-ok`, verified against the snapshot text. */
function oneStepTask(id = 'task-1'): Task {
  return {
    id,
    goal: 'Read the page',
    constraints: ['read-only'],
    steps: [{ tool: 'fake-ok', params: {}, verify: [{ kind: 'no-error-text', value: "isn't working" }] }],
    state: 'planned',
    evidence: [],
  };
}

describe('RetryPolicy', () => {
  it('carries the Design §6 values verbatim', () => {
    expect(RETRY_POLICY.maxAttempts).toBe(3);
    expect([...RETRY_POLICY.backoffMs]).toEqual([500, 1500, 4000]);
    expect([...RETRY_POLICY.retryableCodes]).toEqual(['TIMEOUT', 'TAB_FROZEN', 'NETWORK']);
  });

  it('backs off 500ms, then 1500ms, then 4000ms by attempt', () => {
    expect(backoffForAttempt(1)).toBe(500);
    expect(backoffForAttempt(2)).toBe(1500);
    expect(backoffForAttempt(3)).toBe(4000);
  });
});

describe('shouldRetry', () => {
  it('retries the retryable codes on attempts 1, 2 and 3, never on attempt 4', () => {
    // Fix round 1, Important 1: maxAttempts: 3 counts retries, not
    // attempts in total — 3 retries means 4 attempts, so attempt 3 may
    // still retry and only attempt 4 may not.
    for (const code of ['TIMEOUT', 'TAB_FROZEN', 'TAB_WEDGED', 'NETWORK', 'NOT_CONNECTED', 'NAVIGATION_FAILED']) {
      expect(shouldRetry(code, 1)).toBe(true);
      expect(shouldRetry(code, 2)).toBe(true);
      expect(shouldRetry(code, 3)).toBe(true);
      expect(shouldRetry(code, 4)).toBe(false);
    }
  });

  it('test_rate_limit_never_retries', () => {
    // The plan's 429 and the registered RATE_LIMITED alike: a rate limit is
    // an instruction to stop, not a transient failure to ride out.
    for (const code of ['RATE_LIMITED', '429']) {
      expect(shouldRetry(code, 1)).toBe(false);
      expect(shouldRetry(code, 2)).toBe(false);
      expect(shouldRetry(code, 3)).toBe(false);
      expect(shouldRetry(code, 4)).toBe(false);
    }
  });

  it('never retries an immediate stop: permission denial or a locked tab', () => {
    for (const code of ['TAB_LOCKED', 'VAULT_PERMISSION_DENIED']) {
      expect(shouldRetry(code, 1)).toBe(false);
      expect(shouldRetry(code, 2)).toBe(false);
    }
  });

  it('never retries a definite non-retryable failure', () => {
    for (const code of ['INVALID_ARGUMENT', 'INTERNAL_ERROR', 'VERIFY_FAILED', 'OUTCOME_UNKNOWN', 'TAB_NOT_FOUND']) {
      expect(shouldRetry(code, 1)).toBe(false);
    }
  });

  it('never retries before any attempt was made, or on a nonsense attempt', () => {
    expect(shouldRetry('TIMEOUT', 0)).toBe(false);
    expect(shouldRetry('TIMEOUT', -1)).toBe(false);
  });
});

describe('errorCodeOf', () => {
  it('reads the code off a `CODE: message` line', () => {
    expect(errorCodeOf('TIMEOUT: tab did not respond')).toBe('TIMEOUT');
    expect(errorCodeOf('RATE_LIMITED: slow down')).toBe('RATE_LIMITED');
  });

  it('accepts the Design aliases the registry never emits', () => {
    expect(errorCodeOf('TAB_FROZEN: tab did not respond')).toBe('TAB_FROZEN');
    expect(errorCodeOf('NETWORK: connection reset')).toBe('NETWORK');
    expect(errorCodeOf('429: too many requests')).toBe('429');
  });

  it('returns undefined for an uncoded message or a code nobody registered', () => {
    expect(errorCodeOf('something went wrong')).toBeUndefined();
    expect(errorCodeOf('TAB_OWNED: a typo code')).toBeUndefined();
    expect(errorCodeOf('')).toBeUndefined();
  });
});

describe('reconcileUnknown', () => {
  const LOGIN_FORM_TEXT =
    '- textbox "Email" [ref=e1]\n- textbox "Password" [ref=e2]\n- button "Sign in" [ref=e3]';

  function unknownStepTask(): { task: Task; step: Task['steps'][number] } {
    const task: Task = {
      id: 'task-1',
      goal: 'Submit the form',
      constraints: ['allow-mutations'],
      steps: [
        {
          tool: 'fake-submit',
          params: {},
          verify: [{ kind: 'text-present', value: 'submitted' }],
          result: { status: 'unknown', detail: 'OUTCOME_UNKNOWN: sent, no reply arrived' },
        },
      ],
      state: 'paused-login',
      evidence: [],
    };
    return { task, step: task.steps[0]! };
  }

  it('test_unknown_outcome_reconciles_before_retry', async () => {
    // The core rule (Design §6 / Review Focus 5): an action sent with no
    // reply is never retried before the state is re-read and the effect
    // confirmed or ruled out — so the action is never executed twice.
    const { task, step } = unknownStepTask();
    const reads: PageSnapshot[] = [];
    const outcome = await reconcileUnknown(task, step, {
      readPage: async () => {
        const page: PageSnapshot = { url: 'https://example.com/done', text: 'submitted', ref: 'browser_snapshot' };
        reads.push(page);
        return page;
      },
      verify: () => ({ ok: true, evidence: 'verified 1 rule(s) at https://example.com/done' }),
    });
    expect(reads.length).toBe(1);
    expect(outcome.outcome).toBe('confirmed');
    expect(step.result?.status).toBe('ok');
    expect(task.evidence.join('\n')).toContain('reconciled');
  });

  it('reports not-happened when the fresh read shows the effect is absent', async () => {
    const { task, step } = unknownStepTask();
    const outcome = await reconcileUnknown(task, step, {
      readPage: async () => ({ url: 'https://example.com/form', text: 'the form, unsubmitted', ref: 'browser_snapshot' }),
      verify: () => ({ ok: false, evidence: 'page does not contain "submitted"' }),
    });
    expect(outcome.outcome).toBe('not-happened');
    // The step stays unknown: the caller decides whether to retry it now
    // that the effect is confirmed absent.
    expect(step.result?.status).toBe('unknown');
    expect(task.evidence.join('\n')).toContain('not-happened');
  });

  it('stays unknown when the page cannot be re-read', async () => {
    const { task, step } = unknownStepTask();
    const outcome = await reconcileUnknown(task, step, {
      readPage: async () => {
        throw new Error('NOT_CONNECTED: extension went away');
      },
      verify: () => ({ ok: true, evidence: 'checked' }),
    });
    expect(outcome.outcome).toBe('unknown');
    expect(step.result?.status).toBe('unknown');
    expect(outcome.evidence).toContain('OUTCOME_UNKNOWN');
  });

  it('stays unknown when no page reader is supplied: without a re-read there is no reconciliation', async () => {
    const { task, step } = unknownStepTask();
    const outcome = await reconcileUnknown(task, step, {
      verify: () => ({ ok: true, evidence: 'checked' }),
    });
    expect(outcome.outcome).toBe('unknown');
    expect(step.result?.status).toBe('unknown');
  });

  it('stays unknown when the re-read page is empty: nothing to check the effect against', async () => {
    const { task, step } = unknownStepTask();
    const outcome = await reconcileUnknown(task, step, {
      readPage: async () => ({ url: 'https://example.com/form', text: '   ', ref: 'browser_snapshot' }),
      verify: () => ({ ok: false, evidence: 'page is empty' }),
    });
    expect(outcome.outcome).toBe('unknown');
  });

  it('stays unknown when the re-read page is an error page, even with the real verifier', async () => {
    const { task, step } = unknownStepTask();
    const outcome = await reconcileUnknown(task, step, {
      readPage: async () => ({
        url: 'https://example.com/form',
        text: "This page isn't working",
        ref: 'browser_snapshot',
      }),
      verify: verifyStep,
    });
    // An error page proves neither that the submit happened nor that it
    // did not: retrying on it could execute the action twice.
    expect(outcome.outcome).toBe('unknown');
    expect(step.result?.status).toBe('unknown');
  });

  it('confirms with the real verifier when the fresh read shows the effect', async () => {
    const { task, step } = unknownStepTask();
    const outcome = await reconcileUnknown(task, step, {
      readPage: async () => ({
        url: 'https://example.com/done',
        text: 'heading "Done"\n- text "submitted"',
        ref: 'browser_snapshot',
      }),
      verify: verifyStep,
    });
    expect(outcome.outcome).toBe('confirmed');
    expect(step.result?.status).toBe('ok');
  });

  it('a login form on the re-read page is not an error page: the effect is simply absent', async () => {
    const { task, step } = unknownStepTask();
    const outcome = await reconcileUnknown(task, step, {
      readPage: async () => ({
        url: 'https://example.com/login',
        text: LOGIN_FORM_TEXT,
        ref: 'browser_snapshot',
      }),
      verify: verifyStep,
    });
    expect(outcome.outcome).toBe('not-happened');
  });
});

describe('runner applies the recovery policy', () => {
  it('retries a TIMEOUT error result with the policy backoffs, then succeeds', async () => {
    const calls: string[] = [];
    const snapshotCalls: string[] = [];
    const slept: number[] = [];
    const tools = new Map<string, ToolDefinition>([
      [
        'fake-ok',
        scriptedTool('fake-ok', calls, [
          failureResult('TIMEOUT: tab did not respond'),
          failureResult('TIMEOUT: tab did not respond'),
          textResult('page loaded'),
        ]),
      ],
      ['browser_snapshot', snapshotTool(snapshotCalls, 'page loaded')],
    ]);
    await saveTask(oneStepTask(), dir);

    const done = await runTask('task-1', {
      tasksDir: dir,
      tools,
      host: dummyHost,
      verify: () => ({ ok: true, evidence: 'checked' }),
      recovery: { sleep: async (ms) => { slept.push(ms); } },
    });

    expect(done.state).toBe('done');
    expect(calls).toEqual(['fake-ok', 'fake-ok', 'fake-ok']);
    expect(slept).toEqual([500, 1500]);
    // A read-only step retries a TIMEOUT without reconciling: the one
    // snapshot read is the post-step verification, not a reconcile.
    expect(snapshotCalls).toEqual(['browser_snapshot']);
    expect(done.steps[0]?.result?.status).toBe('ok');
  });

  it('retries a tool that throws TIMEOUT, then succeeds', async () => {
    const calls: string[] = [];
    const snapshotCalls: string[] = [];
    const slept: number[] = [];
    const tools = new Map<string, ToolDefinition>([
      [
        'fake-ok',
        scriptedTool('fake-ok', calls, [
          new Error('TIMEOUT: tab did not respond'),
          textResult('page loaded'),
        ]),
      ],
      ['browser_snapshot', snapshotTool(snapshotCalls, 'page loaded')],
    ]);
    await saveTask(oneStepTask(), dir);

    const done = await runTask('task-1', {
      tasksDir: dir,
      tools,
      host: dummyHost,
      verify: () => ({ ok: true, evidence: 'checked' }),
      recovery: { sleep: async (ms) => { slept.push(ms); } },
    });

    expect(done.state).toBe('done');
    expect(calls).toEqual(['fake-ok', 'fake-ok']);
    expect(slept).toEqual([500]);
  });

  it('gives up after the fourth attempt and fails with the last error', async () => {
    const calls: string[] = [];
    const slept: number[] = [];
    const tools = new Map<string, ToolDefinition>([
      ['fake-ok', scriptedTool('fake-ok', calls, [failureResult('TIMEOUT: tab did not respond')])],
      ['browser_snapshot', snapshotTool([], 'page loaded')],
    ]);
    await saveTask(oneStepTask(), dir);

    const done = await runTask('task-1', {
      tasksDir: dir,
      tools,
      host: dummyHost,
      verify: () => ({ ok: true, evidence: 'checked' }),
      recovery: { sleep: async (ms) => { slept.push(ms); } },
    });

    expect(done.state).toBe('failed');
    // 3 retries (4 attempts in total), backing off 500ms, 1500ms, 4000ms.
    expect(calls).toEqual(['fake-ok', 'fake-ok', 'fake-ok', 'fake-ok']);
    expect(slept).toEqual([500, 1500, 4000]);
    expect(done.steps[0]?.result?.status).toBe('failed');
    expect(done.steps[0]?.result?.detail).toContain('TIMEOUT');
  });

  it('the third retry actually runs, after the 4000ms backoff', async () => {
    // Fix round 1, Important 1: backoffMs[2] = 4000 must be the wait
    // before a real fourth attempt, not dead config — three TIMEOUTs then
    // a success proves the third retry happens.
    const calls: string[] = [];
    const slept: number[] = [];
    const tools = new Map<string, ToolDefinition>([
      [
        'fake-ok',
        scriptedTool('fake-ok', calls, [
          failureResult('TIMEOUT: tab did not respond'),
          failureResult('TIMEOUT: tab did not respond'),
          failureResult('TIMEOUT: tab did not respond'),
          textResult('page loaded'),
        ]),
      ],
      ['browser_snapshot', snapshotTool([], 'page loaded')],
    ]);
    await saveTask(oneStepTask(), dir);

    const done = await runTask('task-1', {
      tasksDir: dir,
      tools,
      host: dummyHost,
      verify: () => ({ ok: true, evidence: 'checked' }),
      recovery: { sleep: async (ms) => { slept.push(ms); } },
    });

    expect(done.state).toBe('done');
    expect(calls).toEqual(['fake-ok', 'fake-ok', 'fake-ok', 'fake-ok']);
    expect(slept).toEqual([500, 1500, 4000]);
    expect(done.steps[0]?.result?.status).toBe('ok');
  });

  it('never retries a rate-limit failure, in either spelling', async () => {
    for (const code of ['RATE_LIMITED: slow down', '429: too many requests']) {
      const calls: string[] = [];
      const slept: number[] = [];
      const tools = new Map<string, ToolDefinition>([
        ['fake-ok', scriptedTool('fake-ok', calls, [failureResult(code)])],
        ['browser_snapshot', snapshotTool([], 'page loaded')],
      ]);
      await saveTask(oneStepTask('task-rate'), dir);

      const done = await runTask('task-rate', {
        tasksDir: dir,
        tools,
        host: dummyHost,
        verify: () => ({ ok: true, evidence: 'checked' }),
        recovery: { sleep: async (ms) => { slept.push(ms); } },
      });

      expect(done.state).toBe('failed');
      expect(calls).toEqual(['fake-ok']);
      expect(slept).toEqual([]);
    }
  });

  it('never retries a locked tab or a permission denial', async () => {
    for (const code of ['TAB_LOCKED: tab is locked', 'VAULT_PERMISSION_DENIED: no permission']) {
      const calls: string[] = [];
      const tools = new Map<string, ToolDefinition>([
        ['fake-ok', scriptedTool('fake-ok', calls, [failureResult(code)])],
        ['browser_snapshot', snapshotTool([], 'page loaded')],
      ]);
      await saveTask(oneStepTask('task-stop'), dir);

      const done = await runTask('task-stop', {
        tasksDir: dir,
        tools,
        host: dummyHost,
        verify: () => ({ ok: true, evidence: 'checked' }),
      });

      expect(done.state).toBe('failed');
      expect(calls).toEqual(['fake-ok']);
    }
  });

  it('reconciles an uncoded failure before retrying: confirmed means no re-run', async () => {
    const calls: string[] = [];
    const reads: PageSnapshot[] = [];
    const tools = new Map<string, ToolDefinition>([
      ['fake-ok', scriptedTool('fake-ok', calls, [new Error('the call vanished with no reply')])],
      ['browser_snapshot', snapshotTool([], 'page loaded')],
    ]);
    await saveTask(oneStepTask(), dir);

    const done = await runTask('task-1', {
      tasksDir: dir,
      tools,
      host: dummyHost,
      verify: () => ({ ok: true, evidence: 'checked' }),
      recovery: {
        readPage: async () => {
          const page: PageSnapshot = { url: 'https://example.com/', text: 'page loaded', ref: 'reconcile' };
          reads.push(page);
          return page;
        },
      },
    });

    // The throw carried no code, so the outcome was unknown: the runner
    // re-read the page, the effect was confirmed present, and the step was
    // marked ok without ever running the tool a second time.
    expect(reads.length).toBe(1);
    expect(calls).toEqual(['fake-ok']);
    expect(done.state).toBe('done');
    expect(done.steps[0]?.result?.status).toBe('ok');
  });

  it('reconciles an uncoded failure before retrying: absent means one retry, then success', async () => {
    const calls: string[] = [];
    const slept: number[] = [];
    const tools = new Map<string, ToolDefinition>([
      [
        'fake-ok',
        scriptedTool('fake-ok', calls, [new Error('the call vanished with no reply'), textResult('page loaded')]),
      ],
      ['browser_snapshot', snapshotTool([], 'page loaded')],
    ]);
    await saveTask(oneStepTask(), dir);

    const done = await runTask('task-1', {
      tasksDir: dir,
      tools,
      host: dummyHost,
      // First call reconciles the unknown outcome (effect absent); second
      // call verifies the re-run step.
      verify: verifyInSequence([
        { ok: false, evidence: 'page does not contain the effect' },
        { ok: true, evidence: 'checked' },
      ]),
      recovery: {
        readPage: async () => ({ url: 'https://example.com/', text: 'page loaded', ref: 'reconcile' }),
        sleep: async (ms) => { slept.push(ms); },
      },
    });

    expect(calls).toEqual(['fake-ok', 'fake-ok']);
    expect(slept).toEqual([500]);
    expect(done.state).toBe('done');
    expect(done.steps[0]?.result?.status).toBe('ok');
  });

  it('fails instead of retrying when an uncoded failure cannot be reconciled', async () => {
    const calls: string[] = [];
    const tools = new Map<string, ToolDefinition>([
      ['fake-ok', scriptedTool('fake-ok', calls, [new Error('the call vanished with no reply')])],
      ['browser_snapshot', snapshotTool([], 'page loaded')],
    ]);
    await saveTask(oneStepTask(), dir);

    const done = await runTask('task-1', {
      tasksDir: dir,
      tools,
      host: dummyHost,
      verify: () => ({ ok: true, evidence: 'checked' }),
      recovery: {
        readPage: async () => {
          throw new Error('NOT_CONNECTED: extension went away');
        },
      },
    });

    expect(calls).toEqual(['fake-ok']);
    expect(done.state).toBe('failed');
    expect(done.steps[0]?.result?.status).toBe('failed');
    expect(done.steps[0]?.result?.detail).toContain('OUTCOME_UNKNOWN');
  });

  it('a retry runs under the same approval: no re-ask, and never without it', async () => {
    // The step is mutating with blanket approval, and an ask is wired: a
    // retry must neither ask again nor run unapproved — the gate was
    // already passed once, for this step, before the first attempt. The
    // TIMEOUT is on a mutating step, so the retry first reconciles: the
    // re-read shows the effect absent, so the retry is safe.
    const calls: string[] = [];
    const asks: unknown[] = [];
    const slept: number[] = [];
    const reads: PageSnapshot[] = [];
    const tools = new Map<string, ToolDefinition>([
      [
        'fake-submit',
        scriptedTool(
          'fake-submit',
          calls,
          [failureResult('TIMEOUT: tab did not respond'), textResult('submitted')],
          false,
        ),
      ],
      ['browser_snapshot', snapshotTool([], 'submitted')],
    ]);
    await saveTask(
      {
        id: 'task-1',
        goal: 'Submit the form',
        constraints: ['allow-mutations'],
        steps: [{ tool: 'fake-submit', params: {}, verify: [{ kind: 'text-present', value: 'submitted' }] }],
        state: 'planned',
        evidence: [],
      },
      dir,
    );

    const done = await runTask('task-1', {
      tasksDir: dir,
      tools,
      host: dummyHost,
      questions: {
        ask: async (input) => {
          asks.push(input);
          throw new Error('must not ask during a retry');
        },
      },
      recovery: {
        sleep: async (ms) => { slept.push(ms); },
        readPage: async () => {
          const page: PageSnapshot = {
            url: 'https://example.com/form',
            text: 'the form, still blank',
            ref: 'reconcile',
          };
          reads.push(page);
          return page;
        },
      },
    });

    expect(done.state).toBe('done');
    expect(calls).toEqual(['fake-submit', 'fake-submit']);
    expect(slept).toEqual([500]);
    expect(reads.length).toBe(1);
    expect(asks).toEqual([]);
  });
});

describe('a coded TIMEOUT on a mutating step reconciles first', () => {
  /**
   * One mutating submit step: the fake executes the mutation on every
   * call (counted in `executions`) and plays the scripted result — a
   * TIMEOUT throw means the call executed but its reply was lost.
   */
  function mutatingTimeoutTask(): {
    tools: Map<string, ToolDefinition>;
    calls: string[];
    executions: string[];
  } {
    const calls: string[] = [];
    const executions: string[] = [];
    const tools = new Map<string, ToolDefinition>([
      [
        'fake-submit',
        scriptedTool(
          'fake-submit',
          calls,
          [new Error('TIMEOUT: tab did not respond'), textResult('submitted')],
          false,
          z.object({}).strict(),
          () => {
            executions.push('fake-submit');
          },
        ),
      ],
      ['browser_snapshot', snapshotTool([], 'submitted')],
    ]);
    return { tools, calls, executions };
  }

  function submitTask(): Task {
    return {
      id: 'task-1',
      goal: 'Submit the form',
      constraints: ['allow-mutations'],
      steps: [{ tool: 'fake-submit', params: {}, verify: [{ kind: 'text-present', value: 'submitted' }] }],
      state: 'planned',
      evidence: [],
    };
  }

  it('a mutating TIMEOUT whose effect is already present is never executed twice', async () => {
    // Fix round 1, Important 2: a TIMEOUT from a mutating tool is
    // "action sent, no reply arrived" — the tool may have executed and
    // only the reply was lost. The retry reconciles first; a confirmed
    // effect means the step is done and the tool never runs again.
    const { tools, calls, executions } = mutatingTimeoutTask();
    const reads: PageSnapshot[] = [];
    await saveTask(submitTask(), dir);

    const done = await runTask('task-1', {
      tasksDir: dir,
      tools,
      host: dummyHost,
      recovery: {
        readPage: async () => {
          const page: PageSnapshot = { url: 'https://example.com/done', text: 'submitted', ref: 'reconcile' };
          reads.push(page);
          return page;
        },
      },
    });

    expect(done.state).toBe('done');
    expect(done.steps[0]?.result?.status).toBe('ok');
    expect(done.steps[0]?.result?.detail).toContain('reconciled');
    // The mutation executed once — the timeout lost its reply — and the
    // reconcile found the effect present, so the tool never ran again.
    expect(executions).toEqual(['fake-submit']);
    expect(calls).toEqual(['fake-submit']);
    expect(reads.length).toBe(1);
  });

  it('a mutating TIMEOUT retries when reconciliation says the effect did not happen', async () => {
    const { tools, calls, executions } = mutatingTimeoutTask();
    const reads: PageSnapshot[] = [];
    const slept: number[] = [];
    await saveTask(submitTask(), dir);

    const done = await runTask('task-1', {
      tasksDir: dir,
      tools,
      host: dummyHost,
      recovery: {
        readPage: async () => {
          const page: PageSnapshot = {
            url: 'https://example.com/form',
            text: 'the form, still blank',
            ref: 'reconcile',
          };
          reads.push(page);
          return page;
        },
        sleep: async (ms) => { slept.push(ms); },
      },
    });

    expect(done.state).toBe('done');
    expect(done.steps[0]?.result?.status).toBe('ok');
    // The reconcile found no effect on the fresh read, so the retry was
    // safe: the mutation ran twice in total — once lost, once retried.
    expect(executions).toEqual(['fake-submit', 'fake-submit']);
    expect(calls).toEqual(['fake-submit', 'fake-submit']);
    expect(reads.length).toBe(1);
    expect(slept).toEqual([500]);
  });

  it('a mutating TIMEOUT that cannot be reconciled fails instead of retrying blind', async () => {
    const { tools, calls } = mutatingTimeoutTask();
    const slept: number[] = [];
    await saveTask(submitTask(), dir);

    const done = await runTask('task-1', {
      tasksDir: dir,
      tools,
      host: dummyHost,
      recovery: {
        readPage: async () => {
          throw new Error('NOT_CONNECTED: extension went away');
        },
        sleep: async (ms) => { slept.push(ms); },
      },
    });

    expect(calls).toEqual(['fake-submit']);
    expect(slept).toEqual([]);
    expect(done.state).toBe('failed');
    expect(done.steps[0]?.result?.status).toBe('failed');
    expect(done.steps[0]?.result?.detail).toContain('OUTCOME_UNKNOWN');
  });
});

describe('resume reconciles an unknown step instead of blindly re-running it', () => {
  const LOGIN_FORM_TEXT =
    '- textbox "Email" [ref=e1]\n- textbox "Password" [ref=e2]\n- button "Sign in" [ref=e3]';
  // The real browser_navigate schema takes an optional tabId
  // (`mcp-server/src/tools/navigate.ts`); the fake keeps it so tab
  // binding and recording behave as they do against the registry.
  const navigateSchema = z
    .object({ url: z.string(), incognito: z.boolean().optional(), tabId: z.number().optional() })
    .strict();

  /**
   * A task whose second step is a mutating submit: navigate to the
   * dashboard, then submit. The snapshot fake plays the login redirect
   * after the first submit only; on the dashboard it shows the submit's
   * effect exactly when `effectVisible` is true.
   */
  function submitTask(effectVisible: boolean): {
    tools: Map<string, ToolDefinition>;
    submits: string[];
    calls: string[];
    phase: { name: 'dashboard' | 'login' };
  } {
    const calls: string[] = [];
    const submits: string[] = [];
    const phase: { name: 'dashboard' | 'login' } = { name: 'dashboard' };
    const snapshot: ToolDefinition = {
      name: 'browser_snapshot',
      summary: 'Fake browser_snapshot for recovery tests',
      description: 'Test-only stand-in for browser_snapshot.',
      inputSchema: tabSchema,
      idempotent: true as const,
      handler: async () => {
        calls.push('browser_snapshot');
        if (phase.name === 'login') {
          return outcomeOf({
            success: true,
            text: LOGIN_FORM_TEXT,
            url: 'https://example.com/login?next=%2Fdashboard',
            tabId: 42,
          });
        }
        return outcomeOf({
          success: true,
          // After the second submit the page shows the effect; before it,
          // only when the first submit visibly went through.
          text:
            submits.length >= 2 || effectVisible
              ? 'heading "Dashboard"\n- text "submitted"'
              : 'heading "Dashboard"',
          url: 'https://example.com/dashboard',
          tabId: 42,
        });
      },
    };
    const tools = new Map<string, ToolDefinition>([
      ['browser_navigate', scriptedTool('browser_navigate', calls, [textResult('loaded')], false, navigateSchema)],
      [
        'fake-submit',
        scriptedTool(
          'fake-submit',
          submits,
          [textResult('submitted')],
          false,
          z.object({}).strict(),
          () => {
            // The session expires right after the first submit only.
            if (submits.length === 1) phase.name = 'login';
          },
        ),
      ],
      ['browser_snapshot', snapshot],
    ]);
    return { tools, submits, calls, phase };
  }

  function taskWithSubmit(): Task {
    return {
      id: 'task-1',
      goal: 'Open the dashboard and submit the form',
      constraints: ['allow-mutations'],
      steps: [
        {
          tool: 'browser_navigate',
          params: { url: 'https://example.com/dashboard' },
          verify: [{ kind: 'no-error-text', value: "isn't working" }],
        },
        { tool: 'fake-submit', params: {}, verify: [{ kind: 'text-present', value: 'submitted' }] },
      ],
      state: 'planned',
      evidence: [],
    };
  }

  async function pauseOnExpiry(tools: Map<string, ToolDefinition>): Promise<Task> {
    await saveTask(taskWithSubmit(), dir);
    const paused = await runTask('task-1', {
      tasksDir: dir,
      tools,
      host: dummyHost,
      session: { knownLoginUrls: ['https://example.com/login'] },
    });
    expect(paused.state).toBe('paused-login');
    // The carried ruling: the step executed but was never verified, so its
    // outcome is recorded as unknown — not left blank.
    expect(paused.steps[1]?.result?.status).toBe('unknown');
    expect(paused.steps[1]?.result?.detail).toContain('OUTCOME_UNKNOWN');
    return paused;
  }

  async function resume(
    tools: Map<string, ToolDefinition>,
    phase: { name: 'dashboard' | 'login' },
  ): Promise<Task> {
    phase.name = 'dashboard';
    return resumeAfterLogin('task-1', {
      tasksDir: dir,
      knownLoginUrls: ['https://example.com/login'],
      readPage: async () => ({
        url: 'https://example.com/dashboard',
        text: 'heading "Dashboard"',
        ref: 'browser_snapshot tab 42',
      }),
      continueWith: async (task) =>
        runTask(task.id, {
          tasksDir: dir,
          tools,
          host: dummyHost,
          session: { knownLoginUrls: ['https://example.com/login'] },
        }),
    });
  }

  it('a paused-then-resumed mutating step whose effect is present is not executed twice', async () => {
    const { tools, submits, phase } = submitTask(true);
    await pauseOnExpiry(tools);
    expect(submits).toEqual(['fake-submit']);

    const resumed = await resume(tools, phase);
    expect(resumed.state).toBe('done');
    expect(resumed.steps[1]?.result?.status).toBe('ok');
    // The resume reconciled the unknown submit against the fresh page and
    // found it already submitted: the tool ran once, in the first run.
    expect(submits).toEqual(['fake-submit']);
  });

  it('a paused-then-resumed mutating step whose effect is absent is re-run exactly once', async () => {
    const { tools, submits, phase } = submitTask(false);
    await pauseOnExpiry(tools);
    expect(submits).toEqual(['fake-submit']);

    const resumed = await resume(tools, phase);
    expect(resumed.state).toBe('done');
    expect(resumed.steps[1]?.result?.status).toBe('ok');
    // The reconcile found no submit on the fresh page, so the resume
    // re-ran the step once — and only once.
    expect(submits).toEqual(['fake-submit', 'fake-submit']);
  });

  it('a resume reconciles on the tab the paused step opened, not the previously bound tab', async () => {
    const LOGIN = LOGIN_FORM_TEXT;
    const navigateCalls: string[] = [];
    const seen: Array<Record<string, unknown>> = [];
    let snapshotCalls = 0;
    const snapshot: ToolDefinition = {
      name: 'browser_snapshot',
      summary: 'Fake browser_snapshot for recovery tests',
      description: 'Test-only stand-in for browser_snapshot.',
      inputSchema: tabSchema,
      idempotent: true as const,
      handler: async (_host, params) => {
        seen.push(params);
        snapshotCalls += 1;
        // The first read — after the navigate — lands on the login page;
        // later reads see the dashboard.
        return snapshotCalls === 1
          ? outcomeOf({
              success: true,
              text: LOGIN,
              url: 'https://example.com/login?next=%2Fdashboard',
              tabId: 42,
            })
          : outcomeOf({ success: true, text: 'heading "Dashboard"', url: 'https://example.com/dashboard', tabId: 42 });
      },
    };
    const tools = new Map<string, ToolDefinition>([
      [
        'browser_navigate',
        scriptedTool(
          'browser_navigate',
          navigateCalls,
          [outcomeOf({ success: true, text: 'loaded', url: 'https://example.com/dashboard', tabId: 42 })],
          false,
          navigateSchema,
        ),
      ],
      ['browser_snapshot', snapshot],
    ]);
    await saveTask(
      {
        id: 'task-1',
        goal: 'Open the dashboard',
        constraints: ['read-only'],
        steps: [
          {
            tool: 'browser_navigate',
            params: { url: 'https://example.com/dashboard' },
            verify: [{ kind: 'no-error-text', value: "isn't working" }],
          },
        ],
        state: 'planned',
        evidence: [],
      },
      dir,
    );

    const paused = await runTask('task-1', {
      tasksDir: dir,
      tools,
      host: dummyHost,
      session: { knownLoginUrls: ['https://example.com/login'] },
    });
    expect(paused.state).toBe('paused-login');
    expect(paused.steps[0]?.result?.status).toBe('unknown');
    // The tab the navigate opened is recorded with the unknown step, so
    // the resume rebinds to it.
    expect(paused.steps[0]?.params).toEqual({ url: 'https://example.com/dashboard', tabId: 42 });

    const resumed = await resumeAfterLogin('task-1', {
      tasksDir: dir,
      knownLoginUrls: ['https://example.com/login'],
      readPage: async () => ({
        url: 'https://example.com/dashboard',
        text: 'heading "Dashboard"',
        ref: 'browser_snapshot tab 42',
      }),
      continueWith: async (task) =>
        runTask(task.id, {
          tasksDir: dir,
          tools,
          host: dummyHost,
          session: { knownLoginUrls: ['https://example.com/login'] },
        }),
    });
    expect(resumed.state).toBe('done');
    expect(resumed.steps[0]?.result?.status).toBe('ok');
    expect(navigateCalls).toEqual(['browser_navigate']);
    // Both the post-navigate read and the reconcile re-read went to the
    // tab the navigate opened — the reconcile did not read some older tab.
    expect(seen).toEqual([{ tabId: 42 }, { tabId: 42 }]);
  });

  it('a question resume reconciles an unknown step under its recorded approval, without re-asking', async () => {
    // The state is constructed: today's runner asks before a step executes,
    // so a question pause after execution cannot arise from it yet — but
    // any unknown step on a question resume must still reconcile first.
    const calls: string[] = [];
    const asks: unknown[] = [];
    const tools = new Map<string, ToolDefinition>([
      ['fake-submit', scriptedTool('fake-submit', calls, [textResult('submitted')], false)],
      ['browser_snapshot', snapshotTool([], 'submitted')],
    ]);
    const task: Task = {
      id: 'task-1',
      goal: 'Submit the form',
      constraints: ['read-only'],
      steps: [
        {
          tool: 'fake-submit',
          params: {},
          verify: [{ kind: 'text-present', value: 'submitted' }],
          result: { status: 'unknown', detail: 'OUTCOME_UNKNOWN: sent, no reply arrived' },
        },
      ],
      state: 'planned',
      evidence: [],
    };
    await saveTask(task, dir);
    const question = await askQuestion('task-1', 'Allow step 1 (fake-submit) to change site data?', ['yes', 'no'], {
      tasksDir: dir,
      kind: 'confirm',
      context: { stepIndex: 0, tool: 'fake-submit', params: {} },
    });

    const resumed = await answerQuestion(question.id, 'yes', {
      tasksDir: dir,
      continueWith: async (answered) =>
        runTask(answered.id, {
          tasksDir: dir,
          tools,
          host: dummyHost,
          questions: {
            ask: async (input) => {
              asks.push(input);
              throw new Error('must not ask again during a resume');
            },
          },
          recovery: {
            readPage: async () => ({ url: 'https://example.com/done', text: 'submitted', ref: 'reconcile' }),
          },
        }),
    });

    expect(resumed.state).toBe('done');
    expect(resumed.steps[0]?.result?.status).toBe('ok');
    // The approval the user just gave covers the step; the reconcile
    // confirmed the effect, so the tool never ran again — and nothing
    // re-asked for approval.
    expect(calls).toEqual([]);
    expect(asks).toEqual([]);
    expect(resumed.constraints).toContain('allow-mutations:step:0');
  });

  it('a question resume re-runs an unknown step whose effect is absent, under its recorded approval', async () => {
    const calls: string[] = [];
    const asks: unknown[] = [];
    const tools = new Map<string, ToolDefinition>([
      ['fake-submit', scriptedTool('fake-submit', calls, [textResult('submitted')], false)],
      ['browser_snapshot', snapshotTool([], 'submitted')],
    ]);
    const task: Task = {
      id: 'task-1',
      goal: 'Submit the form',
      constraints: ['read-only'],
      steps: [
        {
          tool: 'fake-submit',
          params: {},
          verify: [{ kind: 'text-present', value: 'submitted' }],
          result: { status: 'unknown', detail: 'OUTCOME_UNKNOWN: sent, no reply arrived' },
        },
      ],
      state: 'planned',
      evidence: [],
    };
    await saveTask(task, dir);
    const question = await askQuestion('task-1', 'Allow step 1 (fake-submit) to change site data?', ['yes', 'no'], {
      tasksDir: dir,
      kind: 'confirm',
      context: { stepIndex: 0, tool: 'fake-submit', params: {} },
    });

    const resumed = await answerQuestion(question.id, 'yes', {
      tasksDir: dir,
      continueWith: async (answered) =>
        runTask(answered.id, {
          tasksDir: dir,
          tools,
          host: dummyHost,
          questions: {
            ask: async (input) => {
              asks.push(input);
              throw new Error('must not ask again during a resume');
            },
          },
          // First call reconciles (effect absent); second verifies the re-run.
          verify: verifyInSequence([
            { ok: false, evidence: 'page does not contain "submitted"' },
            { ok: true, evidence: 'checked' },
          ]),
          recovery: {
            readPage: async () => ({ url: 'https://example.com/form', text: 'the form', ref: 'reconcile' }),
          },
        }),
    });

    expect(resumed.state).toBe('done');
    expect(resumed.steps[0]?.result?.status).toBe('ok');
    expect(calls).toEqual(['fake-submit']);
    expect(asks).toEqual([]);
  });

  it('a resume that still cannot reconcile fails instead of re-running blind', async () => {
    const calls: string[] = [];
    const tools = new Map<string, ToolDefinition>([
      ['fake-submit', scriptedTool('fake-submit', calls, [textResult('submitted')], false)],
      ['browser_snapshot', snapshotTool([], 'submitted')],
    ]);
    const task: Task = {
      id: 'task-1',
      goal: 'Submit the form',
      constraints: ['allow-mutations'],
      steps: [
        {
          tool: 'fake-submit',
          params: {},
          verify: [{ kind: 'text-present', value: 'submitted' }],
          result: { status: 'unknown', detail: 'OUTCOME_UNKNOWN: sent, no reply arrived' },
        },
      ],
      state: 'running',
      evidence: [],
    };
    await saveTask(task, dir);

    const done = await runTask('task-1', {
      tasksDir: dir,
      tools,
      host: dummyHost,
      recovery: {
        readPage: async () => {
          throw new Error('NOT_CONNECTED: extension went away');
        },
      },
    });

    expect(calls).toEqual([]);
    expect(done.state).toBe('failed');
    expect(done.steps[0]?.result?.status).toBe('failed');
    expect(done.steps[0]?.result?.detail).toContain('OUTCOME_UNKNOWN');
  });
});

describe('unknown outcomes in the evidence report and the store', () => {
  it('an unknown step is unconfirmed, never a found value', () => {
    const task: Task = {
      id: 'task-1',
      goal: 'Submit the form',
      constraints: ['allow-mutations'],
      steps: [
        {
          tool: 'fake-submit',
          params: {},
          verify: [{ kind: 'text-present', value: 'submitted' }],
          result: { status: 'unknown', detail: 'OUTCOME_UNKNOWN: sent, no reply arrived' },
        },
      ],
      state: 'paused-login',
      evidence: [],
    };
    const report = buildEvidenceReport(task);
    expect(report.json.checked[0]?.status).toBe('unknown');
    expect(report.json.values).toEqual([]);
    expect(report.json.unconfirmed.some((item) => item.step === 1)).toBe(true);
    expect(report.text).toContain('غير معروفة');
  });

  it('an unknown step result survives a save and load roundtrip', async () => {
    const task: Task = {
      id: 'task-1',
      goal: 'Submit the form',
      constraints: ['allow-mutations'],
      steps: [
        {
          tool: 'fake-submit',
          params: {},
          verify: [{ kind: 'text-present', value: 'submitted' }],
          result: { status: 'unknown', detail: 'OUTCOME_UNKNOWN: sent, no reply arrived' },
        },
      ],
      state: 'paused-login',
      evidence: [],
    };
    await saveTask(task, dir);
    expect(await loadTask('task-1', dir)).toEqual(task);
  });

  it('a reconciled-confirmed step contributes only its genuine fresh observation as a found value', async () => {
    // Fix round 1, additional check: the reconcile line written into a
    // confirmed step's result.detail carries the verifier's evidence from
    // the fresh re-read — including its observed="..." excerpt — so the
    // evidence report's found value is that genuine fresh observation,
    // not a stale or unverified value. Nothing from the step's original
    // unknown detail may leak in.
    const task: Task = {
      id: 'task-1',
      goal: 'Submit the form',
      constraints: ['allow-mutations'],
      steps: [
        {
          tool: 'fake-submit',
          params: {},
          verify: [{ kind: 'text-present', value: 'submitted' }],
          result: { status: 'unknown', detail: 'OUTCOME_UNKNOWN: sent, no reply arrived' },
        },
      ],
      state: 'paused-login',
      evidence: [],
    };
    const step = task.steps[0]!;
    const outcome = await reconcileUnknown(task, step, {
      readPage: async () => ({
        url: 'https://example.com/done',
        text: 'heading "Done"\n- text "submitted"',
        ref: 'browser_snapshot',
      }),
      verify: verifyStep,
    });
    expect(outcome.outcome).toBe('confirmed');
    expect(step.result?.status).toBe('ok');
    task.state = 'done';

    const report = buildEvidenceReport(task);
    expect(report.json.values).toHaveLength(1);
    // The found value is the fresh observation: the reconcile line carries
    // the verifier's observed="..." excerpt from the re-read page.
    expect(report.json.values[0]?.value).toContain('submitted');
    expect(report.json.values[0]?.value).toContain('reconciled');
    // And nothing from the stale unknown detail survives into the value.
    expect(report.json.values[0]?.value).not.toContain('no reply arrived');
    expect(report.json.unconfirmed).toEqual([]);
  });
});
