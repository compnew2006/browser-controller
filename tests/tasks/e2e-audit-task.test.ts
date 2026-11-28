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
import { buildTaskStatus } from '../../mcp-server/src/tasks/task-status.js';
import type { ToolDefinition, ToolHost, ToolResult } from '../../mcp-server/src/tools/types.js';
import { failureResult, outcomeOf, textResult } from '../../mcp-server/src/tools/types.js';

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
function dashboardText(archivedShown: boolean, coveredDone = false, menuDone = false): string {
  return (
    'heading "Audit fixture — Dashboard"\n' +
    '- text "Balance: 1,234.56"\n' +
    '- text "Invoices: 42"\n' +
    '- text "Account code: ABC-123"\n' +
    (archivedShown ? '- text "Archived records: 7"\n' : '') +
    '- button "End session" [ref=e4]\n' +
    '- button "Include archived records" [ref=e5]\n' +
    '- link "Show the error page" [ref=e6]\n' +
    '- button "Covered action" [ref=e7]\n' +
    (coveredDone ? '- text "Covered action done"\n' : '') +
    '- button "Menu item" [ref=e8]\n' +
    (menuDone ? '- text "Menu item done"\n' : '')
  );
}

/** The login form after the vault filled it — the filled username is what the Gap B check reads. */
function filledLoginText(filledUsername: string): string {
  return (
    `- textbox "Email" [ref=e1] value="${filledUsername}"\n` +
    '- textbox "Password" [ref=e2] value="••••"\n' +
    '- button "Sign in" [ref=e3]'
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
  coveredDone = false;
  menuDone = false;
  /** The prepare policy already scrolled the covered button into view. */
  coveredUncovered = false;
  /** The hover already revealed the menu item. */
  menuRevealed = false;
  /** The account the vault filled — the wrong one, for the Gap B check. */
  filledUsername: string | undefined = undefined;
  sessionValid = false;
  /** Flip the session to expired on this snapshot read (1-based), then never again. */
  expireOnSnapshotRead: number | null = null;
  snapshotReads = 0;
  calls: string[] = [];
  snapshotTabIds: Array<number | undefined> = [];
  /**
   * The task shield's linger on the tab (extension/lib/overlay.js): user
   * input on the tab stays blocked after the run pauses, while the popup
   * — a browser-UI surface outside the tab — stays reachable. A test-only
   * stand-in for that linger; the runner never sees it.
   */
  shieldActive = false;

  constructor(
    private readonly urls: { login: string; dashboard: string; error: string },
  ) {}

  /** The user completes login by takeover: the session is valid again. */
  login(): void {
    this.view = 'dashboard';
    this.sessionValid = true;
    this.expireOnSnapshotRead = null;
  }

  /** The dashboard as the page reads right now (resume re-checks, reconciliation). */
  dashboardSnapshot(): { url: string; text: string; ref: string } {
    return {
      url: this.urls.dashboard,
      text: dashboardText(this.archivedShown, this.coveredDone, this.menuDone),
      ref: 'browser_snapshot tab 42',
    };
  }

  /** User input on the tab: blocked while the shield lingers, open once it lifts. */
  userInput(): string {
    if (this.shieldActive) throw new Error('user input blocked: the task shield is up on tab 42');
    return 'user input received';
  }

  private snapshotForView(): { text: string; url: string } {
    switch (this.view) {
      case 'login':
        return {
          text: this.filledUsername !== undefined ? filledLoginText(this.filledUsername) : LOGIN_FORM_TEXT,
          url: this.urls.login,
        };
      case 'dashboard':
        return { text: dashboardText(this.archivedShown, this.coveredDone, this.menuDone), url: this.urls.dashboard };
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
    const target = String(params.target ?? '');
    // The Sign in submit: the login view gives way to the dashboard.
    if (target === 'e3' && this.view === 'login') {
      this.view = 'dashboard';
      this.sessionValid = true;
      return outcomeOf({ success: true, text: 'clicked', url: this.snapshotForView().url, tabId: 42 });
    }
    // The Gap A covered button: the first click lands on the fixed
    // banner; the prepare scroll uncovers it and the retry clicks it.
    if (target === 'e7') {
      if (!this.coveredUncovered) {
        return failureResult(
          'ELEMENT_COVERED: the click point of button "Covered action" is covered by the fixed banner; the click would land there instead.',
        );
      }
      this.coveredDone = true;
      return outcomeOf({ success: true, text: 'clicked', url: this.snapshotForView().url, tabId: 42 });
    }
    // The Gap A hover-menu item: hidden until hovered — a plain click
    // and a scroll both fail ELEMENT_HIDDEN; the prepare hover reveals
    // it, the scroll after the hover succeeds, and the retry clicks it.
    if (target === 'e8') {
      if (params.hover === true) {
        this.menuRevealed = true;
        return outcomeOf({ success: true, text: 'hovered', url: this.snapshotForView().url, tabId: 42 });
      }
      if (!this.menuRevealed) {
        return failureResult('ELEMENT_HIDDEN: button "Menu item" is not displayed until its menu is hovered.');
      }
      this.menuDone = true;
      return outcomeOf({ success: true, text: 'clicked', url: this.snapshotForView().url, tabId: 42 });
    }
    if (target === 'include-archived' || target === 'e5') this.archivedShown = true;
    if (target === 'end-session' || target === 'e4') {
      this.view = 'login';
      this.sessionValid = false;
    }
    return outcomeOf({ success: true, text: 'clicked', url: this.snapshotForView().url, tabId: 42 });
  }

  /** The prepare scroll: uncovers the covered button; a hidden menu item cannot be scrolled to. */
  scroll(params: Record<string, unknown>): ToolResult {
    this.calls.push('browser_scroll');
    const target = String(params.target ?? '');
    if (target === 'e7') {
      this.coveredUncovered = true;
      return textResult('scrolled into view');
    }
    if (target === 'e8' && !this.menuRevealed) {
      return failureResult('ELEMENT_HIDDEN: button "Menu item" is not displayed, so it cannot be scrolled to.');
    }
    return textResult('scrolled into view');
  }

  vault(params: Record<string, unknown>): ToolResult {
    this.calls.push(`browser_vault:${String(params.action)}`);
    if (params.action === 'fill') {
      // The vault holds a different account than the task expects: the
      // fill completes, and the Gap B check must catch it before submit.
      this.filledUsername = 'wrong@example.com';
      return textResult('vault ok');
    }
    if (params.action === 'list') {
      return outcomeOf({
        success: true,
        origin: 'https://example.com',
        accounts: [{ identifier: 'saved@example.com', handle: 'cred_handle', origin: 'https://example.com' }],
      });
    }
    return textResult('vault ok');
  }
}

const tabSchema = z.object({ tabId: z.number().optional(), maxChars: z.number().optional() }).strict();
const navigateSchema = z
  .object({ url: z.string(), tabId: z.number().optional(), incognito: z.boolean().optional() })
  .strict();
const clickSchema = z
  .object({ target: z.string(), tabId: z.number().optional(), hover: z.boolean().optional() })
  .strict();
const scrollSchema = z.object({ target: z.string(), tabId: z.number().optional() }).strict();
const vaultSchema = z
  .object({
    action: z.enum(['fill', 'save_login', 'list', 'status', 'unlock']),
    tabId: z.number().optional(),
    handle: z.string().optional(),
    label: z.string().optional(),
  })
  .strict();

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
  const scroll: ToolDefinition = {
    name: 'browser_scroll',
    summary: 'Fake browser_scroll for the e2e audit task test',
    description: 'Test-only stand-in for browser_scroll (the Gap A prepare scroll).',
    inputSchema: scrollSchema,
    handler: async (_host, params) => browser.scroll(params),
  };
  const vault: ToolDefinition = {
    name: 'browser_vault',
    summary: 'Fake browser_vault for the e2e audit task test',
    description: 'Test-only stand-in for browser_vault.',
    inputSchema: vaultSchema,
    handler: async (_host, params) => browser.vault(params),
  };
  return new Map([
    ['browser_navigate', navigate],
    ['browser_snapshot', snapshot],
    ['browser_click', click],
    ['browser_scroll', scroll],
    ['browser_vault', vault],
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
    // Gap A states (Task 5): a button the fixed banner covers, and a
    // hover-menu item — each writes its done marker when clicked.
    expect(html).toContain('id="audit-banner"');
    expect(html).toContain('id="covered-action"');
    expect(html).toContain('Covered action done');
    expect(html).toContain('id="menu-item"');
    expect(html).toContain('Menu item done');
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

describe('the four-gap audit task (one task, end to end)', () => {
  it('test_audit_task_wrong_login_covered_button_session_expiry_shielded_question', { timeout: 30_000 }, async () => {
    const browser = new FakeFixtureBrowser({ login: loginUrl, dashboard: dashboardUrl, error: errorUrl });
    // The session expires on snapshot read 9. The reads before it are
    // fixed by the runner's own sequence — count them, do not guess:
    // run 1: navigate verify (1), fill verify (2); run 2 (after the
    // login-check answer): submit-gate read (3), submit verify (4),
    // covered-click gate read (5), covered-click verify (6),
    // menu-click gate read (7), menu-click verify (8); the Balance
    // step's own snapshot (9) lands on the login page instead. (The
    // gate reads at 5 and 7 are the submit-gate fix's cost: the gate
    // reads the page to resolve a string click target against it.)
    browser.expireOnSnapshotRead = 9;
    const task: Task = {
      id: 'audit-e2e',
      goal: 'Audit the fixture dashboard: log in, verify the values, save the login',
      constraints: ['allow-mutations'],
      steps: [
        {
          tool: 'browser_navigate',
          params: { url: loginUrl },
          verify: [
            { kind: 'url-contains', value: 'task-fixture' },
            { kind: 'no-error-text', value: "isn't working" },
          ],
        },
        {
          tool: 'browser_vault',
          params: { action: 'fill', handle: 'cred_handle', expectedAccount: 'owner@example.com' },
          verify: [{ kind: 'text-present', value: 'Sign in' }],
        },
        {
          tool: 'browser_click',
          params: { target: 'e3' },
          verify: [{ kind: 'text-present', value: 'Audit fixture — Dashboard' }],
        },
        {
          tool: 'browser_click',
          params: { target: 'e7' },
          verify: [{ kind: 'text-present', value: 'Covered action done' }],
        },
        {
          tool: 'browser_click',
          params: { target: 'e8' },
          verify: [{ kind: 'text-present', value: 'Menu item done' }],
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
          verify: [{ kind: 'text-present', value: 'Invoices: 42' }],
        },
        {
          tool: 'browser_snapshot',
          params: {},
          verify: [{ kind: 'text-present', value: 'Account code: ABC-123' }],
        },
        {
          tool: 'browser_click',
          params: { target: 'e5' },
          verify: [{ kind: 'text-present', value: 'Archived records: 7' }],
        },
        {
          tool: 'browser_vault',
          params: { action: 'save_login' },
          verify: [{ kind: 'text-present', value: 'Audit fixture — Dashboard' }],
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

    // (a) Wrong login (Gap B): the vault filled wrong@example.com while
    // the task expects owner@example.com — the task pauses in
    // paused-question BEFORE any submit, and the submit never runs.
    const pausedLoginCheck = await runTaskWithReport('audit-e2e', options);
    expect(pausedLoginCheck.state).toBe('paused-question');
    expect(pausedLoginCheck.steps[1]?.result?.status).toBe('ok');
    expect(pausedLoginCheck.steps[2]?.result).toBeUndefined();
    expect(browser.calls).toContain('browser_vault:fill');
    expect(browser.calls.filter((call) => call === 'browser_click')).toHaveLength(0);
    expect(sent).toHaveLength(1);
    expect((sent[0] as { text: string }).text).toContain('wrong@example.com');
    expect((sent[0] as { text: string }).text).toContain('owner@example.com');
    const loginPending = await listPendingQuestions(dir);
    expect(loginPending).toHaveLength(1);
    expect(loginPending[0]?.taskId).toBe('audit-e2e');
    expect(loginPending[0]?.context?.purpose).toBe('login-check');
    expect(loginPending[0]?.context?.fillStepIndex).toBe(1);
    expect(pausedLoginCheck.evidence.join('\n')).toContain('does not match the expected account');

    // The user proceeds as the filled account: the submit runs once, the
    // covered button and the hover-menu item each succeed from their
    // single step via the prepare policy — then the session expires
    // mid-task on the Balance step (c).
    const pausedLogin = await answerQuestion(loginPending[0]!.id, 'proceed', {
      tasksDir: dir,
      continueWith: async (answered) => runTaskWithReport(answered.id, options),
    });
    expect(pausedLogin.state).toBe('paused-login');
    expect(pausedLogin.steps.map((step) => step.result?.status)).toEqual([
      'ok',
      'ok',
      'ok',
      'ok',
      'ok',
      'unknown',
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(pausedLogin.evidence.join('\n')).toContain('paused for login at step 6 of 10');
    // (b) Covered button (Gap A): one scroll, one retry, no hover, no
    // new step — the prepare attempts are sub-evidence on the step.
    expect(pausedLogin.evidence.join('\n')).toContain('prepare step 4 (browser_click)');
    expect(pausedLogin.evidence.join('\n')).toContain('ELEMENT_COVERED');
    expect(pausedLogin.evidence.join('\n')).toContain('scroll-into-view ok');
    // (b) Hover-menu item (Gap A): scroll fails hidden, hover reveals,
    // scroll again, retry — still one step.
    expect(pausedLogin.evidence.join('\n')).toContain('prepare step 5 (browser_click)');
    expect(pausedLogin.evidence.join('\n')).toContain('ELEMENT_HIDDEN');
    expect(pausedLogin.evidence.join('\n')).toContain('hovered the target');
    expect(pausedLogin.evidence.join('\n')).toContain('retry succeeded');
    expect(browser.calls.filter((call) => call === 'browser_click')).toHaveLength(6);
    expect(browser.calls.filter((call) => call === 'browser_scroll')).toHaveLength(3);
    // The submit ran exactly once; the navigate was never re-run.
    expect(browser.calls.filter((call) => call === 'browser_navigate')).toHaveLength(1);
    const storedPaused = await loadTask('audit-e2e', dir);
    expect(storedPaused?.state).toBe('paused-login');
    expect(storedPaused?.report?.json.state).toBe('paused-login');

    // (c) Session expiry: the user completes login by takeover; the
    // resume re-checks the page and continues from the same step — the
    // Balance step is reconciled, never re-run blind — and the run
    // reaches the save_login step, which asks about replacing the saved
    // login instead of saving over it unseen.
    browser.login();
    const pausedQuestion = await resumeAfterLogin('audit-e2e', {
      tasksDir: dir,
      knownLoginUrls: [loginUrl],
      readPage: async () => browser.dashboardSnapshot(),
      continueWith: async (resumed) => runTaskWithReport(resumed.id, options),
    });
    expect(pausedQuestion.state).toBe('paused-question');
    expect(pausedQuestion.steps[5]?.result?.status).toBe('ok');
    expect(pausedQuestion.steps[6]?.result?.status).toBe('ok');
    expect(pausedQuestion.steps[7]?.result?.status).toBe('ok');
    expect(pausedQuestion.steps[8]?.result?.status).toBe('ok');
    expect(pausedQuestion.steps[9]?.result).toBeUndefined();
    expect(pausedQuestion.evidence.join('\n')).toContain('resuming from the same step');
    expect(pausedQuestion.evidence.join('\n')).toContain('paused for question at step 10 of 10');
    expect(browser.calls.filter((call) => call === 'browser_vault:save_login')).toHaveLength(0);
    expect(sent).toHaveLength(2);
    expect((sent[1] as { text: string }).text).toContain('saved@example.com');
    const replacePending = await listPendingQuestions(dir);
    expect(replacePending).toHaveLength(1);
    expect(replacePending[0]?.taskId).toBe('audit-e2e');
    expect(replacePending[0]?.context?.purpose).toBe('replace-login');
    expect(replacePending[0]?.context?.existingAccount).toBe('saved@example.com');

    // (d) Question while shielded (Gap C): the shield's linger still
    // blocks user input on the tab — but the question card lives in the
    // popup, outside the tab, so it is reachable there: the pending
    // question is listed for the popup (taskStatus) and the answer goes
    // through answerQuestion, the path the popup's taskAnswer takes,
    // without touching the tab at all.
    browser.shieldActive = true;
    expect(() => browser.userInput()).toThrow('task shield is up');
    const status = await buildTaskStatus(dir);
    expect(status.find((entry) => entry.id === 'audit-e2e')?.state).toBe('paused-question');
    const callsBeforeAnswer = browser.calls.length;
    const running = await answerQuestion(replacePending[0]!.id, 'yes', { tasksDir: dir });
    expect(running.state).toBe('running');
    expect(running.steps[9]?.result).toBeUndefined();
    expect(browser.calls.length).toBe(callsBeforeAnswer);

    // The answer resumes the task from the same step; the save runs once
    // and the task finishes with its prior progress intact.
    const done = await runTaskWithReport('audit-e2e', options);
    expect(done.state).toBe('done');
    expect(done.steps.map((step) => step.result?.status)).toEqual(Array.from({ length: 10 }, () => 'ok'));
    expect(browser.calls.filter((call) => call === 'browser_vault:save_login')).toHaveLength(1);
    expect(browser.calls.filter((call) => call === 'browser_vault:list')).toHaveLength(1);
    expect(browser.calls.filter((call) => call === 'browser_click')).toHaveLength(7);
    expect(browser.calls.filter((call) => call === 'browser_scroll')).toHaveLength(3);
    // Snapshot reads, counted the same way as the expiry arming above:
    // run 1: 2; run 2: submit gate 1 + submit verify 1 + covered gate 1
    // + covered verify 1 + menu gate 1 + menu verify 1 + Balance 1 = 7;
    // run 3: reconcile 1 + steps 6-7 (2) + archived gate 1 + archived
    // verify 1 + save gate 1 = 6; run 4: save verify 1. Total 16.
    expect(browser.calls.filter((call) => call === 'browser_snapshot')).toHaveLength(16);
    // The shield lifts at settle.
    browser.shieldActive = false;
    expect(browser.userInput()).toBe('user input received');

    // The evidence report: all five fixed sections (spec FR-009/FR-010),
    // with values copied literally from the step record.
    expect(done.report).toBeDefined();
    expect(done.report?.text).toContain('## ما تم فحصه');
    expect(done.report?.text).toContain('## القيم التي وُجدت');
    expect(done.report?.text).toContain('## المصادر');
    expect(done.report?.text).toContain('## ما بقي غير مؤكد');
    expect(done.report?.text).toContain('## ما لم يُتحقق منه');
    expect(done.report?.json.checked).toHaveLength(10);
    expect(done.report?.json.checked.every((entry) => entry.status === 'ok')).toBe(true);
    const values = (done.report?.json.values ?? []).map((entry) => entry.value).join('\n');
    expect(values).toContain('1,234.56');
    expect(values).toContain('42');
    expect(values).toContain('ABC-123');
    expect(values).toContain('Archived records: 7');
    // The done markers are NOT in the values section: values are copied
    // verbatim from each step's detail, and the verifier's observed
    // excerpt is capped at 200 chars (`verify.ts`,
    // EVIDENCE_EXCERPT_CHARS) — the markers sit past that cut in the
    // dashboard text. They are in the report where they belong instead:
    // the checked section names the verify rule that confirmed each one.
    expect(done.report?.json.checked[3]?.verify).toContain('text-present "Covered action done"');
    expect(done.report?.json.checked[4]?.verify).toContain('text-present "Menu item done"');
    expect(done.report?.json.checked[3]?.status).toBe('ok');
    expect(done.report?.json.checked[4]?.status).toBe('ok');
    expect(done.report?.json.sources).toContain(dashboardUrl);
    expect(done.report?.json.sources).toContain(loginUrl);
    expect(done.report?.json.unconfirmed).toEqual([]);
    expect(done.report?.json.notVerified).toEqual([]);
    // The persisted record agrees with the returned task.
    const final = await loadTask('audit-e2e', dir);
    expect(final?.state).toBe('done');
    expect(final?.report?.json.state).toBe('done');
  });
});
