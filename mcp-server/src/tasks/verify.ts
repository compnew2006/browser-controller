/**
 * Post-step verification (specs/011-professional-browsing-layer, FR-007).
 *
 * `verifyStep` checks one executed step against the page as it actually is
 * after the step — never against the fact that the step's tool call returned
 * successfully. A navigation that "succeeded" but landed on an error page or
 * an empty page fails verification: the tool result alone is never evidence
 * of success.
 *
 * The input is a `PageSnapshot`: the page URL, the page text (the
 * accessibility tree `browser_snapshot` returns), and a reference naming
 * where the snapshot came from, so a failure's evidence always carries the
 * URL, the snapshot reference, and the observed text.
 *
 * Two checks run before the step's own rules, because they hold for every
 * step: an empty page cannot be a success, and a Chrome error page cannot
 * be one either, even when no rule names its text. The step's rules then run
 * in order and the first failure is reported.
 *
 * `element-count` counts snapshot lines whose accessibility-tree role token
 * is the selector: the snapshot is an accessibility tree (one element per
 * line, the role first), not a DOM, so there is no CSS query to run
 * against it. A selector that is not a bare role name — `#id`, `.class`,
 * `[attr]`, or anything with CSS syntax — fails naming itself as
 * unsupported instead of silently counting 0, so "no such element" and
 * "unsupported selector" are never confused.
 *
 * The snapshot readers live here too: `readSnapshotAfterStep` is the
 * fresh page read verification runs against after a step, and
 * `readFreshSnapshot` is the same read for reconciliation — the page
 * re-read that confirms whether an unknown step's effect happened.
 * Both are plain handler calls, not steps, so they need no P4 approval
 * (the snapshot tool is an idempotent read).
 */
import { rawResultOf } from '../tools/types.js';
import type { ToolDefinition, ToolHost, ToolResult } from '../tools/types.js';
import type { TaskStep, VerifyRule } from './types.js';

/** The page as it is after a step: URL, text, and where the snapshot came from. */
export interface PageSnapshot {
  url: string;
  text: string;
  /** What produced this snapshot, e.g. `browser_snapshot tab 42`. */
  ref?: string;
}

/** The outcome of verifying one step. */
export interface VerifyOutcome {
  ok: boolean;
  code?: 'VERIFY_FAILED';
  evidence: string;
}

/** Chrome error-page phrasing: any of these in the snapshot means an error page. */
const ERROR_PAGE_PHRASES = [
  "isn't working",
  "can't be reached",
  'aw, snap',
  'err_',
  'net::err',
  'connection refused',
];

/** How much of the observed text the evidence carries (bounded, never the whole page). */
const EVIDENCE_EXCERPT_CHARS = 200;

function excerpt(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length > EVIDENCE_EXCERPT_CHARS ? `${flat.slice(0, EVIDENCE_EXCERPT_CHARS)}…` : flat;
}

function evidenceFor(snapshot: PageSnapshot, detail: string): string {
  const url = snapshot.url === '' ? '(unknown url)' : snapshot.url;
  const ref = snapshot.ref ?? 'unseen';
  return `${detail} — url=${url}; snapshot=${ref}; observed="${excerpt(snapshot.text)}"`;
}

function failed(snapshot: PageSnapshot, detail: string): VerifyOutcome {
  return { ok: false, code: 'VERIFY_FAILED', evidence: evidenceFor(snapshot, detail) };
}

/** The `no-error-text` rule: the page must not contain the named text, and must not be empty. */
function checkNoErrorText(rule: Extract<VerifyRule, { kind: 'no-error-text' }>, snapshot: PageSnapshot): string | undefined {
  if (snapshot.text.trim() === '') return `page is empty, expected no error text "${rule.value}"`;
  if (snapshot.text.toLowerCase().includes(rule.value.toLowerCase())) {
    return `page shows error text "${rule.value}"`;
  }
  return undefined;
}

/** A bare accessibility-tree role name: one token of letters, digits, hyphens. */
const ROLE_NAME = /^[A-Za-z][A-Za-z0-9-]*$/;

/**
 * The role token at the start of one accessibility-tree line, e.g. `button`
 * in `  - button "Buy now" [ref=e2]` — indentation and the `- ` bullet are
 * not part of the role. Undefined when the line is not an element line (the
 * `page:` header, the truncation note). The token must be followed by
 * whitespace, a quote, a `[`, or the end of the line, so `button` never
 * matches `button-group` or a line whose label merely mentions the word.
 */
function roleOfLine(line: string): string | undefined {
  const match = /^\s*(?:-\s+)?([A-Za-z][A-Za-z0-9-]*)(?=\s|"|\[|$)/u.exec(line);
  return match?.[1]?.toLowerCase();
}

/** One rule against the snapshot; the failure detail, or undefined when it passes. */
function checkRule(rule: VerifyRule, snapshot: PageSnapshot): string | undefined {
  switch (rule.kind) {
    case 'url-contains':
      if (snapshot.url === '') return `url is unknown, expected it to contain "${rule.value}"`;
      if (!snapshot.url.includes(rule.value)) return `url does not contain "${rule.value}"`;
      return undefined;
    case 'text-present':
      if (!snapshot.text.toLowerCase().includes(rule.value.toLowerCase())) {
        return `page does not contain "${rule.value}"`;
      }
      return undefined;
    case 'element-count': {
      if (!ROLE_NAME.test(rule.selector)) {
        return `unsupported selector "${rule.selector}": element-count matches accessibility-tree role names only (e.g. "button"), not CSS selectors`;
      }
      const wanted = rule.selector.toLowerCase();
      const found = snapshot.text.split('\n').filter((line) => roleOfLine(line) === wanted).length;
      if (found !== rule.count) return `found ${found} element(s) matching "${rule.selector}", expected ${rule.count}`;
      return undefined;
    }
    case 'no-error-text':
      return checkNoErrorText(rule, snapshot);
  }
}

/**
 * Verify one step against the page snapshot taken after it. Returns
 * `{ ok: true }` only when the page itself — not the tool result — shows the
 * step succeeded; otherwise `{ ok: false, code: 'VERIFY_FAILED' }` with
 * evidence carrying the URL, the snapshot reference, and the observed text.
 */
export function verifyStep(step: TaskStep, snapshot: PageSnapshot): VerifyOutcome {
  if (snapshot.text.trim() === '') {
    return failed(snapshot, 'verification failed: page is empty');
  }
  const lowered = snapshot.text.toLowerCase();
  const errorPhrase = ERROR_PAGE_PHRASES.find((phrase) => lowered.includes(phrase));
  if (errorPhrase !== undefined) {
    return failed(snapshot, `verification failed: page shows an error ("${errorPhrase}")`);
  }
  for (const rule of step.verify) {
    const detail = checkRule(rule, snapshot);
    if (detail !== undefined) return failed(snapshot, `verification failed: ${detail}`);
  }
  const url = snapshot.url === '' ? '(unknown url)' : snapshot.url;
  const ref = snapshot.ref ?? 'unseen';
  return {
    ok: true,
    evidence: `verified ${step.verify.length} rule(s) at ${url}; snapshot=${ref}; observed="${excerpt(snapshot.text)}"`,
  };
}

/**
 * Build a snapshot from a tool result: the first text it carries, the URL
 * its raw result names (if any), and the caller's reference for the evidence.
 * Used when the step itself read the page (`browser_snapshot`): its own
 * result already is the snapshot, so no second read is needed.
 */
export function pageSnapshotFromResult(result: ToolResult, ref: string): PageSnapshot {
  const text = resultText(result);
  const raw = rawResultOf(result);
  const url = raw && typeof raw.url === 'string' ? raw.url : '';
  return { url, text, ref };
}

/** The first text a tool result carries, or '' when it carries none. */
export function resultText(result: ToolResult): string {
  const first = result.content.find((item) => item.type === 'text');
  return first && first.type === 'text' ? first.text : '';
}

/**
 * Read the page again, on the tab given: the fresh read verification — and
 * reconciliation — runs against. The read is a plain handler call, not a
 * step, so it needs no P4 approval (the snapshot tool is an idempotent
 * read) and no param preparation beyond the tab to read and the widest
 * snapshot the schema allows. When no snapshot tool or no host is
 * available, or the read itself fails, it throws, so the caller fails the
 * step as `verify-failed` — or leaves the outcome unknown — instead of
 * passing it unread: a tool result alone is never evidence of success.
 * `context` names the read in the failure (`after <tool>`, `to reconcile
 * the step`), so the evidence says which read failed.
 */
export async function readFreshSnapshot(
  tools: ReadonlyMap<string, ToolDefinition>,
  host: ToolHost | undefined,
  tabId: number | undefined,
  context: string,
): Promise<PageSnapshot> {
  const snapshotDef = tools.get('browser_snapshot');
  if (!snapshotDef) {
    throw new Error(`snapshot unavailable ${context}: no browser_snapshot tool available to read the page`);
  }
  if (!host) {
    throw new Error(`snapshot unavailable ${context}: no tool host available to read the page`);
  }
  const params: Record<string, unknown> = {};
  if (tabId !== undefined && 'tabId' in snapshotDef.inputSchema.shape) params.tabId = tabId;
  // Read the whole tree the schema allows: the 8000-char default truncates
  // long accessibility trees, so content below the cut would falsely fail.
  if ('maxChars' in snapshotDef.inputSchema.shape) params.maxChars = 50000;
  let snapshotResult: ToolResult;
  try {
    snapshotResult = await snapshotDef.handler(host, params);
  } catch (error) {
    throw new Error(
      `snapshot unavailable ${context}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (snapshotResult.isError) {
    throw new Error(`snapshot unavailable ${context}: ${resultText(snapshotResult)}`);
  }
  return pageSnapshotFromResult(snapshotResult, `browser_snapshot${tabId !== undefined ? ` tab ${tabId}` : ''}`);
}

/**
 * The page snapshot to verify a step against. A `browser_snapshot` step
 * already read the page, so its own result is the snapshot. Any other step
 * is followed by a fresh `browser_snapshot` read on the tab it acted on.
 * When no snapshot tool or no host is available, or the read itself fails,
 * it throws, so the caller fails the step as `verify-failed` instead of
 * passing it unread: the step's own result is never a substitute snapshot.
 */
export async function readSnapshotAfterStep(
  step: TaskStep,
  result: ToolResult,
  tools: ReadonlyMap<string, ToolDefinition>,
  host: ToolHost | undefined,
  tabId: number | undefined,
): Promise<PageSnapshot> {
  if (step.tool === 'browser_snapshot') return pageSnapshotFromResult(result, 'browser_snapshot result');
  return readFreshSnapshot(tools, host, tabId, `after ${step.tool}`);
}
