/**
 * The task planner (specs/011-professional-browsing-layer, FR-002/FR-020).
 *
 * `planTask` turns a goal into ordered steps. It knows no site, so it plans
 * only what any goal can support: navigate to a URL named in the goal (when
 * there is one) and read the page back with a snapshot. Every step carries at
 * least one verify rule; the plan emits no mutating step at all, so a planned
 * task is read-only until a later step (or an explicit approval) adds one.
 * The planner is pure: it returns the task, and the caller saves it.
 */
import { randomUUID } from 'node:crypto';
import type { Task, TaskStep, VerifyRule } from './types.js';

const URL_PATTERN = /https?:\/\/[^\s"'<>]+/u;
/** Sentence punctuation a goal may leave after a URL ("see https://example.com."). */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}]+$/u;
/** The Chrome error text a page must not show (plan §3, FR-007). */
const ERROR_TEXT = "isn't working";

function noErrorText(): VerifyRule {
  return { kind: 'no-error-text', value: ERROR_TEXT };
}

/**
 * Split a goal into steps. A URL in the goal becomes a navigate step verified
 * against its host, followed by a snapshot step; a goal with no URL plans a
 * snapshot of the current tab. Throws on an empty goal.
 */
export function planTask(goal: string, constraints: string[] = []): Task {
  const trimmed = goal.trim();
  if (trimmed.length === 0) throw new Error('a task goal must not be empty');

  const steps: TaskStep[] = [];
  const match = URL_PATTERN.exec(trimmed);
  if (match) {
    const url = match[0].replace(TRAILING_PUNCTUATION, '');
    let host = url;
    try {
      host = new URL(url).host;
    } catch {
      // The regex already matched a URL shape; keep the raw text as the match value.
    }
    steps.push({
      tool: 'browser_navigate',
      params: { url },
      verify: [{ kind: 'url-contains', value: host }, noErrorText()],
    });
  }
  steps.push({ tool: 'browser_snapshot', params: {}, verify: [noErrorText()] });

  return {
    id: randomUUID(),
    goal: trimmed,
    constraints: [...constraints],
    steps,
    state: 'planned',
    evidence: [],
  };
}
