import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { loadTask, saveTask } from '../../mcp-server/src/tasks/store.js';
import { runTask } from '../../mcp-server/src/tasks/runner.js';
import type { RunTaskOptions } from '../../mcp-server/src/tasks/runner.js';
import { resumeAfterLogin } from '../../mcp-server/src/tasks/session.js';
import { askQuestion, answerQuestion } from '../../mcp-server/src/tasks/questions.js';
import { listPendingQuestions } from '../../mcp-server/src/tasks/question-store.js';
import { runTaskWithReport } from '../../mcp-server/src/tasks/wiring.js';
import type { Task } from '../../mcp-server/src/tasks/types.js';
import type { ToolDefinition, ToolHost, ToolResult } from '../../mcp-server/src/tools/types.js';
import { outcomeOf } from '../../mcp-server/src/tools/types.js';

const repoRoot = path.join(import.meta.dirname, '..', '..');
const FIXTURE_PATH = path.join(repoRoot, 'scripts', 'pages', 'task-fixture.html');

/**
 * End-to-end audit task on the local fixture (specs/011, Task 10).
 *
 * The fixture (`scripts/pages/task-fixture.html`) is one page with three
 * views — a login form, an audit dashboard with numeric values, and an
 * error page — plus the "End session" and "Include archived records"
 * controls. In a real browser it is served over http at path-distinct
 * routes (`/task-fixture/login`, `/task-fixture/dashboard`,
 * `/task-fixture/error`): the session agent's login-URL matcher strips
 * query and fragment (`session.ts`, `withoutQuery`), so hash-only views
 * (`#login` vs `#dashboard` on one file URL) cannot be told apart and
 * the dashboard would read as a login page. The fixture's script routes
 * on the pathname first and falls back to the hash, so opening the file
 * directly still works.
 *
 * This test serves the real fixture file on a real ephemeral http server
 * (the same pattern `scripts/smoke-real-chrome.mjs` uses for
 * `scripts/pages/drag-and-drop.html`), and drives the task through fake
 * tools whose snapshot text mirrors the fixture's views line for line —
 * the same fake-tool seam every task test uses. What the fakes cannot
 * prove (a real browser rendering the fixture, a real extension snapshot
 * carrying `raw.url`) stays a parked live-Chrome check; see the Task 10
 * report.
 *
 * The popup is deliberately NOT asserted here: Task 9's panels show only
 * what the popup itself has seen (pending questions), and no task-list
 * or evidence-report endpoint reaches the popup yet. The test below pins
 * that limit, and asserts task state and the evidence report server-side
 * only (`loadTask` / `runTaskWithReport`), never through the popup.
 */

/** A host fake tools ignore; its only job is to let the runner call tools. */
const dummyHost: ToolHost = {
  callTool: async () => {
    throw new Error('no extension in test');
  },
};

/** The login form, as the fixture's login view renders it in a snapshot. */
const LOGIN_FORM_TEXT =
  'heading "Audit fixture — Sign in"\n' +
  '- textbox "Email" [ref=e1]\n' +
  '- textbox "Password" [ref=e2]\n' +
  '- button "Sign in" [ref=e3]';

/** The dashboard, as the fixture's dashboard view renders it in a snapshot. */
function dashboardText(archivedShown: boolean): string {
  return (
    'heading "Audit fixture — Dashboard"\n' +
    '- text "Balance: 1,234.56"\n' +
    '- text "Invoices: 42"\n' +
    '- text "Account code: ABC-123"\n' +
    (archivedShown ? '- text "Archived records: 7"\n' : '') +
    '- button "End session" [ref=e4]\n' +
    '- button "Include archived records" [ref=e5]\n' +
    '- link "Show the error page" [ref=e6]'
  );
}

/** The error page, as the fixture's error view renders it in a snapshot. */
const ERROR_TEXT =
  'heading "This page isn\'t working"\n' +
  '- text "task-fixture.html didn\'t send any data."\n' +
  '- text "ERR_CONNECTION_RESET"';

/** The fixture page as a fake browser sees it: one view at a time. */
type FixtureView = 'login' | 'dashboard' | 'error';

class FakeFixtureBrowser {
  view: FixtureView = 'login';
  archivedShown = false;
  sessionValid = false;
  /** Flip the session to expired on this snapshot read (1-based), then never again. */
  expireOnSnapshotRead: number | null = null;
  snapshotReads = 0;
  calls: string[] = [];
  snapshotTabIds: Array<number | undefined> = [];

  constructor(
    private readonly urls: { login: string; dashboard: string; error: string },
  ) {}

  /** The user completes login by takeover: the session is valid again. */
  login(): void {
    this.view = 'dashboard';
    this.sessionValid = true;
    this.expireOnSnapshotRead = null;
  }

  private snapshotForView(): { text: string; url: string } {
    switch (this.view) {
      case 'login':
        return { text: LOGIN_FORM_TEXT, url: this.urls.login };
      case 'dashboard':
        return { text: dashboardText(this.archivedShown), url: this.urls.dashboard };
      case 'error':
        return { text: ERROR_TEXT, url: this.urls.error };
    }
  }

  navigate(url: string): ToolResult {
    this.calls.push('browser_navigate');
    if (url === this.urls.dashboard) {
      this.view = 'dashboard';
      this.sessionValid = true;
    } else if (url === this.urls.login) {
      this.view = 'login';
      this.sessionValid = false;
    } else if (url === this.urls.error) {
      this.view = 'error';
    }
    return outcomeOf({ success: true, text: 'loaded', url, tabId: 42 });
  }

  snapshot(params: Record<string, unknown>): ToolResult {
    this.calls.push('browser_snapshot');
    this.snapshotReads += 1;
    this.snapshotTabIds.push(typeof params.tabId === 'number' ? params.tabId : undefined);
    // The session ends mid-task: from this read on, the site bounces the
    // task back to its login page.
    if (this.expireOnSnapshotRead !== null && this.snapshotReads >= this.expireOnSnapshotRead) {
      this.view = 'login';
      this.sessionValid = false;
      this.expireOnSnapshotRead = null;
    }
    const page = this.snapshotForView();
    return outcomeOf({ success: true, text: page.text, url: page.url, tabId: 42 });
  }

  click(params: Record<string, unknown>): ToolResult {
    this.calls.push('browser_click');
    if (params.target === 'include-archived') this.archivedShown = true;
    if (params.target === 'end-session') {
      this.view = 'login';
      this.sessionValid = false;
    }
    return outcomeOf({ success: true, text: 'clicked', url: this.snapshotForView().url, tabId: 42 });
  }
}

const tabSchema = z.object({ tabId: z.number().optional(), maxChars: z.number().optional() }).strict();
const navigateSchema = z
  .object({ url: z.string(), tabId: z.number().optional(), incognito: z.boolean().optional() })
  .strict();
const clickSchema = z.object({ target: z.string(), tabId: z.number().optional() }).strict();

function fixtureTools(browser: FakeFixtureBrowser): Map<string, ToolDefinition> {
  const navigate: ToolDefinition = {
    name: 'browser_navigate',
    summary: 'Fake browser_navigate for the e2e audit task test',
    description: 'Test-only stand-in for browser_navigate.',
    inputSchema: navigateSchema,
    handler: async (_host, params) => browser.navigate(String(params.url)),
  };
  const snapshot: ToolDefinition = {
    name: 'browser_snapshot',
    summary: 'Fake browser_snapshot for the e2e audit task test',
    description: 'Test-only stand-in for browser_snapshot.',
    inputSchema: tabSchema,
    idempotent: true as const,
    handler: async (_host, params) => browser.snapshot(params),
  };
  const click: ToolDefinition = {
    name: 'browser_click',
    summary: 'Fake browser_click for the e2e audit task test',
    description: 'Test-only stand-in for browser_click.',
    inputSchema: clickSchema,
    handler: async (_host, params) => browser.click(params),
  };
  return new Map([
    ['browser_navigate', navigate],
    ['browser_snapshot', snapshot],
    ['browser_click', click],
  ]);
}

let dir: string;
let server: http.Server;
let baseUrl: string;
let loginUrl: string;
let dashboardUrl: string;
let errorUrl: string;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-tasks-e2e-audit-'));
  // Serve the real fixture file at path-distinct routes, as the smoke
  // script serves scripts/pages/drag-and-drop.html.
  server = http.createServer((req, res) => {
    const url = req.url ?? '';
    if (url === '/task-fixture/login' || url === '/task-fixture/dashboard' || url === '/task-fixture/error') {
      // Read first: answering 200 before the read would leave a missing
      // fixture hanging the response (headers already sent, no body).
      let html: string | null;
      try {
        html = fs.readFileSync(FIXTURE_PATH, 'utf8');
      } catch {
        html = null;
      }
      if (html === null) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('fixture missing');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture server did not listen');
  baseUrl = `http://127.0.0.1:${address.port}`;
  loginUrl = `${baseUrl}/task-fixture/login`;
  dashboardUrl = `${baseUrl}/task-fixture/dashboard`;
  errorUrl = `${baseUrl}/task-fixture/error`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(dir, { recursive: true, force: true });
});

function auditTask(id = 'audit-1'): Task {
  return {
    id,
    goal: 'Audit the fixture dashboard and confirm the values it shows',
    constraints: ['read-only'],
    steps: [
      {
        tool: 'browser_navigate',
        params: { url: dashboardUrl },
        verify: [
          { kind: 'url-contains', value: 'task-fixture' },
          { kind: 'no-error-text', value: "isn't working" },
        ],
      },
      {
        tool: 'browser_snapshot',
        params: {},
        verify: [
          { kind: 'text-present', value: 'Balance: 1,234.56' },
          { kind: 'no-error-text', value: "isn't working" },
        ],
      },
      {
        tool: 'browser_snapshot',
        params: {},
        verify: [
          { kind: 'text-present', value: 'Invoices: 42' },
          { kind: 'no-error-text', value: "isn't working" },
        ],
      },
      {
        tool: 'browser_snapshot',
        params: {},
        verify: [
          { kind: 'text-present', value: 'Account code: ABC-123' },
          { kind: 'no-error-text', value: "isn't working" },
        ],
      },
    ],
    state: 'planned',
    evidence: [],
  };
}

function runOptions(browser: FakeFixtureBrowser, extra: Partial<RunTaskOptions> = {}): RunTaskOptions {
  return {
    tasksDir: dir,
    tools: fixtureTools(browser),
    host: dummyHost,
    session: { knownLoginUrls: [loginUrl] },
    ...extra,
  };
}

describe('the fixture page', () => {
  it('contains a login form, an end-session control, an error page, and numeric values to verify', () => {
    const html = fs.readFileSync(FIXTURE_PATH, 'utf8');
    // Login form.
    expect(html).toContain('id="login-form"');
    expect(html).toContain('type="password"');
    expect(html).toContain('Sign in');
    // The control that ends the session.
    expect(html).toContain('id="end-session"');
    expect(html).toContain('End session');
    // The error page.
    expect(html).toContain("This page isn't working");
    expect(html).toContain('ERR_CONNECTION_RESET');
    // Numeric values the audit verifies.
    expect(html).toContain('1,234.56');
    expect(html).toContain('Invoices: 42');
    expect(html).toContain('ABC-123');
    expect(html).toContain('Archived records: 7');
    // Pathname routing (served use) with a hash fallback (file:// use).
    expect(html).toContain('/task-fixture/dashboard');
  });

  it('serves each view at its own path-distinct route', async () => {
    for (const route of ['/task-fixture/login', '/task-fixture/dashboard', '/task-fixture/error']) {
      const res = await fetch(`${baseUrl}${route}`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('task-fixture');
    }
    const missing = await fetch(`${baseUrl}/task-fixture/nope`);
    expect(missing.status).toBe(404);
  });

  it('the popup status payload carries no task list or evidence report (Task 9 data limit)', () => {
    // Pinned, not assumed away: the Tasks panel shows only tasks waiting
    // on a question and the Evidence panel only what the popup itself has
    // seen. When the daemon→popup endpoint lands, this test must change
    // with it — the e2e tests below assert state and the report
    // server-side only, never through the popup.
    const connectionJs = fs.readFileSync(path.join(repoRoot, 'extension', 'lib', 'connection.js'), 'utf8');
    const start = connectionJs.indexOf('export function buildStatusPayload');
    expect(start).toBeGreaterThan(-1);
    const end = connectionJs.indexOf('\n}\n', start);
    const payloadFn = connectionJs.slice(start, end);
    expect(payloadFn).toContain('taskQuestions');
    expect(payloadFn).not.toMatch(/taskList|evidenceReport|tasks:/);
  });
});

describe('end-to-end audit task', () => {
  it('test_audit_task_survives_session_expiry', { timeout: 30_000 }, async () => {
    const browser = new FakeFixtureBrowser({ login: loginUrl, dashboard: dashboardUrl, error: errorUrl });
    // The session ends on the third snapshot read: after the navigate's
    // verification read and the balance step's own snapshot, the invoices
    // step lands on the login page instead of the dashboard.
    browser.expireOnSnapshotRead = 3;
    await saveTask(auditTask(), dir);

    const paused = await runTaskWithReport('audit-1', runOptions(browser));
    expect(paused.state).toBe('paused-login');
    // The redirected step executed but was never verified: its outcome is
    // unknown, so the resume reconciles it instead of re-running it
    // blind — and the last step never ran.
    expect(paused.steps[2]?.result?.status).toBe('unknown');
    expect(paused.steps[3]?.result).toBeUndefined();
    expect(paused.steps[0]?.result?.status).toBe('ok');
    expect(paused.steps[1]?.result?.status).toBe('ok');
    expect(paused.evidence.join('\n')).toContain('paused for login at step 3 of 4');
    // The navigate ran once; no step ran twice before the pause.
    expect(browser.calls.filter((call) => call === 'browser_navigate')).toHaveLength(1);
    // The pause persists with a report, as a status poll would see it.
    const stored = await loadTask('audit-1', dir);
    expect(stored?.state).toBe('paused-login');
    expect(stored?.report?.json.state).toBe('paused-login');

    // The user completes login by takeover; the resume re-checks the page
    // first and continues from the same step, never from the start.
    browser.login();
    const done = await resumeAfterLogin('audit-1', {
      tasksDir: dir,
      knownLoginUrls: [loginUrl],
      readPage: async () => ({ url: dashboardUrl, text: dashboardText(false), ref: 'browser_snapshot tab 42' }),
      continueWith: async (task) => runTaskWithReport(task.id, runOptions(browser)),
    });
    expect(done.state).toBe('done');
    expect(done.steps.map((step) => step.result?.status)).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(done.evidence.join('\n')).toContain('resuming from the same step');
    // The navigate was never re-run: the resume reconciled the paused
    // step (its effect — being on the dashboard — was confirmed) and the
    // run continued from there.
    expect(browser.calls.filter((call) => call === 'browser_navigate')).toHaveLength(1);
    // Every snapshot read went to the tab the navigate opened.
    expect(browser.snapshotTabIds.length).toBeGreaterThan(0);
    expect(browser.snapshotTabIds.every((tabId) => tabId === 42)).toBe(true);

    // The evidence report: the values verbatim, the source, nothing left
    // unconfirmed, nothing unverified.
    expect(done.report).toBeDefined();
    expect(done.report?.text).toContain('ما تم فحصه');
    expect(done.report?.json.state).toBe('done');
    const values = (done.report?.json.values ?? []).map((entry) => entry.value).join('\n');
    expect(values).toContain('1,234.56');
    expect(values).toContain('42');
    expect(values).toContain('ABC-123');
    expect(done.report?.json.sources).toContain(dashboardUrl);
    expect(done.report?.json.unconfirmed).toEqual([]);
    expect(done.report?.json.notVerified).toEqual([]);
    // The persisted record agrees with the returned task.
    const final = await loadTask('audit-1', dir);
    expect(final?.state).toBe('done');
    expect(final?.report?.json.state).toBe('done');
  });

  it('asks the user before a mutating step and resumes on yes', { timeout: 30_000 }, async () => {
    const browser = new FakeFixtureBrowser({ login: loginUrl, dashboard: dashboardUrl, error: errorUrl });
    const task: Task = {
      id: 'audit-2',
      goal: 'Audit the fixture dashboard including archived records',
      constraints: ['read-only'],
      steps: [
        {
          tool: 'browser_navigate',
          params: { url: dashboardUrl },
          verify: [{ kind: 'url-contains', value: 'task-fixture' }],
        },
        {
          tool: 'browser_snapshot',
          params: {},
          verify: [{ kind: 'text-present', value: 'Balance: 1,234.56' }],
        },
        {
          tool: 'browser_click',
          params: { target: 'include-archived' },
          verify: [{ kind: 'text-present', value: 'Archived records: 7' }],
        },
      ],
      state: 'planned',
      evidence: [],
    };
    await saveTask(task, dir);
    const sent: unknown[] = [];
    const options = runOptions(browser, {
      questions: {
        ask: (input) =>
          askQuestion(input.taskId, input.text, input.options, {
            kind: input.kind,
            context: input.context,
            tasksDir: dir,
            send: async (message) => {
              sent.push(message.question);
            },
          }),
      },
    });

    const paused = await runTaskWithReport('audit-2', options);
    expect(paused.state).toBe('paused-question');
    expect(paused.steps[2]?.result).toBeUndefined();
    expect(browser.calls).not.toContain('browser_click');
    // The question reached the (test) channel and is pending server-side.
    expect(sent).toHaveLength(1);
    expect((sent[0] as { text: string }).text).toContain('browser_click');
    const pending = await listPendingQuestions(dir);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.taskId).toBe('audit-2');

    const done = await answerQuestion(pending[0]!.id, 'yes', {
      tasksDir: dir,
      continueWith: async (answered) => runTaskWithReport(answered.id, runOptions(browser)),
    });
    expect(done.state).toBe('done');
    expect(done.steps.map((step) => step.result?.status)).toEqual(['ok', 'ok', 'ok']);
    // The approval covers that step only — the blanket constraint was not added.
    expect(done.constraints).toContain('allow-mutations:step:2');
    expect(done.constraints).not.toContain('allow-mutations');
    expect(browser.calls.filter((call) => call === 'browser_click')).toHaveLength(1);
    const values = (done.report?.json.values ?? []).map((entry) => entry.value).join('\n');
    expect(values).toContain('Archived records: 7');
    expect(done.evidence.join('\n')).toContain('user approved mutating tool browser_click');
  });

  it('fails verification on the error page and reports it as not verified', { timeout: 30_000 }, async () => {
    const browser = new FakeFixtureBrowser({ login: loginUrl, dashboard: dashboardUrl, error: errorUrl });
    const task: Task = {
      id: 'audit-3',
      goal: 'Open the fixture error page and confirm it loaded',
      constraints: ['read-only'],
      steps: [
        {
          tool: 'browser_navigate',
          params: { url: errorUrl },
          verify: [
            { kind: 'url-contains', value: 'task-fixture' },
            { kind: 'no-error-text', value: "isn't working" },
          ],
        },
        {
          tool: 'browser_snapshot',
          params: {},
          verify: [{ kind: 'no-error-text', value: "isn't working" }],
        },
      ],
      state: 'planned',
      evidence: [],
    };
    await saveTask(task, dir);

    const failed = await runTaskWithReport('audit-3', runOptions(browser));
    expect(failed.state).toBe('failed');
    // The navigation "succeeded" but the page is an error page: the tool
    // result alone is never evidence of success.
    expect(failed.steps[0]?.result?.status).toBe('verify-failed');
    expect(failed.steps[0]?.result?.detail).toContain("isn't working");
    expect(failed.steps[1]?.result).toBeUndefined();
    expect(failed.report?.json.state).toBe('failed');
    // Nothing from the error page counts as a found value or a source.
    expect(failed.report?.json.values).toEqual([]);
    expect(failed.report?.json.sources).toEqual([]);
    expect(failed.report?.json.notVerified).toHaveLength(2);
    expect(failed.report?.json.notVerified[0]?.tool).toBe('browser_navigate');
  });
});
