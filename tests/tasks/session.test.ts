import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { detectSession, pauseForLogin, resumeAfterLogin } from '../../mcp-server/src/tasks/session.js';
import type { SessionPage } from '../../mcp-server/src/tasks/session.js';
import { loadTask, saveTask } from '../../mcp-server/src/tasks/store.js';
import { saveTaskWithReport } from '../../mcp-server/src/tasks/reporting.js';
import { runTask } from '../../mcp-server/src/tasks/runner.js';
import type { Task } from '../../mcp-server/src/tasks/types.js';
import type { ToolDefinition, ToolHost, ToolResult } from '../../mcp-server/src/tools/types.js';
import { outcomeOf, textResult } from '../../mcp-server/src/tools/types.js';

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
