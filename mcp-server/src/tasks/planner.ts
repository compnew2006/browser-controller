/**
 * The task planner (specs/011-professional-browsing-layer, FR-002/FR-020).
 *
 * `planTask` turns a goal into ordered steps. It knows no site, so it plans
 * only what any goal can support: navigate to a URL named in the goal (when
 * there is one) and read the page back with a snapshot. Every step carries at
 * least one verify rule; the plan emits no mutating step at all, so a planned
 * task is read-only until a later step (or an explicit approval) adds one.
 * The planner is pure: it returns the task, and the caller saves it.
 *
 * Tab binding: `browser_snapshot` requires `tabId`, and the planner cannot
 * know it at plan time, so a plan never emits a bare snapshot. A URL goal
 * navigates first — the runner binds the tab the navigate opened and injects
 * it into the snapshot. A goal with no URL lists tabs first — the runner
 * binds the first listed tab (the session's own tab, else the user's focused
 * tab) and injects it into the snapshot. See `runner.ts`.
 */
import { randomUUID } from 'node:crypto';
import type { Task, TaskStep, VerifyRule } from './types.js';

const URL_PATTERN = /https?:\/\/[^\s"'<>]+/u;
/** Sentence punctuation a goal may leave after a URL ("see https://example.com."). */
const TRAILING_SENTENCE_PUNCTUATION = /[.,;:!?]+$/u;
/** A closing bracket and its opener, for the balance check below. */
const CLOSERS: Readonly<Record<string, string>> = { ')': '(', ']': '[', '}': '{' };

/**
 * Strip sentence punctuation after a URL, and a trailing closer only when
 * it is unbalanced — a Wikipedia-style URL such as
 * `https://en.wikipedia.org/wiki/PC_(x)` keeps its closing paren, while a
 * parenthesised mention `(see https://example.com/foo)` loses the closer
 * that only closes the sentence's own paren.
 */
function stripTrailingPunctuation(raw: string): string {
  let url = raw.replace(TRAILING_SENTENCE_PUNCTUATION, '');
  for (;;) {
    const last = url.at(-1);
    if (last === undefined) return url;
    const opener = CLOSERS[last];
    if (opener === undefined) return url;
    const opens = [...url].filter((ch) => ch === opener).length;
    const closes = [...url].filter((ch) => ch === last).length;
    if (closes <= opens) return url;
    url = url.slice(0, -1).replace(TRAILING_SENTENCE_PUNCTUATION, '');
  }
}
/** The Chrome error text a page must not show (plan §3, FR-007). */
const ERROR_TEXT = "isn't working";

function noErrorText(): VerifyRule {
  return { kind: 'no-error-text', value: ERROR_TEXT };
}

/**
 * Split a goal into steps. A URL in the goal becomes a navigate step verified
 * against its host, followed by a snapshot step; a goal with no URL plans a
 * tabs-list step followed by a snapshot of the first listed tab. The runner
 * binds the tab for the snapshot in both cases — the planner never emits a
 * snapshot with no way to target a tab. Throws on an empty goal.
 */
export function planTask(goal: string, constraints: string[] = []): Task {
  const trimmed = goal.trim();
  if (trimmed.length === 0) throw new Error('a task goal must not be empty');

  const steps: TaskStep[] = [];
  const match = URL_PATTERN.exec(trimmed);
  if (match) {
    const url = stripTrailingPunctuation(match[0]);
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
  } else {
    steps.push({
      tool: 'browser_tabs',
      params: { action: 'list' },
      verify: [noErrorText()],
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
