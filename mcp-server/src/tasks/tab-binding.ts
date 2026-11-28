/**
 * Tab binding helpers, moved out of `runner.ts`: the runner sits exactly
 * on the 600-line maintenance gate
 * (`tests/architecture-maintenance.test.ts`), so the tab a step acted on
 * — and the tab the completed steps already bound — is resolved here and
 * the runner imports it. The rules are unchanged from where they lived.
 */
import { rawResultOf } from '../tools/types.js';
import type { ToolResult } from '../tools/types.js';
import type { Task } from './types.js';

/**
 * The tab a step's result names, if any: the `tabId` a navigate/snapshot
 * result carries, or the first tab of a `browser_tabs list` result — the
 * session's own tab, else the user's focused tab
 * (`extension/handlers/tabs.js`, `listTabs`).
 */
export function tabIdFromResult(result: ToolResult): number | undefined {
  const raw = rawResultOf(result);
  if (!raw) return undefined;
  if (typeof raw.tabId === 'number') return raw.tabId;
  const tabs = raw.tabs;
  if (Array.isArray(tabs)) {
    for (const entry of tabs) {
      if (entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).tabId === 'number') {
        return (entry as Record<string, unknown>).tabId as number;
      }
    }
  }
  return undefined;
}

/** The tab the completed steps already bound, if any — the resume rebind. A step recorded `unknown` executed too, so its tab counts: it is the tab the resume must reconcile — and re-run — on. */
export function boundTabFromCompletedSteps(task: Task): number | undefined {
  let bound: number | undefined;
  for (const step of task.steps) {
    if (step.result?.status !== 'ok' && step.result?.status !== 'unknown') continue;
    if (typeof step.params.tabId === 'number') bound = step.params.tabId;
  }
  return bound;
}
