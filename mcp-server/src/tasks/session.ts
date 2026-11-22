/**
 * The session and login agent (specs/011-professional-browsing-layer, Design §2).
 *
 * One session state per (profile, origin): `unknown | logged-in | login-page |
 * warning-page | expired`. Detection reads the page the task is actually on —
 * never a guess about it — in this order, because the order is the safety:
 *
 * 1. A security-warning page is `warning-page`, checked before anything else:
 *    a warning interstitial can name a login URL and can carry words a login
 *    form also carries, so it must never be read as a login page, and it is
 *    never a successful target page either. It has to be dismissed explicitly
 *    first; this agent never dismisses it. Detection is anchored to
 *    interstitial signals — a `net::err_cert` code, or an interstitial
 *    heading phrase on a heading line (or the first line of a role-less
 *    snapshot) — so a page that merely discusses certificates or security
 *    warnings in its body text is not a warning page.
 * 2. A landing on a login URL the task did not mean to be on is `expired`:
 *    the session ended mid-task and the site bounced the task to login. The
 *    proof of the redirect is `expectedUrl` — where the task meant to be —
 *    which the caller (the runner) supplies from the step's target or the
 *    page the task was on before the step. Without that proof a login URL is
 *    only `login-page`.
 * 3. A login form on the page (007: a visible password field, the same signal
 *    `ui.login` is built from) is `login-page`.
 * 4. An ordinary page on the expected origin is `logged-in`; anything else
 *    the agent cannot place is `unknown`.
 *
 * The known login URLs come from site knowledge (008), passed in by the
 * caller: there is no site-knowledge store in the code yet to read them from,
 * so the caller supplies its per-(profile, origin) slice. Without one, the
 * generic sign-in path pattern from specs/005 FR-005 — the same pattern
 * `memory/map-capture.ts` uses — stands in.
 *
 * Pause and resume are this agent's job; the login itself is the user's. The
 * agent NEVER fills credentials and NEVER clicks Submit: on `expired` the
 * task pauses in `paused-login` and the user completes login by takeover.
 * `pauseForLogin` records the step the task stopped at in the evidence — the
 * task shape has no step-number field, so the number lives there and in the
 * first step without an `ok` result, which is where a resume continues from.
 * `resumeAfterLogin` re-checks the page first and only continues from that
 * same step when the page is no longer a login, expired, or warning page.
 * It is the single resume entry point: `runTask` refuses a `paused-login`
 * task handed to it directly, so a resume that skips the re-check cannot
 * happen by accident. `resumeAfterLogin` flips the task to `running` before
 * calling the continuation, so a continuation that is `runTask` passes that
 * guard.
 * The continuation itself is injected (`continueWith`, normally `runTask`):
 * importing the runner here would make runner and session import each other.
 *
 * Known limitation (final review, 2026-11-22): hash-only SPA views cannot
 * be told apart by the matcher — `withoutQuery` strips fragments, so two
 * views of one hash-routed app share a matcher key. A resume re-check on
 * such a task would stay `paused-login` (the re-check cannot confirm the
 * expected view), which is diagnosable from the evidence — it names the
 * URL — not silent corruption. Behaviour change is parked.
 */
import { loadTask, saveTask } from './store.js';
import { TaskCancelledExternally, saveTaskUnlessCancelled } from './cancel-guard.js';
import { saveTaskWithReportUnlessCancelled } from './reporting.js';
import { NAVIGATE_HISTORY_ACTIONS } from './mutations.js';
import type { Task, TaskStep } from './types.js';
import type { PageSnapshot } from './verify.js';

/** The session state of one (profile, origin). */
export type SessionState = 'unknown' | 'logged-in' | 'login-page' | 'warning-page' | 'expired';

/** The page to detect a session from: a snapshot, plus where the task meant to be. */
export interface SessionPage extends PageSnapshot {
  /**
   * The URL the task expected to be on — the step's target, or the page it
   * was on before the step. A landing on a login URL only counts as a
   * redirect (`expired`) when this is set and differs from `url`; without
   * it, a login URL is only `login-page`.
   */
  expectedUrl?: string;
}

/** Detect one session state from one page. */
export type DetectSessionFn = (
  profile: string,
  origin: string,
  page: SessionPage,
  knownLoginUrls?: readonly string[],
) => SessionState;

/** A path segment that names a sign-in page (specs/005 FR-005; `memory/map-capture.ts`). */
const SIGN_IN_PATH = /(?:^|\/)(?:log-?in|sign-?in|auth|sso|oauth2?|session\/new|accounts?\/login)(?:[/._-]|$)/iu;

/**
 * Chrome/Edge security-interstitial signals, anchored so a page that merely
 * discusses certificates or security warnings is never a warning page:
 * - a `net::err_cert` error code anywhere in the text — that code only
 *   appears on the interstitial / error page itself;
 * - an interstitial heading phrase, matched only on a heading line of the
 *   accessibility tree or on the first non-empty line (a role-less
 *   plain-text snapshot, as the http SMACC case shows it, puts its heading
 *   first). The same phrase in body text — a help article explaining what
 *   "your connection is not private" means — is not an interstitial.
 * The generic phrases `certificate error` and `security warning` are
 * deliberately absent: they are what help articles and settings pages say,
 * not what the interstitial says. The contracted `isn't` variant is
 * included: Chrome renders both forms.
 */
const WARNING_CODE = /net::err_cert|err_cert_/iu;
const WARNING_HEADING_PHRASES = [
  'your connection is not private',
  "your connection isn't private",
  'privacy error',
  'attackers might be trying to steal',
  "this site isn't secure",
  'potential security risk',
];

/** The accessible name quoted in a `heading` line of the accessibility tree, if this line is one. */
function headingNameOf(line: string): string | undefined {
  const match = /^\s*(?:-\s+)?heading\s+"([^"]*)"/iu.exec(line);
  return match?.[1];
}

/**
 * Whether the snapshot is a security interstitial: a certificate error
 * code, or an interstitial heading phrase on a heading line or the first
 * non-empty line. Body text that merely discusses certificates or security
 * warnings does not count.
 */
function isWarningPage(text: string): boolean {
  const lowered = text.toLowerCase();
  if (WARNING_CODE.test(lowered)) return true;
  const lines = text.split('\n');
  const firstLine = lines.find((line) => line.trim() !== '');
  const headingLines = lines.map((line) => headingNameOf(line)).filter((name) => name !== undefined);
  const candidates = [...headingLines, firstLine ?? ''];
  return candidates.some((candidate) =>
    WARNING_HEADING_PHRASES.some((phrase) => candidate.toLowerCase().includes(phrase)),
  );
}

/** Accessible names of a password field, in the snapshot's languages. */
const PASSWORD_NAMES = ['password', 'كلمة المرور', 'كلمة السر'];

/** Accessible names of a sign-in submit control. */
const SIGN_IN_NAMES = ['sign in', 'log in', 'login', 'تسجيل الدخول', 'دخول'];

/** Accessible names of the identifier field of a sign-in form. */
const IDENTIFIER_NAMES = [
  'email',
  'e-mail',
  'username',
  'user name',
  'phone',
  'mobile',
  'البريد الإلكتروني',
  'اسم المستخدم',
  'الجوال',
  'الهاتف',
];

/** The origin of a URL, or '' when it does not parse. */
export function originOf(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/** A URL without its query and fragment: login URLs carry `?next=` and the like. */
function withoutQuery(url: string): string {
  const cut = url.split(/[?#]/u, 1)[0];
  return cut ?? '';
}

/** The path of a URL, or '' when it does not parse. */
function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return withoutQuery(url);
  }
}

/** Whether the page URL is one of the site's known login URLs (query and fragment ignored). */
function matchesKnownLoginUrl(pageUrl: string, knownLoginUrls: readonly string[]): boolean {
  const page = withoutQuery(pageUrl).toLowerCase();
  return knownLoginUrls.some((known) => withoutQuery(known).toLowerCase() === page);
}

/** Whether the page URL's path names a sign-in page, known list or not. */
function matchesSignInPath(pageUrl: string): boolean {
  return SIGN_IN_PATH.test(pathOf(pageUrl));
}

/** Whether the page URL is a login URL: known from site knowledge, or a sign-in path. */
function isLoginUrl(pageUrl: string, knownLoginUrls: readonly string[]): boolean {
  return matchesKnownLoginUrl(pageUrl, knownLoginUrls) || matchesSignInPath(pageUrl);
}

/**
 * Whether landing on `pageUrl` while meaning to be on `expectedUrl` is a
 * redirect: the two differ (query and fragment ignored), and the expected
 * page was not itself a login page — navigating to login on purpose is not
 * an expiry.
 */
function isRedirect(pageUrl: string, expectedUrl: string | undefined, knownLoginUrls: readonly string[]): boolean {
  if (!expectedUrl) return false;
  if (withoutQuery(pageUrl).toLowerCase() === withoutQuery(expectedUrl).toLowerCase()) return false;
  if (isLoginUrl(expectedUrl, knownLoginUrls)) return false;
  return true;
}

/**
 * The accessible name quoted in one accessibility-tree line, e.g. `Password`
 * in `- textbox "Password" [ref=e2]` — the same line format `verify.ts`
 * reads. Undefined when the line is not an element line of that role.
 */
function nameOfRoleLine(line: string, role: string): string | undefined {
  const match = new RegExp(`^\\s*(?:-\\s+)?${role}\\s+"([^"]*)"`, 'iu').exec(line);
  return match?.[1];
}

function hasWord(name: string | undefined, words: readonly string[]): boolean {
  if (name === undefined) return false;
  const lowered = name.toLowerCase();
  return words.some((word) => lowered.includes(word.toLowerCase()));
}

/**
 * Whether the snapshot shows a login form (007): a visible password field —
 * the same signal `ui.login` is built from — or a sign-in submit control
 * next to an identifier field. The shape never says what the form is for
 * beyond that; a password-change form reads the same way, and the runner
 * treats `login-page` as "let verification judge", never as an expiry.
 */
function hasLoginForm(text: string): boolean {
  const lines = text.split('\n');
  let hasPasswordField = false;
  let hasSignInControl = false;
  let hasIdentifierField = false;
  for (const line of lines) {
    if (hasWord(nameOfRoleLine(line, 'textbox'), PASSWORD_NAMES)) hasPasswordField = true;
    if (hasWord(nameOfRoleLine(line, 'button'), SIGN_IN_NAMES)) hasSignInControl = true;
    if (hasWord(nameOfRoleLine(line, 'textbox'), IDENTIFIER_NAMES)) hasIdentifierField = true;
  }
  return hasPasswordField || (hasSignInControl && hasIdentifierField);
}

/**
 * Detect the session state of the page. `profile` scopes the call — the
 * known login URLs are the caller's per-(profile, origin) slice of site
 * knowledge (008) — but the detection itself is pure: it reads only this
 * page, and never fills credentials or clicks anything.
 */
export function detectSession(
  profile: string,
  origin: string,
  page: SessionPage,
  knownLoginUrls: readonly string[] = [],
): SessionState {
  void profile;
  // The warning first: it can name a login URL and carry login words, and
  // it is neither a login page nor a successful target page.
  if (isWarningPage(page.text)) return 'warning-page';
  if (page.url !== '' && isLoginUrl(page.url, knownLoginUrls)) {
    return isRedirect(page.url, page.expectedUrl, knownLoginUrls) ? 'expired' : 'login-page';
  }
  if (hasLoginForm(page.text)) return 'login-page';
  if (page.url !== '' && origin !== '' && originOf(page.url) === origin) return 'logged-in';
  return 'unknown';
}

/** The first step without an `ok` result — where a resume continues from — or the last step when all are done. */
function firstUnfinishedStep(task: Task): number {
  const index = task.steps.findIndex((step) => step.result?.status !== 'ok');
  return index === -1 ? Math.max(0, task.steps.length - 1) : index;
}

/** The URL of the page a completed step verified against, from its recorded evidence (`verifyStep` writes `verified N rule(s) at <url>; ...`). */
const VERIFIED_URL = /verified \d+ rule\(s\) at (\S+); snapshot=/u;

function verifiedUrlOf(step: TaskStep): string | undefined {
  if (step.result?.status !== 'ok' || !step.result.detail) return undefined;
  return VERIFIED_URL.exec(step.result.detail)?.[1];
}

/**
 * The page the task was last on — the redirect proof for a resume
 * re-check, and the expected URL a resume tool's page reader supplies.
 * Prefer the last executed navigate's target; otherwise the URL the last
 * completed step verified against. A history navigate (`back` / `forward` /
 * `reload`) names no URL, so it falls through to the verified URL instead.
 * A step recorded `unknown` executed too, so its navigate target counts:
 * it is the page the task was on when the session expired.
 */
export function lastKnownUrl(task: Task): string | undefined {
  let last: string | undefined;
  for (const step of task.steps) {
    if (step.result?.status !== 'ok' && step.result?.status !== 'unknown') continue;
    if (
      step.tool === 'browser_navigate' &&
      typeof step.params.url === 'string' &&
      !NAVIGATE_HISTORY_ACTIONS.has(step.params.url)
    ) {
      last = step.params.url;
    } else {
      last = verifiedUrlOf(step) ?? last;
    }
  }
  return last;
}

/**
 * Pause a task for login: state `paused-login`, the current step number in
 * the evidence, saved. Throws when the task was never saved or is already
 * finished; pausing a finished task would rewrite its outcome. The save
 * goes through the cancel guard (`cancel-guard.ts`): a cancel landing
 * between the load above and this save throws `TaskCancelledExternally`
 * instead of overwriting the cancellation with `paused-login` — the
 * runner's expired path returns the stored cancelled record from that
 * throw, and a direct caller gets it on the error.
 */
export async function pauseForLogin(taskId: string, stepIndex?: number, tasksDir?: string): Promise<Task> {
  const task = await loadTask(taskId, tasksDir);
  if (!task) throw new Error(`task not found: ${taskId}`);
  if (task.state === 'done' || task.state === 'failed') {
    throw new Error(`cannot pause task ${taskId} for login: task is ${task.state}`);
  }
  if (stepIndex !== undefined && (!Number.isSafeInteger(stepIndex) || stepIndex < 0 || stepIndex >= task.steps.length)) {
    throw new Error(`cannot pause task ${taskId} for login: step index ${stepIndex} is out of range`);
  }
  const index = stepIndex ?? firstUnfinishedStep(task);
  task.state = 'paused-login';
  task.evidence.push(
    `paused for login at step ${index + 1} of ${task.steps.length} — waiting for the user to complete login by takeover (this agent never fills credentials or clicks Submit); resumes from the same step, never from the start`,
  );
  await saveTaskUnlessCancelled(task, tasksDir);
  return task;
}

/** How `resumeAfterLogin` re-checks the page and continues the task. */
export interface ResumeAfterLoginOptions {
  tasksDir?: string;
  profile?: string;
  /** The caller's per-(profile, origin) slice of site knowledge (008). */
  knownLoginUrls?: readonly string[];
  /**
   * Read the current page for the re-check — normally a `browser_snapshot`
   * on the tab the task's completed steps bound. Required: resuming without
   * re-checking the page first is not a resume.
   */
  readPage: (task: Task) => Promise<SessionPage>;
  /**
   * Continue executing the task once the re-check passes — normally
   * `runTask`, which resumes from the first unfinished step. When omitted
   * the task is left `running` for the caller to continue.
   */
  continueWith?: (task: Task) => Promise<Task>;
}

/**
 * Resume a task paused for login: re-check the page first, then continue
 * from the same step. Still on a login page, still expired, or on a warning
 * page, the task stays `paused-login` and the continuation never runs — the
 * user has not finished logging in (or dismissing the warning) yet.
 * Unplaceable (`unknown`) also stays paused: after takeover the user may be
 * on a completely different site, and resuming blind would let a weak
 * verify rule verify `ok` against the wrong page and record bogus
 * evidence. Only a page on the task's expected origin — the origin of the
 * page the task was last on (`lastKnownUrl`), or the re-check page's own
 * `expectedUrl` when the reader supplies one — counts as logged in.
 *
 * Every save here goes through the cancel guard (`cancel-guard.ts`): a
 * cancel landing between the load above and any save below is not
 * overwritten — the still-paused saves use the guarded report save, the
 * resume save uses the guarded plain save — and a cancelled task on the
 * resume branch never continues: the stored cancelled record is returned
 * instead, with the marker cleaned up on it as the wrapper does
 * (`wiring.ts`), so the cancellation stays as evidence and state, not
 * as a live signal.
 */
export async function resumeAfterLogin(taskId: string, options: ResumeAfterLoginOptions): Promise<Task> {
  const task = await loadTask(taskId, options.tasksDir);
  if (!task) throw new Error(`task not found: ${taskId}`);
  if (task.state !== 'paused-login') {
    throw new Error(`cannot resume task ${taskId} after login: task is ${task.state}, not paused-login`);
  }
  if (typeof options.readPage !== 'function') {
    throw new Error(`cannot resume task ${taskId} after login: no page reader supplied to re-check the page`);
  }
  try {
    const page = await options.readPage(task);
    // The expected origin is the task's own, not the re-check page's: the
    // page the task was last on, or the reader's `expectedUrl` when it
    // supplies one. Passing the page's own origin here would make the
    // `logged-in` check tautological — any ordinary page would pass, even
    // on a completely different site after takeover.
    const expectedUrl = page.expectedUrl ?? lastKnownUrl(task);
    const state = detectSession(
      options.profile ?? 'default',
      originOf(expectedUrl),
      { ...page, expectedUrl },
      options.knownLoginUrls ?? [],
    );
    const index = firstUnfinishedStep(task);
    if (state === 'expired' || state === 'login-page') {
      task.evidence.push(
        `login re-check: still ${state} at step ${index + 1} of ${task.steps.length} — the user has not completed login yet; staying paused`,
      );
      await saveTaskWithReportUnlessCancelled(task, options.tasksDir);
      return task;
    }
    if (state === 'warning-page') {
      task.evidence.push(
        `login re-check: security warning page at step ${index + 1} of ${task.steps.length} — dismiss the warning explicitly before continuing; staying paused`,
      );
      await saveTaskWithReportUnlessCancelled(task, options.tasksDir);
      return task;
    }
    if (state === 'unknown') {
      task.evidence.push(
        `login re-check: could not place the page at step ${index + 1} of ${task.steps.length} (url=${page.url || '(unknown url)'}, expected ${expectedUrl ?? 'unknown'}) — not recognisably the expected site; staying paused`,
      );
      await saveTaskWithReportUnlessCancelled(task, options.tasksDir);
      return task;
    }
    task.state = 'running';
    // The report describes the paused state; the resume leaves it, so the
    // record carries no report until the resumed run settles again.
    delete task.report;
    task.evidence.push(
      `login re-check passed (${state}) at step ${index + 1} of ${task.steps.length} — resuming from the same step`,
    );
    await saveTaskUnlessCancelled(task, options.tasksDir);
  } catch (error) {
    if (error instanceof TaskCancelledExternally) {
      // Another process cancelled the task while the resume was in
      // flight: no save happened, so the stored cancelled record
      // stands — return it instead of resuming. The marker is cleaned
      // up on the terminal record, as the wrapper does: the
      // cancellation stays as evidence and state, not as a live signal.
      const stored = error.stored;
      delete stored.cancelled;
      try {
        await saveTask(stored, options.tasksDir);
      } catch {
        // The cancellation itself is already durable on disk; a failed
        // cleanup save must not hide it behind a throw.
      }
      return stored;
    }
    throw error;
  }
  if (options.continueWith) return options.continueWith(task);
  return task;
}
