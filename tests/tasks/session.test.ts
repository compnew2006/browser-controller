import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { detectSession, pauseForLogin, resumeAfterLogin } from '../../mcp-server/src/tasks/session.js';
import type { SessionPage } from '../../mcp-server/src/tasks/session.js';
import { loadTask, saveTask } from '../../mcp-server/src/tasks/store.js';
import { saveTaskWithReport } from '../../mcp-server/src/tasks/reporting.js';
import { answerQuestion, askQuestion, type Question, type QuestionContext } from '../../mcp-server/src/tasks/questions.js';
import {
  approvedAccountOf,
  checkFilledAccount,
  extractFilledUsername,
  findDifferentSavedLogin,
  hasLoginApproval,
  isSubmitStep,
  latestFillIndex,
  loginApprovedAccountConstraint,
  loginApprovedConstraint,
  loginVerifiedConstraint,
  replaceApprovedConstraint,
} from '../../mcp-server/src/tasks/login-check.js';
import { runTask } from '../../mcp-server/src/tasks/runner.js';
import type { Task } from '../../mcp-server/src/tasks/types.js';
import type { ToolDefinition, ToolHost, ToolResult } from '../../mcp-server/src/tools/types.js';
import { outcomeOf, targetParam, textResult } from '../../mcp-server/src/tools/types.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-tasks-session-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const LOGIN_FORM_TEXT =
  '- textbox "Email" [ref=e1]\n- textbox "Password" [ref=e2]\n- button "Sign in" [ref=e3]';

/** The Chrome security interstitial for an http site, as the SMACC case shows it. */
const HTTP_WARNING_TEXT =
  'Your connection is not private\n' +
  'Attackers might be trying to steal your information from arkanerp.dyndns.org\n' +
  'NET::ERR_CERT_AUTHORITY_INVALID\n' +
  'Back to safety\n' +
  'Advanced';

function taskWithSteps(id = 'task-1'): Task {
  return {
    id,
    goal: 'Open the dashboard and confirm it loaded',
    constraints: ['read-only'],
    steps: [
      { tool: 'browser_navigate', params: { url: 'https://example.com/dashboard' }, verify: [{ kind: 'no-error-text', value: "isn't working" }] },
      { tool: 'browser_snapshot', params: {}, verify: [{ kind: 'no-error-text', value: "isn't working" }] },
    ],
    state: 'running',
    evidence: [],
  };
}

describe('detectSession', () => {
  it('test_login_redirect_detected_as_expired', () => {
    const page: SessionPage = {
      url: 'https://example.com/login?next=%2Fdashboard',
      text: LOGIN_FORM_TEXT,
      ref: 'browser_snapshot tab 42',
      expectedUrl: 'https://example.com/dashboard',
    };
    expect(detectSession('default', 'https://example.com', page, ['https://example.com/login'])).toBe('expired');
  });

  it('detects a redirect to a generic sign-in path as expired without site knowledge', () => {
    const page: SessionPage = {
      url: 'https://example.com/auth/login',
      text: LOGIN_FORM_TEXT,
      ref: 'browser_snapshot tab 42',
      expectedUrl: 'https://example.com/dashboard',
    };
    expect(detectSession('default', 'https://example.com', page)).toBe('expired');
  });

  it('test_login_form_detected', () => {
    const page: SessionPage = {
      url: 'https://example.com/',
      text: LOGIN_FORM_TEXT,
      ref: 'browser_snapshot tab 42',
    };
    expect(detectSession('default', 'https://example.com', page)).toBe('login-page');
  });

  it('returns login-page for a known login URL when no redirect is proven', () => {
    const page: SessionPage = {
      url: 'https://example.com/login',
      text: LOGIN_FORM_TEXT,
      ref: 'browser_snapshot tab 42',
    };
    expect(detectSession('default', 'https://example.com', page, ['https://example.com/login'])).toBe('login-page');
  });

  it('returns login-page when the task meant to be on the login page', () => {
    const page: SessionPage = {
      url: 'https://example.com/login',
      text: LOGIN_FORM_TEXT,
      ref: 'browser_snapshot tab 42',
      expectedUrl: 'https://example.com/login',
    };
    expect(detectSession('default', 'https://example.com', page, ['https://example.com/login'])).toBe('login-page');
  });

  it('test_http_warning_page_is_not_login_page', () => {
    const page: SessionPage = {
      url: 'http://arkanerp.dyndns.org/Login.aspx',
      text: HTTP_WARNING_TEXT,
      ref: 'browser_snapshot tab 42',
    };
    const state = detectSession('default', 'http://arkanerp.dyndns.org', page);
    expect(state).toBe('warning-page');
    expect(state).not.toBe('login-page');
    expect(state).not.toBe('logged-in');
  });

  it('a warning page stays a warning even when its text also names a login form', () => {
    const page: SessionPage = {
      url: 'http://example.com/login',
      text: `${HTTP_WARNING_TEXT}\n${LOGIN_FORM_TEXT}`,
      ref: 'browser_snapshot tab 42',
      expectedUrl: 'http://example.com/dashboard',
    };
    expect(detectSession('default', 'http://example.com', page)).toBe('warning-page');
  });

  it('does not classify a help page that merely discusses certificates and security warnings as a warning page', () => {
    const page: SessionPage = {
      url: 'https://example.com/help/certificates',
      text:
        'heading "Certificate help"\n' +
        "If you see a certificate error or a security warning, your connection is not private — this article explains what that means and how to check the certificate.\n" +
        '- link "Back to help" [ref=e1]',
      ref: 'browser_snapshot tab 42',
    };
    expect(detectSession('default', 'https://example.com', page)).toBe('logged-in');
  });

  it("detects the contracted interstitial heading as a warning page", () => {
    const page: SessionPage = {
      url: 'https://example.com/dashboard',
      text: 'heading "Your connection isn\'t private"\nAttackers might be trying to steal your information\n- button "Back to safety" [ref=e1]',
      ref: 'browser_snapshot tab 42',
    };
    expect(detectSession('default', 'https://example.com', page)).toBe('warning-page');
  });

  it('detects a role-less interstitial whose first line is the heading as a warning page', () => {
    const page: SessionPage = {
      url: 'https://example.com/dashboard',
      text: 'Your connection is not private\nBack to safety\nAdvanced',
      ref: 'browser_snapshot tab 42',
    };
    expect(detectSession('default', 'https://example.com', page)).toBe('warning-page');
  });

  it('returns logged-in for an ordinary page on the expected origin', () => {
    const page: SessionPage = {
      url: 'https://example.com/dashboard',
      text: 'heading "Dashboard"\n- link "Reports" [ref=e1]',
      ref: 'browser_snapshot tab 42',
    };
    expect(detectSession('default', 'https://example.com', page)).toBe('logged-in');
  });

  it('returns unknown when the page cannot be placed', () => {
    expect(detectSession('default', 'https://example.com', { url: '', text: '', ref: 'unseen' })).toBe('unknown');
    expect(
      detectSession('default', 'https://example.com', {
        url: 'https://other.test/page',
        text: 'heading "Elsewhere"',
        ref: 'browser_snapshot tab 42',
      }),
    ).toBe('unknown');
  });
});

describe('pauseForLogin', () => {
  it('pauses a running task in paused-login and saves the current step number', async () => {
    const task = taskWithSteps();
    task.steps[0]!.result = { status: 'ok', detail: 'navigated' };
    await saveTask(task, dir);

    const paused = await pauseForLogin('task-1', 1, dir);
    expect(paused.state).toBe('paused-login');
    expect(paused.evidence.join('\n')).toContain('step 2 of 2');

    const reloaded = await loadTask('task-1', dir);
    expect(reloaded?.state).toBe('paused-login');
    expect(reloaded?.evidence.join('\n')).toContain('step 2 of 2');
  });

  it('records the first unfinished step when no index is given', async () => {
    await saveTask(taskWithSteps(), dir);
    const paused = await pauseForLogin('task-1', undefined, dir);
    expect(paused.state).toBe('paused-login');
    expect(paused.evidence.join('\n')).toContain('step 1 of 2');
  });

  it('throws for a task that was never saved and for a finished task', async () => {
    await expect(pauseForLogin('missing', 0, dir)).rejects.toThrowError(/not found/);
    const done = taskWithSteps();
    done.state = 'done';
    await saveTask(done, dir);
    await expect(pauseForLogin('task-1', 0, dir)).rejects.toThrowError(/cannot pause.*done/);
  });
});

describe('resumeAfterLogin', () => {
  async function pausedTask(): Promise<Task> {
    const task = taskWithSteps();
    task.steps[0]!.result = { status: 'ok', detail: 'navigated' };
    task.state = 'paused-login';
    await saveTask(task, dir);
    return task;
  }

  it('stays paused when the re-check still shows an expired session, and never continues', async () => {
    await pausedTask();
    const continued: Task[] = [];
    const stayed = await resumeAfterLogin('task-1', {
      tasksDir: dir,
      readPage: async () => ({
        url: 'https://example.com/login?next=%2Fdashboard',
        text: LOGIN_FORM_TEXT,
        ref: 'browser_snapshot tab 42',
        expectedUrl: 'https://example.com/dashboard',
      }),
      knownLoginUrls: ['https://example.com/login'],
      continueWith: async (task) => {
        continued.push(task);
        return task;
      },
    });
    expect(stayed.state).toBe('paused-login');
    expect(continued).toEqual([]);
    expect(stayed.evidence.join('\n')).toContain('expired');
  });

  it('stays paused on a security warning page, and never continues', async () => {
    await pausedTask();
    const continued: Task[] = [];
    const stayed = await resumeAfterLogin('task-1', {
      tasksDir: dir,
      readPage: async () => ({
        url: 'http://arkanerp.dyndns.org/Login.aspx',
        text: HTTP_WARNING_TEXT,
        ref: 'browser_snapshot tab 42',
      }),
      continueWith: async (task) => {
        continued.push(task);
        return task;
      },
    });
    expect(stayed.state).toBe('paused-login');
    expect(continued).toEqual([]);
    expect(stayed.evidence.join('\n')).toContain('warning');
  });

  it('stays paused when the re-check page is on the wrong site, and never continues', async () => {
    await pausedTask();
    const continued: Task[] = [];
    const stayed = await resumeAfterLogin('task-1', {
      tasksDir: dir,
      readPage: async () => ({
        url: 'https://other.example/home',
        text: 'heading "Welcome"',
        ref: 'browser_snapshot tab 42',
      }),
      continueWith: async (task) => {
        continued.push(task);
        return task;
      },
    });
    expect(stayed.state).toBe('paused-login');
    expect(continued).toEqual([]);
    expect(stayed.evidence.join('\n')).toContain('not recognisably the expected site');
  });

  it('stays paused when the re-check page cannot be placed, and never continues', async () => {
    await pausedTask();
    const continued: Task[] = [];
    const stayed = await resumeAfterLogin('task-1', {
      tasksDir: dir,
      readPage: async () => ({
        url: '',
        text: '',
        ref: 'browser_snapshot tab 42',
      }),
      continueWith: async (task) => {
        continued.push(task);
        return task;
      },
    });
    expect(stayed.state).toBe('paused-login');
    expect(continued).toEqual([]);
    expect(stayed.evidence.join('\n')).toContain('could not place the page');
  });

  it('re-checks the page first, then continues from the same step once logged in', async () => {
    const task = await pausedTask();
    const seen: SessionPage[] = [];
    const continued: Task[] = [];
    const resumed = await resumeAfterLogin('task-1', {
      tasksDir: dir,
      readPage: async (toRead) => {
        expect(toRead.id).toBe(task.id);
        const page: SessionPage = {
          url: 'https://example.com/dashboard',
          text: 'heading "Dashboard"',
          ref: 'browser_snapshot tab 42',
        };
        seen.push(page);
        return page;
      },
      continueWith: async (toContinue) => {
        continued.push(toContinue);
        // The continuation resumes from the first unfinished step: step 1
        // stays done, step 2 is still unrun.
        expect(toContinue.steps[0]?.result?.status).toBe('ok');
        expect(toContinue.steps[1]?.result).toBeUndefined();
        return { ...toContinue, state: 'done' as const };
      },
    });
    expect(seen.length).toBe(1);
    expect(resumed.state).toBe('done');
    expect(continued.length).toBe(1);
    expect(continued[0]?.state).toBe('running');
    const reloaded = await loadTask('task-1', dir);
    expect(reloaded?.evidence.join('\n')).toContain('resuming from the same step');
  });

  /**
   * The cancel from the other process, exactly as `browser_task_cancel`
   * does it: the stored record fails with the cancellation evidence and
   * the marker, and its report is saved. Called from inside `readPage`,
   * so it lands between `resumeAfterLogin`'s load and its save.
   */
  async function cancelFromAnotherProcess(id: string): Promise<void> {
    const stored = await loadTask(id, dir);
    if (!stored) throw new Error('task was never saved');
    stored.state = 'failed';
    stored.cancelled = true;
    stored.evidence.push('cancelled by the user at step 2 of 2 — the task stops here and never resumes');
    await saveTaskWithReport(stored, dir);
  }

  it('a cancel landing between the load and the resume save does not resume the task', async () => {
    await pausedTask();
    const continued: Task[] = [];
    const resumed = await resumeAfterLogin('task-1', {
      tasksDir: dir,
      readPage: async () => {
        await cancelFromAnotherProcess('task-1');
        return {
          url: 'https://example.com/dashboard',
          text: 'heading "Dashboard"',
          ref: 'browser_snapshot tab 42',
        };
      },
      continueWith: async (task) => {
        continued.push(task);
        return task;
      },
    });
    // The resume never ran: the returned record is the cancellation.
    expect(resumed.state).toBe('failed');
    expect(resumed.evidence.some((line) => line.startsWith('cancelled by the user'))).toBe(true);
    expect(continued).toEqual([]);
    const stored = await loadTask('task-1', dir);
    expect(stored?.state).toBe('failed');
    expect(stored?.evidence.some((line) => line.startsWith('cancelled by the user'))).toBe(true);
    // The resume evidence was never saved over the cancellation, and the
    // marker is cleaned up on the terminal record, as the wrapper does.
    expect(stored?.evidence.some((line) => line.includes('resuming from the same step'))).toBe(false);
    expect(stored?.cancelled).toBeUndefined();
    expect(stored?.report?.json.state).toBe('failed');
  });

  it('a cancel landing between the load and the still-paused save is not overwritten with paused-login', async () => {
    await pausedTask();
    const continued: Task[] = [];
    const stayed = await resumeAfterLogin('task-1', {
      tasksDir: dir,
      readPage: async () => {
        await cancelFromAnotherProcess('task-1');
        return {
          url: 'https://example.com/login?next=%2Fdashboard',
          text: LOGIN_FORM_TEXT,
          ref: 'browser_snapshot tab 42',
          expectedUrl: 'https://example.com/dashboard',
        };
      },
      knownLoginUrls: ['https://example.com/login'],
      continueWith: async (task) => {
        continued.push(task);
        return task;
      },
    });
    expect(stayed.state).toBe('failed');
    expect(stayed.evidence.some((line) => line.startsWith('cancelled by the user'))).toBe(true);
    expect(continued).toEqual([]);
    const stored = await loadTask('task-1', dir);
    expect(stored?.state).toBe('failed');
    expect(stored?.evidence.some((line) => line.startsWith('cancelled by the user'))).toBe(true);
    expect(stored?.evidence.some((line) => line.includes('staying paused'))).toBe(false);
    expect(stored?.cancelled).toBeUndefined();
  });

  it('returns the task running when no continuation is supplied', async () => {
    await pausedTask();
    const resumed = await resumeAfterLogin('task-1', {
      tasksDir: dir,
      readPage: async () => ({
        url: 'https://example.com/dashboard',
        text: 'heading "Dashboard"',
        ref: 'browser_snapshot tab 42',
      }),
    });
    expect(resumed.state).toBe('running');
  });

  it('throws when the task is not paused for login, is missing, or has no page reader', async () => {
    await saveTask(taskWithSteps(), dir);
    await expect(
      resumeAfterLogin('task-1', {
        tasksDir: dir,
        readPage: async () => ({ url: 'https://example.com/dashboard', text: 'heading "Dashboard"' }),
      }),
    ).rejects.toThrowError(/not paused-login/);
    await expect(
      resumeAfterLogin('missing', {
        tasksDir: dir,
        readPage: async () => ({ url: 'https://example.com/dashboard', text: 'heading "Dashboard"' }),
      }),
    ).rejects.toThrowError(/not found/);
    const paused = taskWithSteps();
    paused.state = 'paused-login';
    await saveTask(paused, dir);
    // @ts-expect-error testing the missing-reader guard at runtime
    await expect(resumeAfterLogin('task-1', { tasksDir: dir })).rejects.toThrowError(/page reader/);
  });
});

/** A host fake tools ignore; its only job is to let the runner call the snapshot tool. */
const dummyHost: ToolHost = {
  callTool: async () => {
    throw new Error('no extension in test');
  },
};

function fakeTool(
  name: string,
  calls: string[],
  result: ToolResult | Error,
  idempotent = true,
  inputSchema: z.ZodObject<z.ZodRawShape> = z.object({}).strict(),
): ToolDefinition {
  return {
    name,
    summary: `Fake ${name} for session tests`,
    description: `Test-only stand-in for ${name}.`,
    inputSchema,
    ...(idempotent ? { idempotent: true as const } : {}),
    handler: async (_host, _params) => {
      calls.push(name);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

const tabSchema = z.object({ tabId: z.number().optional() }).strict();
const navigateSchema = z.object({ url: z.string(), incognito: z.boolean().optional() }).strict();

describe('runner pauses and resumes on session expiry', () => {
  it('pauses mid-run in paused-login when a step lands on a login page after a redirect', async () => {
    const calls: string[] = [];
    const tools = new Map<string, ToolDefinition>([
      ['browser_navigate', fakeTool('browser_navigate', calls, textResult('loaded'), false, navigateSchema)],
      [
        'browser_snapshot',
        fakeTool(
          'browser_snapshot',
          calls,
          outcomeOf({ success: true, text: LOGIN_FORM_TEXT, url: 'https://example.com/login?next=%2Fdashboard', tabId: 42 }),
          true,
          tabSchema,
        ),
      ],
    ]);
    await saveTask(taskWithSteps(), dir);

    const paused = await runTask('task-1', {
      tasksDir: dir,
      tools,
      host: dummyHost,
      session: { knownLoginUrls: ['https://example.com/login'] },
    });
    expect(paused.state).toBe('paused-login');
    // The redirected step executed but never verified, so its outcome is
    // recorded as unknown for the resume to reconcile (Task 7); the step
    // after it never ran.
    expect(paused.steps[0]?.result?.status).toBe('unknown');
    expect(paused.steps[1]?.result).toBeUndefined();
    expect(calls).toEqual(['browser_navigate', 'browser_snapshot']);
    expect(paused.evidence.join('\n')).toContain('step 1 of 2');
  });

  it('pauses on expiry for a non-navigate step after resume, using the completed navigate as the redirect proof', async () => {
    const calls: string[] = [];
    const tools = new Map<string, ToolDefinition>([
      ['browser_navigate', fakeTool('browser_navigate', calls, textResult('loaded'), false, navigateSchema)],
      [
        'browser_snapshot',
        fakeTool(
          'browser_snapshot',
          calls,
          outcomeOf({ success: true, text: LOGIN_FORM_TEXT, url: 'https://example.com/login?next=%2Fdashboard', tabId: 42 }),
          true,
          tabSchema,
        ),
      ],
    ]);
    const task = taskWithSteps();
    task.steps[0]!.result = { status: 'ok', detail: 'navigated' };
    await saveTask(task, dir);

    const paused = await runTask('task-1', {
      tasksDir: dir,
      tools,
      host: dummyHost,
      session: { knownLoginUrls: ['https://example.com/login'] },
    });
    expect(paused.state).toBe('paused-login');
    expect(paused.steps[0]?.result?.status).toBe('ok');
    // The snapshot step executed but never verified, so its outcome is
    // recorded as unknown for the resume to reconcile (Task 7).
    expect(paused.steps[1]?.result?.status).toBe('unknown');
    // The completed navigate step was skipped, so only the snapshot step ran —
    // and its expiry was still proven from the navigate's target.
    expect(calls).toEqual(['browser_snapshot']);
    expect(paused.evidence.join('\n')).toContain('step 2 of 2');
  });

  it('seeds the redirect proof from the URL the last completed step verified against when no navigate completed', async () => {
    const calls: string[] = [];
    const tools = new Map<string, ToolDefinition>([
      [
        'browser_snapshot',
        fakeTool(
          'browser_snapshot',
          calls,
          outcomeOf({ success: true, text: LOGIN_FORM_TEXT, url: 'https://example.com/login?next=%2Fdashboard', tabId: 42 }),
          true,
          tabSchema,
        ),
      ],
    ]);
    const task = taskWithSteps();
    task.steps[0] = { tool: 'browser_snapshot', params: {}, verify: [{ kind: 'no-error-text', value: "isn't working" }] };
    task.steps[0]!.result = {
      status: 'ok',
      detail: 'verified 1 rule(s) at https://example.com/dashboard; snapshot=browser_snapshot tab 42; observed="heading \\"Dashboard\\""',
    };
    await saveTask(task, dir);

    const paused = await runTask('task-1', {
      tasksDir: dir,
      tools,
      host: dummyHost,
      session: { knownLoginUrls: ['https://example.com/login'] },
    });
    expect(paused.state).toBe('paused-login');
    // The snapshot step executed but never verified, so its outcome is
    // recorded as unknown for the resume to reconcile (Task 7).
    expect(paused.steps[1]?.result?.status).toBe('unknown');
    expect(calls).toEqual(['browser_snapshot']);
  });

  it('refuses a paused-login task handed to runTask directly and runs nothing', async () => {
    const calls: string[] = [];
    const tools = new Map<string, ToolDefinition>([
      ['browser_navigate', fakeTool('browser_navigate', calls, textResult('loaded'), false, navigateSchema)],
      [
        'browser_snapshot',
        fakeTool(
          'browser_snapshot',
          calls,
          outcomeOf({ success: true, text: 'heading "Dashboard"', url: 'https://example.com/dashboard', tabId: 42 }),
          true,
          tabSchema,
        ),
      ],
    ]);
    const task = taskWithSteps();
    task.steps[0]!.result = { status: 'ok', detail: 'navigated' };
    task.state = 'paused-login';
    await saveTask(task, dir);

    await expect(runTask('task-1', { tasksDir: dir, tools, host: dummyHost })).rejects.toThrowError(
      /resumeAfterLogin/,
    );
    expect(calls).toEqual([]);
    const reloaded = await loadTask('task-1', dir);
    expect(reloaded?.state).toBe('paused-login');
  });

  it('resumeAfterLogin still continues through runTask once the re-check passes', async () => {
    const calls: string[] = [];
    let phase: 'login' | 'dashboard' = 'login';
    const snapshotTool: ToolDefinition = {
      name: 'browser_snapshot',
      summary: 'Fake browser_snapshot for session tests',
      description: 'Test-only stand-in for browser_snapshot.',
      inputSchema: tabSchema,
      idempotent: true as const,
      handler: async () => {
        calls.push('browser_snapshot');
        return phase === 'login'
          ? outcomeOf({ success: true, text: LOGIN_FORM_TEXT, url: 'https://example.com/login?next=%2Fdashboard', tabId: 42 })
          : outcomeOf({ success: true, text: 'heading "Dashboard"', url: 'https://example.com/dashboard', tabId: 42 });
      },
    };
    const tools = new Map<string, ToolDefinition>([
      ['browser_navigate', fakeTool('browser_navigate', calls, textResult('loaded'), false, navigateSchema)],
      ['browser_snapshot', snapshotTool],
    ]);
    await saveTask(taskWithSteps(), dir);

    const paused = await runTask('task-1', {
      tasksDir: dir,
      tools,
      host: dummyHost,
      session: { knownLoginUrls: ['https://example.com/login'] },
    });
    expect(paused.state).toBe('paused-login');

    phase = 'dashboard';
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
    expect(resumed.steps[1]?.result?.status).toBe('ok');
    // Run 1: navigate + the verification snapshot read. Run 2: the
    // reconcile re-read of the paused navigate — its effect (being on the
    // dashboard) is confirmed, so the navigate is not re-run — then the
    // snapshot step itself.
    expect(calls).toEqual([
      'browser_navigate',
      'browser_snapshot',
      'browser_snapshot',
      'browser_snapshot',
    ]);
  });

  it('fails the step when the page is a security warning, never a login and never a success', async () => {
    const calls: string[] = [];
    const tools = new Map<string, ToolDefinition>([
      ['browser_navigate', fakeTool('browser_navigate', calls, textResult('loaded'), false, navigateSchema)],
      [
        'browser_snapshot',
        fakeTool(
          'browser_snapshot',
          calls,
          outcomeOf({ success: true, text: HTTP_WARNING_TEXT, url: 'http://arkanerp.dyndns.org/Login.aspx', tabId: 42 }),
          true,
          tabSchema,
        ),
      ],
    ]);
    await saveTask(taskWithSteps(), dir);

    const failed = await runTask('task-1', { tasksDir: dir, tools, host: dummyHost });
    expect(failed.state).toBe('failed');
    expect(failed.steps[0]?.result?.status).toBe('verify-failed');
    expect(failed.steps[0]?.result?.detail).toContain('warning-page');
    expect(failed.steps[1]?.result).toBeUndefined();
    expect(calls).toEqual(['browser_navigate', 'browser_snapshot']);
  });

  it('lets a deliberate navigation to a login page verify normally instead of pausing', async () => {
    const calls: string[] = [];
    const tools = new Map<string, ToolDefinition>([
      ['browser_navigate', fakeTool('browser_navigate', calls, textResult('loaded'), false, navigateSchema)],
      [
        'browser_snapshot',
        fakeTool(
          'browser_snapshot',
          calls,
          outcomeOf({ success: true, text: LOGIN_FORM_TEXT, url: 'https://example.com/login', tabId: 42 }),
          true,
          tabSchema,
        ),
      ],
    ]);
    await saveTask(
      {
        id: 'task-1',
        goal: 'Open the login page',
        constraints: ['read-only'],
        steps: [
          { tool: 'browser_navigate', params: { url: 'https://example.com/login' }, verify: [{ kind: 'url-contains', value: 'example.com/login' }] },
        ],
        state: 'planned',
        evidence: [],
      },
      dir,
    );

    const done = await runTask('task-1', {
      tasksDir: dir,
      tools,
      host: dummyHost,
      session: { knownLoginUrls: ['https://example.com/login'] },
    });
    expect(done.state).toBe('done');
    expect(calls).toEqual(['browser_navigate', 'browser_snapshot']);
  });
});

/**
 * Gap B (plan §3): post-fill username check before submit + replace-login
 * warning. The snapshot lines below are the real accessibility-tree shape
 * (`extension/handlers/snapshot-page.js`): a textbox line carries its
 * filled value as `value="…"`, and the password value is redacted to `••••`
 * by the snapshot itself — the check must never read it.
 */
const FILLED_WRONG_TEXT =
  '- textbox "Email" [ref=e1] value="wrong@example.com"\n' +
  '- textbox "Password" [ref=e2] value="••••"\n' +
  '- button "Sign in" [ref=e3]';
const FILLED_RIGHT_TEXT =
  '- textbox "Email" [ref=e1] value="owner@example.com"\n' +
  '- textbox "Password" [ref=e2] value="••••"\n' +
  '- button "Sign in" [ref=e3]';
const FILLED_NO_VALUE_TEXT =
  '- textbox "Email" [ref=e1]\n- textbox "Password" [ref=e2]\n- button "Sign in" [ref=e3]';
const FILLED_CHANGED_TEXT =
  '- textbox "Email" [ref=e1] value="changed@example.com"\n' +
  '- textbox "Password" [ref=e2] value="••••"\n' +
  '- button "Sign in" [ref=e3]';

describe('login-check helpers', () => {
  it('reads the username field value from the snapshot, never the password value', () => {
    expect(extractFilledUsername({ url: 'https://example.com/login', text: FILLED_WRONG_TEXT })).toBe(
      'wrong@example.com',
    );
    // A page with only a password field has no username to read — and the
    // password value itself must never come back as the "filled account".
    expect(
      extractFilledUsername({
        url: 'https://example.com/login',
        text: '- textbox "Password" [ref=e2] value="hunter2"\n- button "Sign in" [ref=e3]',
      }),
    ).toBeUndefined();
    expect(extractFilledUsername({ url: 'https://example.com/login', text: FILLED_NO_VALUE_TEXT })).toBeUndefined();
    // Flags after the value, and the short `[e1]` ref form, do not hide it.
    expect(
      extractFilledUsername({
        url: 'https://example.com/login',
        text: '- textbox "Username" [e1] value="flagged@example.com" disabled',
      }),
    ).toBe('flagged@example.com');
  });

  it('compares the filled account against the expected account', () => {
    const snapshot = { url: 'https://example.com/login', text: FILLED_WRONG_TEXT };
    expect(checkFilledAccount(snapshot, 'owner@example.com').status).toBe('mismatch');
    expect(checkFilledAccount(snapshot, 'wrong@example.com').status).toBe('match');
    expect(checkFilledAccount(snapshot, '  Wrong@Example.com ').status).toBe('match');
    expect(checkFilledAccount(snapshot, undefined).status).toBe('unknown');
    expect(checkFilledAccount({ url: 'https://example.com/login', text: FILLED_NO_VALUE_TEXT }, 'owner@example.com').status).toBe('unknown');
  });

  it('recognises submit steps: Enter / submit:true / a sign-in click — and nothing else', () => {
    expect(isSubmitStep({ tool: 'browser_type', params: { key: 'Enter' }, verify: [] })).toBe(true);
    expect(isSubmitStep({ tool: 'browser_type', params: { submit: true }, verify: [] })).toBe(true);
    expect(isSubmitStep({ tool: 'browser_type', params: { key: 'a' }, verify: [] })).toBe(false);
    expect(
      isSubmitStep({ tool: 'browser_click', params: { target: { role: 'button', name: 'Sign in' } }, verify: [] }),
    ).toBe(true);
    expect(
      isSubmitStep({ tool: 'browser_click', params: { target: { role: 'button', name: 'Cancel' } }, verify: [] }),
    ).toBe(false);
    expect(
      isSubmitStep({ tool: 'browser_click', params: { target: { role: 'button', name: 'Sign in' }, hover: true }, verify: [] }),
    ).toBe(false);
    expect(isSubmitStep({ tool: 'browser_snapshot', params: {}, verify: [] })).toBe(false);
  });

  it('resolves a string click target against the snapshot, treats Return as Enter, and treats a scripted evaluate as a submit', () => {
    const snapshot = { url: 'https://example.com/login', text: FILLED_WRONG_TEXT };
    // "e3" is the Sign in button in this snapshot; "e1" is the Email textbox.
    expect(
      isSubmitStep({ tool: 'browser_click', params: { target: 'e3' }, verify: [] }, snapshot),
    ).toBe(true);
    expect(
      isSubmitStep({ tool: 'browser_click', params: { target: 'e1' }, verify: [] }, snapshot),
    ).toBe(false);
    // A ref the snapshot does not name could still be the submit control,
    // so it fails safe as a submit — and so does a string target with no
    // snapshot to resolve it against.
    expect(
      isSubmitStep({ tool: 'browser_click', params: { target: 'e9' }, verify: [] }, snapshot),
    ).toBe(true);
    expect(isSubmitStep({ tool: 'browser_click', params: { target: 'e3' }, verify: [] })).toBe(true);
    expect(
      isSubmitStep({ tool: 'browser_click', params: { target: 'e3', hover: true }, verify: [] }, snapshot),
    ).toBe(false);
    // "Return" is the same key as Enter on the other keyboard layout, in a
    // combo or on its own; a scripted step can submit the form too.
    expect(isSubmitStep({ tool: 'browser_type', params: { key: 'Return' }, verify: [] })).toBe(true);
    expect(isSubmitStep({ tool: 'browser_type', params: { key: 'Control+Return' }, verify: [] })).toBe(true);
    expect(isSubmitStep({ tool: 'browser_evaluate', params: { expression: 'document.querySelector("form").submit()' }, verify: [] })).toBe(true);
    expect(isSubmitStep({ tool: 'browser_evaluate', params: { expression: 'document.title' }, verify: [] })).toBe(true);
  });

  it('finds the latest completed fill before a submit, verified or not, and remembers which account an approval covered', () => {
    const task = loginTask('owner@example.com');
    task.steps[1]!.result = { status: 'ok', detail: 'filled' };
    expect(latestFillIndex(task, 2)).toBe(1);
    expect(latestFillIndex(task, 1)).toBeUndefined();
    expect(latestFillIndex(task)).toBe(1);
    expect(hasLoginApproval(task, 1)).toBe(false);
    expect(approvedAccountOf(task, 1)).toBeUndefined();
    task.constraints.push(loginApprovedConstraint(1), loginApprovedAccountConstraint(1, 'wrong@example.com'));
    expect(hasLoginApproval(task, 1)).toBe(true);
    expect(approvedAccountOf(task, 1)).toBe('wrong@example.com');
    // A later approval for a different filled account supersedes the first.
    task.constraints.push(loginApprovedAccountConstraint(1, 'changed@example.com'));
    expect(approvedAccountOf(task, 1)).toBe('changed@example.com');
    // An approval given while the filled account was unreadable records an empty account.
    const unreadTask = loginTask('owner@example.com');
    unreadTask.constraints.push(loginApprovedAccountConstraint(1, undefined));
    expect(approvedAccountOf(unreadTask, 1)).toBe('');
  });

  it('finds a saved login under a different username, and none for the same username', () => {
    const saved = [{ username: 'saved@example.com' }];
    expect(findDifferentSavedLogin(saved, 'saved@example.com')).toBeUndefined();
    expect(findDifferentSavedLogin(saved, 'other@example.com')).toBe('saved@example.com');
    expect(findDifferentSavedLogin(saved, undefined)).toBe('saved@example.com');
    expect(findDifferentSavedLogin([], 'other@example.com')).toBeUndefined();
  });
});

/** The runner's injected ask: the real askQuestion, sending on a fake channel. */
function runnerAsk(sent: Array<{ type: string; question: Question }>) {
  return async (input: {
    taskId: string;
    text: string;
    options?: string[];
    kind: 'confirm' | 'choice' | 'text';
    context?: QuestionContext;
  }): Promise<Question> =>
    askQuestion(input.taskId, input.text, input.options, {
      tasksDir: dir,
      kind: input.kind,
      context: input.context,
      send: async (message) => {
        sent.push(message);
      },
    });
}

const vaultSchema = z
  .object({
    action: z.enum(['fill', 'save_login', 'list', 'status', 'unlock']),
    tabId: z.number().optional(),
    handle: z.string().optional(),
    label: z.string().optional(),
  })
  .strict();
const typeSchema = z
  .object({
    tabId: z.number().optional(),
    key: z.string().optional(),
    submit: z.boolean().optional(),
    text: z.string().optional(),
  })
  .strict();
const clickSchema = z
  .object({
    tabId: z.number().optional(),
    target: targetParam,
    hover: z.boolean().optional(),
  })
  .strict();

/** Fake tools for a login task: navigate, snapshot (fixed filled-form text), vault, Enter-submit. */
function loginTaskTools(calls: string[], snapshotText: string, saved: Array<{ username: string }> = []): Map<string, ToolDefinition> {
  const vault: ToolDefinition = {
    name: 'browser_vault',
    summary: 'Fake browser_vault for login-check tests',
    description: 'Test-only stand-in for browser_vault.',
    inputSchema: vaultSchema,
    handler: async (_host, params) => {
      calls.push(`browser_vault:${String(params.action)}`);
      if (params.action === 'list') {
        return outcomeOf({
          success: true,
          origin: 'https://example.com',
          accounts: saved.map((entry) => ({ identifier: entry.username, handle: 'cred_handle', origin: 'https://example.com' })),
        });
      }
      return textResult('vault ok');
    },
  };
  return new Map<string, ToolDefinition>([
    ['browser_navigate', fakeTool('browser_navigate', calls, textResult('loaded'), false, navigateSchema)],
    [
      'browser_snapshot',
      fakeTool(
        'browser_snapshot',
        calls,
        outcomeOf({ success: true, text: snapshotText, url: 'https://example.com/login', tabId: 42 }),
        true,
        tabSchema,
      ),
    ],
    ['browser_vault', vault],
    ['browser_type', fakeTool('browser_type', calls, textResult('typed'), false, typeSchema)],
  ]);
}

function loginTask(expectedAccount?: string): Task {
  return {
    id: 'task-1',
    goal: 'Log in as the owner and open the dashboard',
    constraints: ['allow-mutations'],
    steps: [
      { tool: 'browser_navigate', params: { url: 'https://example.com/login' }, verify: [{ kind: 'url-contains', value: 'example.com/login' }] },
      {
        tool: 'browser_vault',
        params: {
          action: 'fill',
          handle: 'cred_handle',
          tabId: 42,
          ...(expectedAccount !== undefined ? { expectedAccount } : {}),
        },
        verify: [{ kind: 'text-present', value: 'Sign in' }],
      },
      { tool: 'browser_type', params: { key: 'Enter', tabId: 42 }, verify: [{ kind: 'no-error-text', value: "isn't working" }] },
    ],
    state: 'planned',
    evidence: [],
  };
}

describe('runner post-fill username check', () => {
  it('pauses before submit when the vault filled a different account than the task expected', async () => {
    const calls: string[] = [];
    const sent: Array<{ type: string; question: Question }> = [];
    const tools = loginTaskTools(calls, FILLED_WRONG_TEXT);
    await saveTask(loginTask('owner@example.com'), dir);

    const paused = await runTask('task-1', {
      tasksDir: dir,
      tools,
      host: dummyHost,
      questions: { ask: runnerAsk(sent) },
    });
    expect(paused.state).toBe('paused-question');
    // The fill ran, the submit never did.
    expect(calls).toContain('browser_vault:fill');
    expect(calls).not.toContain('browser_type');
    expect(paused.steps[1]?.result?.status).toBe('ok');
    expect(paused.steps[2]?.result).toBeUndefined();
    expect(sent).toHaveLength(1);
    const question = sent[0]!.question;
    expect(question.kind).toBe('confirm');
    expect(question.options).toEqual(['proceed', 'stop']);
    expect(question.text).toContain('wrong@example.com');
    expect(question.text).toContain('owner@example.com');
    expect(question.context?.purpose).toBe('login-check');
    expect(question.context?.filledAccount).toBe('wrong@example.com');
    expect(question.context?.expectedAccount).toBe('owner@example.com');
    expect(question.context?.fillStepIndex).toBe(1);
  });

  it('lets a matching fill through to submit and records the verified constraint', async () => {
    const calls: string[] = [];
    const sent: Array<{ type: string; question: Question }> = [];
    const tools = loginTaskTools(calls, FILLED_RIGHT_TEXT);
    await saveTask(loginTask('owner@example.com'), dir);

    const done = await runTask('task-1', {
      tasksDir: dir,
      tools,
      host: dummyHost,
      questions: { ask: runnerAsk(sent) },
    });
    expect(done.state).toBe('done');
    expect(calls).toContain('browser_type');
    expect(sent).toEqual([]);
    expect(done.constraints).toContain(loginVerifiedConstraint(1));
  });

  it('pauses and asks to confirm the filled account when the task declares no expected account', async () => {
    const calls: string[] = [];
    const sent: Array<{ type: string; question: Question }> = [];
    const tools = loginTaskTools(calls, FILLED_WRONG_TEXT);
    await saveTask(loginTask(), dir);

    const paused = await runTask('task-1', {
      tasksDir: dir,
      tools,
      host: dummyHost,
      questions: { ask: runnerAsk(sent) },
    });
    expect(paused.state).toBe('paused-question');
    expect(calls).not.toContain('browser_type');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.question.text).toContain('wrong@example.com');
    expect(sent[0]!.question.context?.purpose).toBe('login-check');
  });

  it('pauses when the filled username cannot be read from the snapshot', async () => {
    const calls: string[] = [];
    const sent: Array<{ type: string; question: Question }> = [];
    const tools = loginTaskTools(calls, FILLED_NO_VALUE_TEXT);
    await saveTask(loginTask('owner@example.com'), dir);

    const paused = await runTask('task-1', {
      tasksDir: dir,
      tools,
      host: dummyHost,
      questions: { ask: runnerAsk(sent) },
    });
    expect(paused.state).toBe('paused-question');
    expect(calls).not.toContain('browser_type');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.question.text).toContain('owner@example.com');
  });

  it('a "proceed" answer resumes from the submit step without re-running the fill', async () => {
    const calls: string[] = [];
    const sent: Array<{ type: string; question: Question }> = [];
    const tools = loginTaskTools(calls, FILLED_WRONG_TEXT);
    await saveTask(loginTask('owner@example.com'), dir);

    const paused = await runTask('task-1', {
      tasksDir: dir,
      tools,
      host: dummyHost,
      questions: { ask: runnerAsk(sent) },
    });
    expect(paused.state).toBe('paused-question');

    const done = await answerQuestion(sent[0]!.question.id, 'proceed', {
      tasksDir: dir,
      continueWith: async (task) =>
        runTask(task.id, {
          tasksDir: dir,
          tools,
          host: dummyHost,
          questions: { ask: runnerAsk(sent) },
        }),
    });
    expect(done.state).toBe('done');
    expect(calls.filter((call) => call === 'browser_vault:fill')).toHaveLength(1);
    expect(calls.filter((call) => call === 'browser_type')).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(done.constraints).toContain(loginApprovedConstraint(1));
  });

  it('a "stop" answer fails the task with evidence naming both accounts, and the fill result stays ok', async () => {
    const calls: string[] = [];
    const sent: Array<{ type: string; question: Question }> = [];
    const tools = loginTaskTools(calls, FILLED_WRONG_TEXT);
    await saveTask(loginTask('owner@example.com'), dir);

    const paused = await runTask('task-1', {
      tasksDir: dir,
      tools,
      host: dummyHost,
      questions: { ask: runnerAsk(sent) },
    });
    expect(paused.state).toBe('paused-question');

    const continued: Task[] = [];
    const failed = await answerQuestion(sent[0]!.question.id, 'stop', {
      tasksDir: dir,
      continueWith: async (task) => {
        continued.push(task);
        return task;
      },
    });
    expect(failed.state).toBe('failed');
    expect(continued).toEqual([]);
    expect(calls).not.toContain('browser_type');
    // The fill itself happened — only the submit was stopped — so its
    // recorded result is not rewritten as a failure.
    expect(failed.steps[1]?.result?.status).toBe('ok');
    expect(failed.evidence.join('\n')).toContain('wrong@example.com');
    expect(failed.evidence.join('\n')).toContain('owner@example.com');
  });

  it('fails closed instead of submitting when no question channel is wired', async () => {
    const calls: string[] = [];
    const tools = loginTaskTools(calls, FILLED_WRONG_TEXT);
    await saveTask(loginTask('owner@example.com'), dir);

    const failed = await runTask('task-1', { tasksDir: dir, tools, host: dummyHost });
    expect(failed.state).toBe('failed');
    expect(calls).not.toContain('browser_type');
    expect(failed.evidence.join('\n')).toContain('wrong@example.com');
    expect(failed.evidence.join('\n')).toContain('owner@example.com');
  });

  it('the submit gate re-checks a fill that completed without a check (e.g. reconciled) before submitting', async () => {
    const calls: string[] = [];
    const sent: Array<{ type: string; question: Question }> = [];
    const tools = loginTaskTools(calls, FILLED_WRONG_TEXT);
    // The fill already ran ok in an earlier run, with no verified or
    // approved constraint recorded for it — the submit must still not run
    // until the filled account is checked.
    const task = loginTask('owner@example.com');
    task.steps[0]!.result = {
      status: 'ok',
      detail: 'verified 1 rule(s) at https://example.com/login; snapshot=browser_snapshot tab 42; observed="heading \\"Login\\""',
    };
    task.steps[1]!.result = { status: 'ok', detail: 'filled' };
    await saveTask(task, dir);

    const paused = await runTask('task-1', {
      tasksDir: dir,
      tools,
      host: dummyHost,
      questions: { ask: runnerAsk(sent) },
    });
    expect(paused.state).toBe('paused-question');
    expect(calls).not.toContain('browser_type');
    expect(calls).not.toContain('browser_vault:fill');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.question.context?.purpose).toBe('login-check');
  });

  it('the submit gate stops a string-target Sign-in click after a reconciled fill — never submits unchecked', async () => {
    const calls: string[] = [];
    const sent: Array<{ type: string; question: Question }> = [];
    const tools = loginTaskTools(calls, FILLED_WRONG_TEXT);
    tools.set('browser_click', fakeTool('browser_click', calls, textResult('clicked'), false, clickSchema));
    // The fill already ran ok in an earlier run, with no verified or
    // approved constraint recorded for it — and the submit is a click by
    // ref ("e3"), not by role/name, so the gate must resolve the ref
    // against the snapshot instead of letting the click through.
    const task = loginTask('owner@example.com');
    task.steps[0]!.result = {
      status: 'ok',
      detail: 'verified 1 rule(s) at https://example.com/login; snapshot=browser_snapshot tab 42; observed="heading \\"Login\\""',
    };
    task.steps[1]!.result = { status: 'ok', detail: 'filled' };
    task.steps[2] = {
      tool: 'browser_click',
      params: { target: 'e3', tabId: 42 },
      verify: [{ kind: 'text-present', value: 'Sign in' }],
    };
    await saveTask(task, dir);

    const paused = await runTask('task-1', {
      tasksDir: dir,
      tools,
      host: dummyHost,
      questions: { ask: runnerAsk(sent) },
    });
    expect(paused.state).toBe('paused-question');
    expect(calls).not.toContain('browser_click');
    expect(calls).not.toContain('browser_vault:fill');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.question.context?.purpose).toBe('login-check');
    expect(sent[0]!.question.text).toContain('wrong@example.com');
    expect(sent[0]!.question.text).toContain('owner@example.com');
  });

  it('an intervening step that changes the username field after a verified check makes the submit gate re-check and pause', async () => {
    const calls: string[] = [];
    const sent: Array<{ type: string; question: Question }> = [];
    // The snapshot follows the page: it shows the matching account after
    // the fill, and the changed account once a type step rewrites the
    // username field — the submit gate must read the changed value, not
    // trust the verified constraint recorded after the fill.
    let currentText = FILLED_RIGHT_TEXT;
    const tools = loginTaskTools(calls, FILLED_RIGHT_TEXT);
    tools.set('browser_snapshot', {
      name: 'browser_snapshot',
      summary: 'Fake browser_snapshot for the intervening-change test',
      description: 'Test-only stand-in for browser_snapshot.',
      inputSchema: tabSchema,
      idempotent: true as const,
      handler: async () => {
        calls.push('browser_snapshot');
        return outcomeOf({ success: true, text: currentText, url: 'https://example.com/login', tabId: 42 });
      },
    });
    tools.set('browser_type', {
      name: 'browser_type',
      summary: 'Fake browser_type for the intervening-change test',
      description: 'Test-only stand-in for browser_type.',
      inputSchema: typeSchema,
      handler: async (_host, params) => {
        calls.push('browser_type');
        if (typeof params.text === 'string') currentText = FILLED_CHANGED_TEXT;
        return textResult('typed');
      },
    });
    const task = loginTask('owner@example.com');
    task.steps[2] = {
      tool: 'browser_type',
      params: { text: 'changed@example.com', tabId: 42 },
      verify: [{ kind: 'no-error-text', value: "isn't working" }],
    };
    task.steps.push({
      tool: 'browser_type',
      params: { key: 'Enter', tabId: 42 },
      verify: [{ kind: 'no-error-text', value: "isn't working" }],
    });
    await saveTask(task, dir);

    const paused = await runTask('task-1', {
      tasksDir: dir,
      tools,
      host: dummyHost,
      questions: { ask: runnerAsk(sent) },
    });
    expect(paused.state).toBe('paused-question');
    // The post-fill check passed (the fill matched), and only the
    // intervening type ran — the Enter submit never did.
    expect(paused.constraints).toContain(loginVerifiedConstraint(1));
    expect(paused.steps[1]?.result?.status).toBe('ok');
    expect(calls.filter((call) => call === 'browser_type')).toHaveLength(1);
    expect(paused.steps[3]?.result).toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.question.context?.purpose).toBe('login-check');
    expect(sent[0]!.question.text).toContain('changed@example.com');
    expect(sent[0]!.question.text).toContain('owner@example.com');
  });

  it('a "stop" answer on a fill-last task fails it without rewriting the fill result', async () => {
    const calls: string[] = [];
    const sent: Array<{ type: string; question: Question }> = [];
    const tools = loginTaskTools(calls, FILLED_WRONG_TEXT);
    const task = loginTask('owner@example.com');
    task.steps = task.steps.slice(0, 2);
    await saveTask(task, dir);

    const paused = await runTask('task-1', {
      tasksDir: dir,
      tools,
      host: dummyHost,
      questions: { ask: runnerAsk(sent) },
    });
    expect(paused.state).toBe('paused-question');

    const failed = await answerQuestion(sent[0]!.question.id, 'stop', { tasksDir: dir });
    expect(failed.state).toBe('failed');
    expect(failed.steps[1]?.result?.status).toBe('ok');
    expect(failed.evidence.join('\n')).toContain('wrong@example.com');
    expect(failed.evidence.join('\n')).toContain('owner@example.com');
  });
});

function saveLoginTask(): Task {
  return {
    id: 'task-1',
    goal: 'Save the login for this site',
    constraints: ['allow-mutations'],
    steps: [
      { tool: 'browser_navigate', params: { url: 'https://example.com/login' }, verify: [{ kind: 'url-contains', value: 'example.com/login' }] },
      { tool: 'browser_vault', params: { action: 'save_login', tabId: 42 }, verify: [{ kind: 'text-present', value: 'Sign in' }] },
    ],
    state: 'planned',
    evidence: [],
  };
}

describe('runner replace-login warning', () => {
  it('pauses before saving over a different saved account, names it, and never saves until answered', async () => {
    const calls: string[] = [];
    const sent: Array<{ type: string; question: Question }> = [];
    const tools = loginTaskTools(calls, FILLED_WRONG_TEXT);
    await saveTask(saveLoginTask(), dir);

    const paused = await runTask('task-1', {
      tasksDir: dir,
      tools,
      host: dummyHost,
      questions: { ask: runnerAsk(sent) },
      vault: { listAccounts: async () => [{ username: 'saved@example.com' }] },
    });
    expect(paused.state).toBe('paused-question');
    expect(calls).not.toContain('browser_vault:save_login');
    expect(sent).toHaveLength(1);
    const question = sent[0]!.question;
    expect(question.kind).toBe('confirm');
    expect(question.options).toEqual(['yes', 'no']);
    expect(question.text).toContain('saved@example.com');
    expect(question.context?.purpose).toBe('replace-login');
    expect(question.context?.existingAccount).toBe('saved@example.com');
  });

  it('a "yes" answer resumes and saves exactly once; a "no" fails without saving', async () => {
    const calls: string[] = [];
    const sent: Array<{ type: string; question: Question }> = [];
    const tools = loginTaskTools(calls, FILLED_WRONG_TEXT);
    await saveTask(saveLoginTask(), dir);
    const listAccounts = async () => [{ username: 'saved@example.com' }];

    const paused = await runTask('task-1', {
      tasksDir: dir,
      tools,
      host: dummyHost,
      questions: { ask: runnerAsk(sent) },
      vault: { listAccounts },
    });
    expect(paused.state).toBe('paused-question');

    const done = await answerQuestion(sent[0]!.question.id, 'yes', {
      tasksDir: dir,
      continueWith: async (task) =>
        runTask(task.id, {
          tasksDir: dir,
          tools,
          host: dummyHost,
          questions: { ask: runnerAsk(sent) },
          vault: { listAccounts },
        }),
    });
    expect(done.state).toBe('done');
    expect(calls.filter((call) => call === 'browser_vault:save_login')).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(done.constraints).toContain(replaceApprovedConstraint(1));

    // The "no" branch, on a fresh task: the save never runs.
    const calls2: string[] = [];
    const sent2: Array<{ type: string; question: Question }> = [];
    const task2 = saveLoginTask();
    task2.id = 'task-2';
    await saveTask(task2, dir);
    const paused2 = await runTask('task-2', {
      tasksDir: dir,
      tools: loginTaskTools(calls2, FILLED_WRONG_TEXT),
      host: dummyHost,
      questions: { ask: runnerAsk(sent2) },
      vault: { listAccounts },
    });
    expect(paused2.state).toBe('paused-question');
    const continued: Task[] = [];
    const failed = await answerQuestion(sent2[0]!.question.id, 'no', {
      tasksDir: dir,
      continueWith: async (task) => {
        continued.push(task);
        return task;
      },
    });
    expect(failed.state).toBe('failed');
    expect(continued).toEqual([]);
    expect(calls2).not.toContain('browser_vault:save_login');
    expect(failed.evidence.join('\n')).toContain('saved@example.com');
  });

  it('saves without asking when the saved login is the same username', async () => {
    const calls: string[] = [];
    const sent: Array<{ type: string; question: Question }> = [];
    const tools = loginTaskTools(calls, FILLED_WRONG_TEXT);
    await saveTask(saveLoginTask(), dir);

    const done = await runTask('task-1', {
      tasksDir: dir,
      tools,
      host: dummyHost,
      questions: { ask: runnerAsk(sent) },
      vault: { listAccounts: async () => [{ username: 'wrong@example.com' }] },
    });
    expect(done.state).toBe('done');
    expect(calls).toContain('browser_vault:save_login');
    expect(sent).toEqual([]);
  });

  it('saves without asking when nothing is saved for the origin', async () => {
    const calls: string[] = [];
    const sent: Array<{ type: string; question: Question }> = [];
    const tools = loginTaskTools(calls, FILLED_WRONG_TEXT);
    await saveTask(saveLoginTask(), dir);

    const done = await runTask('task-1', {
      tasksDir: dir,
      tools,
      host: dummyHost,
      questions: { ask: runnerAsk(sent) },
      vault: { listAccounts: async () => [] },
    });
    expect(done.state).toBe('done');
    expect(calls).toContain('browser_vault:save_login');
    expect(sent).toEqual([]);
  });

  it('lists the saved logins through the vault tool itself when no lister is injected', async () => {
    const calls: string[] = [];
    const sent: Array<{ type: string; question: Question }> = [];
    const tools = loginTaskTools(calls, FILLED_WRONG_TEXT, [{ username: 'saved@example.com' }]);
    await saveTask(saveLoginTask(), dir);

    const paused = await runTask('task-1', {
      tasksDir: dir,
      tools,
      host: dummyHost,
      questions: { ask: runnerAsk(sent) },
    });
    expect(paused.state).toBe('paused-question');
    expect(calls).toContain('browser_vault:list');
    expect(calls).not.toContain('browser_vault:save_login');
    expect(sent[0]!.question.text).toContain('saved@example.com');
  });
});
