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
 * `element-count` counts snapshot lines mentioning the selector: the
 * snapshot is an accessibility tree (one element per line), not a DOM, so
 * there is no CSS query to run against it. The match is case-insensitive,
 * matching how the tree spells roles and labels.
 */
import { rawResultOf } from '../tools/types.js';
import type { ToolResult } from '../tools/types.js';
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
      const needle = rule.selector.toLowerCase();
      const found = snapshot.text.split('\n').filter((line) => line.toLowerCase().includes(needle)).length;
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
 * Used when the step itself read the page (`browser_snapshot`) or when no
 * snapshot tool is available to read it again.
 */
export function pageSnapshotFromResult(result: ToolResult, ref: string): PageSnapshot {
  const first = result.content.find((item) => item.type === 'text');
  const text = first && first.type === 'text' ? first.text : '';
  const raw = rawResultOf(result);
  const url = raw && typeof raw.url === 'string' ? raw.url : '';
  return { url, text, ref };
}
