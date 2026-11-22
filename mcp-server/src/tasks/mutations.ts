/**
 * The read-only default's mutation classification (FR-020, binding ruling P4).
 *
 * Moved out of `runner.ts` (Task 8): the runner sits exactly on the
 * 600-line maintenance gate, so the classification lives here and the
 * runner imports it. The rules are unchanged from where they lived.
 *
 * What counts as mutating is a per-tool, per-action classification —
 * NOT the retry-safety `idempotent` flag, which only says whether
 * re-running the tool is safe. A tool that only reads is `idempotent:
 * true` and so is never mutating here; a non-idempotent tool is mutating
 * unless one of the mixed-tool rules below says its form is a read.
 * Anything not listed is mutating: the gate fails closed on tools it
 * does not know.
 */
import type { ToolDefinition } from '../tools/types.js';
import { mutationApprovalConstraint } from './questions.js';
import type { Task } from './types.js';

/** The constraint that explicitly approves mutating steps in a task (FR-020). */
export const ALLOW_MUTATIONS = 'allow-mutations';

/** `browser_navigate` forms that move history or reload instead of opening a URL. */
export const NAVIGATE_HISTORY_ACTIONS = new Set(['back', 'forward', 'reload']);

/**
 * Whether a plain-URL `browser_navigate` is the only read form: it changes
 * the viewed page, not site data, so a read-only audit task may navigate.
 * History moves and reloads can resubmit or revisit, and `incognito:true`
 * opens a new private window, so those are mutating and need approval.
 */
function isMutatingNavigate(params: Record<string, unknown>): boolean {
  if (params.incognito === true) return true;
  return typeof params.url === 'string' && NAVIGATE_HISTORY_ACTIONS.has(params.url);
}

/**
 * Whether a `browser_tabs` call changes anything: closing a tab, selecting
 * a browser profile, or setting session policy does. Listing, listing
 * profiles, focusing a tab (a view change, like navigating), and reading the
 * session policy do not.
 */
function isMutatingTabs(params: Record<string, unknown>): boolean {
  if (params.action === 'close') return true;
  if (params.browser !== undefined) return true;
  if (params.action === 'session' && (params.isolation !== undefined || params.access !== undefined)) return true;
  return false;
}

/**
 * Whether running this tool with these params can change site data
 * (save/send/delete) — the FR-020 question — and so needs explicit approval.
 */
export function isMutatingTool(def: ToolDefinition, params: Record<string, unknown> = {}): boolean {
  if (def.idempotent === true) return false;
  switch (def.name) {
    case 'browser_navigate':
      return isMutatingNavigate(params);
    case 'browser_logs':
      // `clear:true` empties the log buffer; reading the logs does not.
      return params.clear === true;
    case 'browser_tabs':
      return isMutatingTabs(params);
    default:
      return true;
  }
}

/**
 * Whether the task carries explicit approval for mutating steps: the
 * blanket `allow-mutations` constraint, or a per-step approval recorded by
 * a `yes` answer to a mutation-approval question
 * (`mutationApprovalConstraint`, `questions.ts`) — that step only.
 */
export function taskAllowsMutations(task: Task, stepIndex?: number): boolean {
  if (task.constraints.includes(ALLOW_MUTATIONS)) return true;
  return stepIndex !== undefined && task.constraints.includes(mutationApprovalConstraint(stepIndex));
}
