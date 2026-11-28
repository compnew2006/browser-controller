/**
 * The post-fill username check (plan §3, Gap B — the Phase 1 security gap).
 *
 * What Muse does on every login, and this project did not do at all: after
 * the vault fills a login form, and before anything submits it, read the
 * filled username back from the page and compare it with the account the
 * task meant to log in as. Logging in as the wrong account on SMACC or the
 * CRM can change data or send messages as the wrong account — so a
 * mismatch stops the task in `paused-question` instead of submitting.
 *
 * The check reads the USERNAME field value only, from the page snapshot
 * (`browser_snapshot` accessibility tree). The password field value is
 * NEVER read: the parser only looks at identifier-named textboxes, and a
 * snapshot whose only filled field is the password yields no username.
 * The snapshot itself already redacts password values to `••••`
 * (`extension/lib/page-dom.js`, `redactSensitiveText`).
 *
 * Where the expected account comes from: the task declares it, on the
 * fill step's params as `expectedAccount` — never guessed from page text.
 * The runner strips it before validating the step's params (the vault
 * tool's schema is strict and would refuse the extra key). With no
 * expected account declared, the check cannot compare, so it asks the
 * user to confirm the filled account instead of silently submitting.
 *
 * The outcome is durable on the task as a constraint, the same pattern
 * the mutation approval uses (`questions.ts`):
 * - `login-verified:step:<n>` — the runner itself saw filled == expected
 *   after fill step <n>.
 * - `login-approved:step:<n>` — the user approved proceeding after the
 *   check paused the task.
 * - `replace-approved:step:<n>` — the user approved saving over an
 *   already-saved login before save_login step <n>.
 * A submit step that follows a fill is re-checked at the submit itself:
 * a runner verification (`login-verified`) is point-in-time — a step
 * between the fill and the submit may have rewritten the username field,
 * so the gate re-reads the page and checks again instead of trusting the
 * constraint recorded after the fill. A user approval (`login-approved`)
 * is different: it covers the account that was filled when the question
 * was asked, recorded alongside it as `login-approved-account:step:<n>`,
 * so the gate honours it only while that same account is still filled.
 * A fill that completed without a check — reconciled after an unknown
 * outcome, or ok in an earlier run — is caught the same way.
 *
 * The replace-login warning is the same shape for the other direction:
 * before `browser_vault {save_login}` on an origin that already has a
 * saved login under a DIFFERENT username, the task asks first and does
 * not save until answered. A re-save under the same username needs no
 * warning.
 */
import { rawResultOf } from '../tools/types.js';
import type { ToolDefinition, ToolHost, ToolResult } from '../tools/types.js';
import type { Task, TaskStep } from './types.js';
import type { PageSnapshot } from './verify.js';
import { resultText } from './verify.js';
import { IDENTIFIER_NAMES, PASSWORD_NAMES } from './session.js';

/** The per-step login-verified constraint the runner records after a matching fill. */
export function loginVerifiedConstraint(stepIndex: number): string {
  return `login-verified:step:${stepIndex}`;
}

/** The per-step login approval constraint a `proceed` answer records. */
export function loginApprovedConstraint(stepIndex: number): string {
  return `login-approved:step:${stepIndex}`;
}

/** The per-step replace approval constraint a `yes` answer records. */
export function replaceApprovedConstraint(stepIndex: number): string {
  return `replace-approved:step:${stepIndex}`;
}

/** Whether the task carries a passing login check for fill step `stepIndex` — verified by the runner, or approved by the user. */
export function hasLoginCheck(task: Task, stepIndex: number): boolean {
  return (
    task.constraints.includes(loginVerifiedConstraint(stepIndex)) ||
    task.constraints.includes(loginApprovedConstraint(stepIndex))
  );
}

/** Whether the user approved proceeding after the check for fill step `stepIndex`. */
export function hasLoginApproval(task: Task, stepIndex: number): boolean {
  return task.constraints.includes(loginApprovedConstraint(stepIndex));
}

/**
 * The account a `proceed` answer approved proceeding as, for fill step
 * `stepIndex` — recorded next to the `login-approved` constraint when the
 * question is answered (`questions.ts`). An empty account means the
 * approval was given while the filled account was unreadable. The
 * approval covers this account only: if the field holds a different
 * account by submit time, the approval no longer applies.
 */
export function loginApprovedAccountConstraint(stepIndex: number, filledAccount: string | undefined): string {
  return `login-approved-account:step:${stepIndex}:${filledAccount ?? ''}`;
}

/**
 * The filled account a recorded `proceed` approval covered — the latest
 * one, when the user approved more than once for the same fill step — or
 * undefined when no approval recorded the account (an approval from
 * before this record existed). An empty string means the approval was
 * given while the filled account was unreadable.
 */
export function approvedAccountOf(task: Task, stepIndex: number): string | undefined {
  const prefix = `login-approved-account:step:${stepIndex}:`;
  let found: string | undefined;
  for (const constraint of task.constraints) {
    if (constraint.startsWith(prefix)) found = constraint;
  }
  return found === undefined ? undefined : found.slice(prefix.length);
}

/** Whether this step is a vault fill (`browser_vault {fill}`). */
export function isVaultFillStep(step: TaskStep): boolean {
  return step.tool === 'browser_vault' && step.params.action === 'fill';
}

/** Whether this step is a vault save-login (`browser_vault {save_login}`). */
export function isVaultSaveLoginStep(step: TaskStep): boolean {
  return step.tool === 'browser_vault' && step.params.action === 'save_login';
}

/**
 * The account the task meant to log in as, declared on the fill step's
 * params as `expectedAccount`. Undefined when absent, blank, or not a
 * string: the check then cannot compare and must ask the user instead.
 */
export function expectedAccountOf(step: TaskStep): string | undefined {
  const expected = step.params.expectedAccount;
  if (typeof expected !== 'string') return undefined;
  const trimmed = expected.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * The accessible name quoted in one accessibility-tree textbox line, e.g.
 * `Email` in `- textbox "Email" [ref=e1] value="a@b.c"` — the same line
 * format `session.ts` reads. Undefined when the line is not a textbox
 * line. The `value="…"` suffix is a JSON-quoted token, so it is parsed
 * rather than split on quotes; flags (`disabled`, …) and a `context=`
 * suffix may follow it, so the value is the quoted token after `value=`,
 * not the rest of the line.
 */
function textboxFieldOf(line: string): { name: string; value?: string } | undefined {
  const match = /^\s*(?:-\s+)?textbox\s+"([^"]*)"(?:\s+\[ref=[^\]]*\]|\s+\[[^\]]*\])?(?:\s+value=("(?:[^"\\]|\\.)*"))?/iu.exec(line);
  if (!match) return undefined;
  const name = match[1] ?? '';
  const rawValue = match[2];
  if (rawValue === undefined) return { name };
  try {
    const parsed: unknown = JSON.parse(rawValue);
    return typeof parsed === 'string' ? { name, value: parsed } : { name };
  } catch {
    return { name };
  }
}

function hasWord(name: string, words: readonly string[]): boolean {
  const lowered = name.toLowerCase();
  return words.some((word) => lowered.includes(word.toLowerCase()));
}

/**
 * The username the page shows filled in the login form: the value of the
 * first identifier-named textbox (`email`, `username`, `phone`, … — the
 * same names `session.ts` uses) that carries a non-empty value. Password
 * fields are skipped outright, and a redacted value (`••••`, what the
 * snapshot writes for a sensitive field) counts as unreadable, not as a
 * username. Undefined when no identifier field with a value is on the
 * page: the caller must ask the user instead of guessing.
 */
export function extractFilledUsername(snapshot: PageSnapshot): string | undefined {
  for (const line of snapshot.text.split('\n')) {
    const field = textboxFieldOf(line);
    if (!field) continue;
    if (hasWord(field.name, PASSWORD_NAMES)) continue;
    if (!hasWord(field.name, IDENTIFIER_NAMES)) continue;
    if (field.value === undefined) continue;
    const value = field.value.trim();
    if (value === '' || value === '••••') continue;
    return value;
  }
  return undefined;
}

/** Whether two usernames name the same account: trimmed, case-insensitive — an email's case never distinguishes its account. */
export function usernamesMatch(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** What the filled-account check found: a match, a mismatch, or too little to compare. */
export type LoginCheckOutcome =
  | { status: 'match'; filled: string; expected: string }
  | { status: 'mismatch'; filled: string; expected: string }
  | { status: 'unknown'; filled?: string; expected?: string };

/**
 * Compare the filled username in the snapshot with the expected account.
 * `unknown` when either side is missing — no expected account declared,
 * or no username readable in the snapshot — so the caller asks the user
 * instead of deciding on half the facts.
 */
export function checkFilledAccount(snapshot: PageSnapshot, expected: string | undefined): LoginCheckOutcome {
  const filled = extractFilledUsername(snapshot);
  if (filled === undefined || expected === undefined) return { status: 'unknown', ...(filled !== undefined ? { filled } : {}), ...(expected !== undefined ? { expected } : {}) };
  return usernamesMatch(filled, expected)
    ? { status: 'match', filled, expected }
    : { status: 'mismatch', filled, expected };
}

/** The login-check question text: it names the filled account and, when known, the expected one — never a password. */
export function loginCheckQuestionText(outcome: LoginCheckOutcome): string {
  if (outcome.status === 'mismatch') {
    return `الدخول ده لحساب ${outcome.filled}، والمطلوب ${outcome.expected} — أكمّل ولا أوقف؟`;
  }
  if (outcome.status === 'unknown' && outcome.filled !== undefined) {
    return outcome.expected !== undefined
      ? `الدخول ده لحساب ${outcome.filled}، والمطلوب ${outcome.expected}، ومش قادر أتأكد إنهم نفس الحساب — أكمّل ولا أوقف؟`
      : `الدخول ده لحساب ${outcome.filled}، ومفيش حساب مطلوب متسجّل في المهمة — أكمّل ولا أوقف؟`;
  }
  if (outcome.status === 'unknown' && outcome.expected !== undefined) {
    return `مش قادر أقرأ اسم المستخدم المعبأ في نموذج الدخول، والمطلوب ${outcome.expected} — أكمّل ولا أوقف؟`;
  }
  return 'مش قادر أقرأ اسم المستخدم المعبأ في نموذج الدخول، ومفيش حساب مطلوب متسجّل في المهمة — أكمّل ولا أوقف؟';
}

/** Accessible names of a sign-in submit control — the same names `session.ts` uses, plus `submit` itself. */
const SUBMIT_NAMES = ['sign in', 'log in', 'login', 'submit', 'تسجيل الدخول', 'دخول', 'إرسال'];

/** Whether a `browser_type` key press submits: one Enter token in the key (a combo or a sequence may carry it) — `Return` is the same key on the other keyboard layout. */
function keySubmits(key: string): boolean {
  return key
    .split(/[\s+]+/u)
    .some((token) => {
      const lowered = token.toLowerCase();
      return lowered === 'enter' || lowered === 'return';
    });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * The control a snapshot line names for one ref (`e3` in
 * `- button "Sign in" [ref=e3]`, or the short `[e3]` form): its role and
 * accessible name. Undefined when no line carries that ref — a string
 * target can also be a selector or coordinates, which no snapshot line
 * names. Exported for the gate's tests; the submit check below is its
 * only production caller.
 */
export function snapshotControlForRef(
  snapshot: PageSnapshot,
  ref: string,
): { role: string; name: string } | undefined {
  const pattern = new RegExp(`\\[(?:ref=)?${escapeRegExp(ref)}\\]`, 'u');
  for (const line of snapshot.text.split('\n')) {
    if (!pattern.test(line)) continue;
    const match = /^\s*(?:-\s+)?([A-Za-z]+)\s+"([^"]*)"/u.exec(line);
    if (!match) return undefined;
    return { role: match[1] ?? '', name: match[2] ?? '' };
  }
  return undefined;
}

/**
 * Whether this step submits a form: `browser_type` with `submit: true`
 * or an Enter/Return key, a `browser_click` on a sign-in/submit control
 * (a hover-only click never submits), or a `browser_evaluate` — a
 * scripted step can submit the form (`form.submit()`, a click through
 * JS), and its expression cannot prove it does not, so the submit gate
 * treats every evaluate after a fill as a submit; with no fill before
 * it the gate has nothing to hold, so a read-only evaluate elsewhere is
 * unaffected. A click target given as a bare string — a ref or a
 * selector — is resolved against the snapshot when one is given: the
 * ref's control name decides. Without a snapshot, or when the snapshot
 * names no control for the ref, the click fails safe as a submit: an
 * unresolvable string target could be the Sign in button, and the gate
 * exists to stop an unchecked submit, not to guess that it is harmless.
 * Anything else is not a submit step.
 */
export function isSubmitStep(step: TaskStep, snapshot?: PageSnapshot): boolean {
  if (step.tool === 'browser_type') {
    if (step.params.submit === true) return true;
    return typeof step.params.key === 'string' && keySubmits(step.params.key);
  }
  if (step.tool === 'browser_evaluate') return true;
  if (step.tool === 'browser_click') {
    if (step.params.hover === true) return false;
    const target = step.params.target;
    if (target && typeof target === 'object' && typeof (target as Record<string, unknown>).name === 'string') {
      return hasWord((target as Record<string, unknown>).name as string, SUBMIT_NAMES);
    }
    if (typeof target === 'string') {
      if (snapshot === undefined) return true;
      const control = snapshotControlForRef(snapshot, target);
      if (control === undefined) return true;
      return hasWord(control.name, SUBMIT_NAMES);
    }
    return false;
  }
  return false;
}

/**
 * The latest vault-fill step that already ran (`ok`) but has no passing
 * login check recorded for it — the fill a submit step must not follow
 * unchecked. Only fills before `beforeIndex` count: a fill listed after
 * the submit step has not happened yet from the submit's point of view.
 * Undefined when every completed fill was checked, or no fill ran: the
 * submit gate has nothing to hold.
 */
export function latestUnverifiedFillIndex(task: Task, beforeIndex?: number): number | undefined {
  let latest: number | undefined;
  const end = beforeIndex === undefined ? task.steps.length : Math.min(beforeIndex, task.steps.length);
  for (let index = 0; index < end; index++) {
    const step = task.steps[index]!;
    if (!isVaultFillStep(step)) continue;
    if (step.result?.status !== 'ok') continue;
    if (hasLoginCheck(task, index)) continue;
    latest = index;
  }
  return latest;
}

/**
 * The latest vault-fill step that already ran (`ok`) before
 * `beforeIndex` — verified or not. The submit gate re-checks this fill
 * at every submit: a verification recorded after the fill is
 * point-in-time, so it is not trusted from the fill onward.
 */
export function latestFillIndex(task: Task, beforeIndex?: number): number | undefined {
  let latest: number | undefined;
  const end = beforeIndex === undefined ? task.steps.length : Math.min(beforeIndex, task.steps.length);
  for (let index = 0; index < end; index++) {
    const step = task.steps[index]!;
    if (!isVaultFillStep(step)) continue;
    if (step.result?.status !== 'ok') continue;
    latest = index;
  }
  return latest;
}

/** One saved login, by the username it was saved under — the only field the replace check needs. */
export interface SavedLogin {
  username: string;
}

/**
 * List the logins saved for one origin. The runner injects this (tests
 * pass a fake); the default below reads them through the vault tool
 * itself (`browser_vault {list}`), the existing read-only vault API —
 * its accounts carry the public `identifier` metadata, never a password.
 */
export type ListSavedLoginsFn = (origin: string, tabId?: number) => Promise<SavedLogin[]>;

/**
 * The default saved-login lister: `browser_vault {action: "list"}` on
 * the step's tab, parsed from the raw result's `accounts` — each entry's
 * public `identifier`. Throws when the tool or the host is unavailable,
 * or the list call fails: the caller then asks the user instead of
 * saving over an account it could not see.
 */
export async function defaultListSavedLogins(
  tools: ReadonlyMap<string, ToolDefinition>,
  host: ToolHost | undefined,
  tabId: number | undefined,
  origin: string,
): Promise<SavedLogin[]> {
  const def = tools.get('browser_vault');
  if (!def) throw new Error(`vault list unavailable for ${origin}: no browser_vault tool available to list the saved logins`);
  if (!host) throw new Error(`vault list unavailable for ${origin}: no tool host available to list the saved logins`);
  const params: Record<string, unknown> = { action: 'list' };
  if (tabId !== undefined) params.tabId = tabId;
  let result: ToolResult;
  try {
    result = await def.handler(host, params);
  } catch (error) {
    throw new Error(`vault list failed for ${origin}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (result.isError) throw new Error(`vault list failed for ${origin}: ${resultText(result)}`);
  const raw = rawResultOf(result);
  const accounts = raw?.accounts;
  if (!Array.isArray(accounts)) throw new Error(`vault list failed for ${origin}: the list result carries no accounts`);
  const saved: SavedLogin[] = [];
  for (const entry of accounts) {
    if (entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).identifier === 'string') {
      const username = ((entry as Record<string, unknown>).identifier as string).trim();
      if (username !== '') saved.push({ username });
    }
  }
  return saved;
}

/**
 * The saved login a save would replace: the first saved username that
 * differs from the username about to be saved. When the username about
 * to be saved is unreadable, any saved login is a possible replace, so
 * the first saved username is named. Undefined when nothing is saved,
 * or every saved login is the same username being re-saved.
 */
export function findDifferentSavedLogin(saved: SavedLogin[], filledUsername: string | undefined): string | undefined {
  for (const entry of saved) {
    if (filledUsername === undefined || !usernamesMatch(entry.username, filledUsername)) return entry.username;
  }
  return undefined;
}

/** The replace-login question text: it names the already-saved username the save would replace. */
export function replaceQuestionText(existingAccount: string, origin: string): string {
  return `فيه دخول محفوظ لـ ${existingAccount} على ${origin} — أستبدله بالدخول الحالي؟`;
}

/** The replace question when the saved logins could not be listed: the user decides with that stated, not silently. */
export function replaceUnknownQuestionText(origin: string): string {
  return `مش قادر أتحقق من الدخول المحفوظ على ${origin} قبل الحفظ — أحفظ الدخول الحالي؟`;
}
