/**
 * The Gap B gates (plan §3): the post-fill username check and the
 * replace-login warning, as the runner runs them.
 *
 * Lives apart from `runner.ts` for the same reason `mutations.ts` does:
 * the runner sits exactly on the 600-line maintenance gate
 * (`tests/architecture-maintenance.test.ts`), so the gate logic lives here
 * and the runner calls it at four hook points — after a fill verifies,
 * after a fill is reconciled, before a submit step runs, and before a
 * save_login step runs. The pure check itself (username extraction,
 * comparison, question texts, submit detection, constraint names) lives
 * in `login-check.ts`; this module is the orchestration: snapshots,
 * questions, saves, and the returns that stop a run.
 *
 * A gate returns the task to return (paused in `paused-question`, or
 * failed) when it stops the run, or null to keep running. The runner's
 * only job at each hook is `const held = await gate(...); if (held)
 * return held;` — the gate never executes a step itself, and it never
 * submits anything.
 *
 * The password field value is never read, logged, or included in
 * evidence anywhere in these gates: see `login-check.ts`.
 */
import { loadTask } from './store.js';
import { saveTaskUnlessCancelled } from './cancel-guard.js';
import { failStep, failTask } from './fail.js';
import { originOf } from './session.js';
import { readFreshSnapshot, type PageSnapshot } from './verify.js';
import { redactParamsForQuestion } from './questions.js';
import {
  approvedAccountOf,
  checkFilledAccount,
  defaultListSavedLogins,
  expectedAccountOf,
  extractFilledUsername,
  findDifferentSavedLogin,
  hasLoginApproval,
  hasUsernameField,
  isSubmitStep,
  isVaultFillStep,
  isVaultSaveLoginStep,
  latestFillIndex,
  loginCheckQuestionText,
  loginVerifiedConstraint,
  replaceApprovedConstraint,
  replaceQuestionText,
  replaceUnknownQuestionText,
  usernamesMatch,
  type LoginCheckOutcome,
  type SavedLogin,
} from './login-check.js';
import type { Task, TaskStep } from './types.js';
import type { ToolDefinition } from '../tools/types.js';
import type { RunTaskOptions } from './runner.js';

/**
 * The post-fill username check, run against a snapshot taken after a
 * vault fill: compare the filled username with the account the fill step
 * declared, and stop the task before anything submits when they do not
 * match — or when either side cannot be read.
 *
 * A match records the `login-verified` constraint for the fill step and
 * saves it, so a later submit step — in this run or a resumed one —
 * knows the fill was checked and does not ask again. A mismatch (or an
 * unreadable side) records the evidence naming what is known, then asks
 * the user through the question protocol — `proceed` resumes from the
 * held step (`heldStepIndex`: the submit step, or the fill itself when it
 * is the last step), `stop` fails the task in `answerQuestion`. With no
 * question channel wired the task fails closed instead of submitting
 * unchecked.
 */
export async function checkFillAndMaybePause(
  task: Task,
  fillStep: TaskStep,
  fillIndex: number,
  snapshot: PageSnapshot,
  heldStepIndex: number,
  options: RunTaskOptions,
): Promise<Task | null> {
  const outcome: LoginCheckOutcome = checkFilledAccount(snapshot, expectedAccountOf(fillStep));
  if (outcome.status === 'match') {
    if (!task.constraints.includes(loginVerifiedConstraint(fillIndex))) {
      task.constraints.push(loginVerifiedConstraint(fillIndex));
    }
    task.evidence.push(
      `login check passed after step ${fillIndex + 1} (browser_vault fill): the filled account ${outcome.filled} matches the expected account ${outcome.expected} — submitting may proceed`,
    );
    await saveTaskUnlessCancelled(task, options.tasksDir);
    return null;
  }
  const known =
    outcome.status === 'mismatch'
      ? `the filled account ${outcome.filled} does not match the expected account ${outcome.expected}`
      : outcome.filled !== undefined
        ? `the filled account ${outcome.filled} could not be confirmed against the expected account ${outcome.expected ?? '(no expected account declared)'}`
        : `the filled username could not be read from the page (expected account ${outcome.expected ?? '(no expected account declared)'})`;
  task.evidence.push(`login check after step ${fillIndex + 1} (browser_vault fill): ${known} — stopping before submit`);
  await saveTaskUnlessCancelled(task, options.tasksDir);
  if (!options.questions?.ask) {
    await failTask(task, `login check failed: ${known} — no question channel is wired to ask the user, so the task stops before submit`, options.tasksDir);
    return task;
  }
  try {
    await options.questions.ask({
      taskId: task.id,
      text: loginCheckQuestionText(outcome),
      options: ['proceed', 'stop'],
      kind: 'confirm',
      context: {
        stepIndex: heldStepIndex,
        tool: fillStep.tool,
        params: [],
        purpose: 'login-check',
        fillStepIndex: fillIndex,
        ...(outcome.filled !== undefined ? { filledAccount: outcome.filled } : {}),
        ...(outcome.expected !== undefined ? { expectedAccount: outcome.expected } : {}),
      },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await failTask(task, `login check failed: ${known} — could not ask the user (${detail}), so the task stops before submit`, options.tasksDir);
    return task;
  }
  const paused = await loadTask(task.id, options.tasksDir);
  return paused ?? task;
}

/**
 * The check for a fill that was reconciled rather than run in this pass
 * — confirmed after an unknown outcome, either by the retry policy's
 * reconciliation or by the resume's re-read of an `unknown` step. The
 * fill is confirmed to have happened, but its username was never
 * checked: check it now, against a fresh snapshot, before anything later
 * in the task can submit as that account. Not a fill step, nothing to
 * check: returns null. A snapshot that cannot be read fails the task
 * rather than submitting unchecked.
 */
export async function checkFillAfterReconcile(
  task: Task,
  step: TaskStep,
  index: number,
  tabId: number | undefined,
  options: RunTaskOptions,
  tools: ReadonlyMap<string, ToolDefinition>,
): Promise<Task | null> {
  if (!isVaultFillStep(step)) return null;
  let snapshot: PageSnapshot;
  try {
    snapshot = await readFreshSnapshot(tools, options.host, tabId, 'to check the filled account after reconciling the step');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await failTask(task, `could not verify the filled account after reconciling step ${index + 1} (browser_vault fill): ${detail}`, options.tasksDir);
    return task;
  }
  return checkFillAndMaybePause(task, step, index, snapshot, index + 1 < task.steps.length ? index + 1 : index, options);
}

/**
 * The gates that run before a step executes, in order:
 *
 * - The submit gate: a submit step that follows a vault fill must not
 *   execute on an account that has not just been checked. The gate
 *   re-reads the page and checks the filled account at every submit
 *   following a fill — one extra snapshot read per submit — because a
 *   verification recorded after the fill is point-in-time: any step
 *   between the fill and the submit (typing, a fill, a script) may have
 *   rewritten the username field, and so may page script. A click
 *   target is resolved against the snapshot just read: a string ref it
 *   names as a non-submit control, or an object target whose name is
 *   outside SUBMIT_NAMES, skips the check only when the page shows no
 *   username field at all — the positive sign the login form is gone,
 *   so the click is post-login. A non-submit name alone cannot clear
 *   the check: a submit button labelled "Continue", "Next", or anything
 *   outside SUBMIT_NAMES still submits, so on a page that still shows
 *   a username field the check runs and the click is held until the
 *   filled account is confirmed. A target the snapshot does not name,
 *   and an object target with no name, still fail safe as a submit. The normal
 *   path checks right after the fill, so this is the net for a fill
 *   that completed without a check (reconciled, or ok in an earlier
 *   run) and the re-check for a fill whose verification may since have
 *   gone stale. A recorded `proceed` approval is honoured only while
 *   the account it was given for is still the filled one
 *   (`login-approved-account`): the user approved proceeding as that
 *   account, not as whatever the field holds now. A snapshot that
 *   cannot be read fails the submit step as `verify-failed`: the step
 *   never runs on an unverified account.
 * - The replace-login warning: before a save_login step runs, list the
 *   logins already saved for the page's origin. A different saved
 *   username means the save would replace that login, so the task asks
 *   first and does not save until answered; the same username (a
 *   re-save) or nothing saved needs no warning. A save the user already
 *   approved is recorded on the task and never re-asked. When the saved
 *   logins cannot be listed at all, the task asks anyway — the user
 *   decides with that stated — instead of saving over an account it
 *   could not see.
 */
export async function runPreStepGates(
  task: Task,
  step: TaskStep,
  index: number,
  validated: Record<string, unknown>,
  boundTabId: number | undefined,
  lastUrl: string | undefined,
  options: RunTaskOptions,
  tools: ReadonlyMap<string, ToolDefinition>,
): Promise<Task | null> {
  if (isSubmitStep(step)) {
    const fillIndex = latestFillIndex(task, index);
    if (fillIndex !== undefined) {
      const gateTabId = typeof validated.tabId === 'number' ? validated.tabId : boundTabId;
      let gateSnapshot: PageSnapshot;
      try {
        gateSnapshot = await readFreshSnapshot(tools, options.host, gateTabId, 'to check the filled account before submit');
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        await failStep(task, step, index, 'verify-failed', `cannot verify the filled account before submit: ${detail}`, options.tasksDir);
        return task;
      }
      // A click target the snapshot resolves as a non-submit control —
      // a string ref it names, or an object target whose name is
      // outside SUBMIT_NAMES — skips the check ONLY when the page shows
      // no username field at all — the positive sign the login form is
      // gone, so the click is post-login and there is no filled account
      // left to check. The fail-safe `isSubmitStep(step)` call above
      // has no snapshot to resolve the target against, but this gate
      // just read one — so resolve the target against it, and then ask
      // whether the form is still there, before holding the step. A
      // name alone cannot clear a submit: "Continue" is a routine
      // multi-step-login label outside SUBMIT_NAMES, and an icon-only
      // button has no name at all. And a missing filled username cannot
      // clear it either: `extractFilledUsername` returns undefined both
      // when no field exists and when the field exists but its value
      // cannot be read, so the skip tests field presence
      // (`hasUsernameField`), not the filled value — a
      // present-but-unreadable field still runs the check, which pauses
      // on `unknown` as before. A target the snapshot does not name,
      // and an object target with no name, still fail safe as a submit.
      if (isSubmitStep(step, gateSnapshot) || hasUsernameField(gateSnapshot)) {
        // A recorded approval covers the account it was given for, and
        // only that account: while the same account is still filled, the
        // submit runs without re-asking. Anything else — a runner
        // verification from fill time, no check at all, or an approval
        // whose account is no longer filled — is re-checked now, against
        // the snapshot just read, before the submit runs.
        let stillApproved = false;
        if (hasLoginApproval(task, fillIndex)) {
          const approved = approvedAccountOf(task, fillIndex);
          const filled = extractFilledUsername(gateSnapshot);
          stillApproved =
            approved !== undefined &&
            ((approved === '' && filled === undefined) ||
              (approved !== '' && filled !== undefined && usernamesMatch(filled, approved)));
        }
        if (!stillApproved) {
          const held = await checkFillAndMaybePause(task, task.steps[fillIndex]!, fillIndex, gateSnapshot, index, options);
          if (held) return held;
        }
      }
    }
  }

  if (isVaultSaveLoginStep(step) && !task.constraints.includes(replaceApprovedConstraint(index))) {
    const saveTabId = typeof validated.tabId === 'number' ? validated.tabId : boundTabId;
    let page: PageSnapshot;
    try {
      page = await readFreshSnapshot(tools, options.host, saveTabId, 'to check the saved logins before save_login');
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await failStep(task, step, index, 'failed', `cannot check the saved logins before save_login: ${detail}`, options.tasksDir);
      return task;
    }
    const origin = originOf(page.url) || originOf(lastUrl);
    if (origin === '') {
      await failStep(task, step, index, 'failed', 'cannot determine the origin to check the saved logins before save_login', options.tasksDir);
      return task;
    }
    const filled = extractFilledUsername(page);
    const listAccounts = options.vault?.listAccounts ?? ((listOrigin: string, listTabId?: number) => defaultListSavedLogins(tools, options.host, listTabId, listOrigin));
    let saved: SavedLogin[];
    try {
      saved = await listAccounts(origin, saveTabId);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      task.evidence.push(`step ${index + 1} (browser_vault): could not list the saved logins for ${origin} before save_login (${detail}) — asking before saving`);
      await saveTaskUnlessCancelled(task, options.tasksDir);
      if (!options.questions?.ask) {
        await failTask(task, `save_login refused: could not list the saved logins for ${origin}, and no question channel is wired to ask before saving over an unseen account`, options.tasksDir);
        return task;
      }
      try {
        await options.questions.ask({
          taskId: task.id,
          text: replaceUnknownQuestionText(origin),
          options: ['yes', 'no'],
          kind: 'confirm',
          context: { stepIndex: index, tool: step.tool, params: redactParamsForQuestion(validated), purpose: 'replace-login' },
        });
      } catch (askError) {
        const askDetail = askError instanceof Error ? askError.message : String(askError);
        await failStep(task, step, index, 'failed', askDetail, options.tasksDir);
        return task;
      }
      const paused = await loadTask(task.id, options.tasksDir);
      return paused ?? task;
    }
    const different = findDifferentSavedLogin(saved, filled);
    if (different !== undefined) {
      task.evidence.push(
        `step ${index + 1} (browser_vault): save_login would replace the saved login for ${different} on ${origin}${filled !== undefined ? ` (the filled account is ${filled})` : ''} — asking before saving`,
      );
      await saveTaskUnlessCancelled(task, options.tasksDir);
      if (!options.questions?.ask) {
        await failTask(task, `save_login refused: a login is already saved for ${different} on ${origin}, and no question channel is wired to ask before replacing it`, options.tasksDir);
        return task;
      }
      try {
        await options.questions.ask({
          taskId: task.id,
          text: replaceQuestionText(different, origin),
          options: ['yes', 'no'],
          kind: 'confirm',
          context: { stepIndex: index, tool: step.tool, params: redactParamsForQuestion(validated), purpose: 'replace-login', existingAccount: different },
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        await failStep(task, step, index, 'failed', detail, options.tasksDir);
        return task;
      }
      const paused = await loadTask(task.id, options.tasksDir);
      return paused ?? task;
    }
  }
  return null;
}
