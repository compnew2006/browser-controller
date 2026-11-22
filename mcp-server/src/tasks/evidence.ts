/**
 * The evidence report builder (specs/011-professional-browsing-layer, Design §4).
 *
 * `buildEvidenceReport` turns a finished — or failed, or paused — task into
 * a report with the five fixed sections: ما تم فحصه، القيم التي وُجدت،
 * المصادر، ما بقي غير مؤكد، ما لم يُتحقق منه. It emits compact text plus
 * the same content as structured JSON, and it is pure: it only reads the
 * `Task` object, performs no I/O and calls no tools, so it cannot change
 * anything — the read-only default holds by construction.
 *
 * What the builder reads, and what it does not invent:
 * - `Task` (Task 1) carries `evidence: string[]`, not a structured
 *   `EvidenceEntry` type — the plan's §1 sketch names one, but `types.ts`
 *   defines the field as a list of strings, and the runner writes one
 *   line per step (`step N (tool): <status> — <detail>`). The builder
 *   therefore takes its facts from the steps' own results and details;
 *   the evidence strings are only mined for source URLs the step details
 *   do not already name.
 * - Values are copied VERBATIM from an `ok` step's result detail — never
 *   paraphrased, never rounded, never completed. A detail written by the
 *   verifier carries the page text it actually saw as
 *   `observed="..."`; that excerpt is the value (it is where the numbers,
 *   dates and codes live). A detail with no `observed="..."` is carried
 *   whole, verbatim, as the value. Nothing is inferred from a value: a
 *   step whose detail says nothing found contributes no value.
 * - No conclusions without a source: only steps with `result.status ===
 *   'ok'` contribute values or sources. Everything else lands in the
 *   unresolved sections, never in the found values.
 *
 * Unconfirmed vs not verified — the split the report uses:
 * - ما بقي غير مؤكد (unconfirmed): the outcome is unknown. A step that
 *   never ran (no result), a step whose tool failed (`failed` — the page
 *   was never read, so what happened is unknown), and a task paused
 *   mid-way (`paused-question` / `paused-login` — the remaining work is
 *   still open).
 * - ما لم يُتحقق منه (not verified): verification did not pass. A step
 *   whose verification failed (`verify-failed`), and a step that never ran
 *   (verification never had a page to check). A `failed` step is NOT
 *   listed here: its tool errored before any verification could run, so
 *   the primary fact about it is the unknown outcome, recorded under
 *   unconfirmed — listing it under both would double-count one failure
 *   as two. An unrun step genuinely is both, so it appears in both.
 */
import type { Task, TaskState, VerifyRule } from './types.js';

/** One step as the report checked it: its tool, its verify rules, its outcome. */
export interface CheckedStep {
  /** 1-based step number, matching the runner's evidence lines. */
  step: number;
  tool: string;
  verify: string[];
  status: 'ok' | 'failed' | 'verify-failed' | 'not-run';
  /** The step result's detail, verbatim, when the step ran. */
  detail?: string;
}

/** One value found, copied verbatim from an `ok` step's result detail. */
export interface FoundValue {
  step: number;
  tool: string;
  value: string;
  /** The URL the value was verified at, when the detail names one. */
  source?: string;
}

/** One unresolved item: a step, or the task itself, that is not settled. */
export interface UnresolvedItem {
  /** 1-based step number; absent when the item is about the task, not a step. */
  step?: number;
  tool?: string;
  reason: string;
}

/** The structured evidence report: the same five sections as the text. */
export interface EvidenceReport {
  taskId: string;
  goal: string;
  state: TaskState;
  checked: CheckedStep[];
  values: FoundValue[];
  sources: string[];
  unconfirmed: UnresolvedItem[];
  notVerified: UnresolvedItem[];
}

/** The URL a verifier detail names (`verified … at <url>; …` or `url=<url>; …`). */
const URL_PATTERN = /https?:\/\/[^\s;"']+/gu;

/**
 * The page text a verifier detail quotes: `observed="..."`. Greedy, so
 * quotes inside the observed page text (accessibility-tree lines quote
 * element names, e.g. `heading "Welcome"`) do not cut the value short;
 * the optional trailing ` (...)` is the runner's param-normalisation
 * notes, which follow the quoted excerpt and are not part of the value.
 * When the detail matches neither shape, there is no excerpt to take and
 * the caller falls back to the whole detail.
 */
const OBSERVED_PATTERN = /observed="([\s\S]*)"(?: \([^)]*\))?$/u;

/** A verify rule in one line, e.g. `url-contains "example.com"`, `element-count button = 2`. */
function describeRule(rule: VerifyRule): string {
  switch (rule.kind) {
    case 'url-contains':
    case 'text-present':
    case 'no-error-text':
      return `${rule.kind} "${rule.value}"`;
    case 'element-count':
      return `element-count ${rule.selector} = ${rule.count}`;
  }
}

/** The distinct URLs in a text, in order of first appearance. */
function extractUrls(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = match[0].replace(/;+$/u, '');
    if (!found.includes(url)) found.push(url);
  }
  return found;
}

/** The observed page text a detail quotes, or the whole detail verbatim when it quotes none. */
function valueOfDetail(detail: string): string {
  return OBSERVED_PATTERN.exec(detail)?.[1] ?? detail;
}

function checkedStep(step: Task['steps'][number], index: number): CheckedStep {
  const checked: CheckedStep = {
    step: index + 1,
    tool: step.tool,
    verify: step.verify.map(describeRule),
    status: step.result?.status ?? 'not-run',
  };
  if (step.result?.detail !== undefined) checked.detail = step.result.detail;
  return checked;
}

function statusLine(status: CheckedStep['status']): string {
  switch (status) {
    case 'ok':
      return 'تم التحقق';
    case 'failed':
      return 'فشل التنفيذ';
    case 'verify-failed':
      return 'فشل التحقق';
    case 'not-run':
      return 'لم تُنفذ';
  }
}

function unresolvedLine(item: UnresolvedItem): string {
  const where = item.step !== undefined ? `الخطوة ${item.step}${item.tool ? ` (${item.tool})` : ''}: ` : '';
  return `- ${where}${item.reason}`;
}

/**
 * Build the evidence report for a task: compact Arabic text plus the same
 * five sections as structured JSON. Values come only from steps that
 * verified (`ok`), copied verbatim; a step that never ran, failed, or
 * failed verification lands in the unresolved sections instead.
 */
export function buildEvidenceReport(task: Task): { text: string; json: EvidenceReport } {
  const checked = task.steps.map((step, index) => checkedStep(step, index));

  const values: FoundValue[] = [];
  for (const entry of checked) {
    if (entry.status !== 'ok' || entry.detail === undefined) continue;
    const found: FoundValue = { step: entry.step, tool: entry.tool, value: valueOfDetail(entry.detail) };
    const source = extractUrls(entry.detail)[0];
    if (source !== undefined) found.source = source;
    values.push(found);
  }

  const sources: string[] = [];
  for (const entry of checked) {
    if (entry.detail === undefined) continue;
    for (const url of extractUrls(entry.detail)) {
      if (!sources.includes(url)) sources.push(url);
    }
  }
  for (const line of task.evidence) {
    for (const url of extractUrls(line)) {
      if (!sources.includes(url)) sources.push(url);
    }
  }

  const unconfirmed: UnresolvedItem[] = [];
  const notVerified: UnresolvedItem[] = [];
  for (const entry of checked) {
    if (entry.status === 'not-run') {
      unconfirmed.push({ step: entry.step, tool: entry.tool, reason: 'لم تُنفذ بعد — نتيجتها غير معروفة' });
      notVerified.push({ step: entry.step, tool: entry.tool, reason: 'لم تُنفذ بعد — لم يُتحقق منها' });
    } else if (entry.status === 'failed') {
      unconfirmed.push({
        step: entry.step,
        tool: entry.tool,
        reason: `فشل التنفيذ — نتيجتها غير معروفة${entry.detail ? `: ${entry.detail}` : ''}`,
      });
    } else if (entry.status === 'verify-failed') {
      notVerified.push({
        step: entry.step,
        tool: entry.tool,
        reason: `فشل التحقق${entry.detail ? `: ${entry.detail}` : ''}`,
      });
    }
  }
  if (task.state === 'paused-question' || task.state === 'paused-login') {
    const firstOpen = checked.find((entry) => entry.status !== 'ok');
    unconfirmed.push({
      reason:
        task.state === 'paused-login'
          ? `المهمة متوقفة بانتظار إكمال الدخول${firstOpen ? ` عند الخطوة ${firstOpen.step}` : ''} — ما بعدها غير مؤكد`
          : `المهمة متوقفة بانتظار إجابة المستخدم${firstOpen ? ` عند الخطوة ${firstOpen.step}` : ''} — ما بعدها غير مؤكد`,
    });
  }

  const json: EvidenceReport = {
    taskId: task.id,
    goal: task.goal,
    state: task.state,
    checked,
    values,
    sources,
    unconfirmed,
    notVerified,
  };

  const lines: string[] = [
    `تقرير الأدلة — المهمة ${task.id}`,
    `الهدف: ${task.goal}`,
    `الحالة: ${task.state}`,
    '',
    '## ما تم فحصه',
    ...(checked.length > 0
      ? checked.map(
          (entry) =>
            `- الخطوة ${entry.step} (${entry.tool}): ${statusLine(entry.status)}` +
            (entry.verify.length > 0 ? ` — التحقق: ${entry.verify.join('، ')}` : ''),
        )
      : ['لا توجد خطوات.']),
    '',
    '## القيم التي وُجدت',
    ...(values.length > 0
      ? values.map((found) => `- الخطوة ${found.step} (${found.tool}): ${found.value}`)
      : ['لا توجد قيم مؤكدة.']),
    '',
    '## المصادر',
    ...(sources.length > 0 ? sources.map((url) => `- ${url}`) : ['لا توجد مصادر.']),
    '',
    '## ما بقي غير مؤكد',
    ...(unconfirmed.length > 0 ? unconfirmed.map(unresolvedLine) : ['لا شيء بقي غير مؤكد.']),
    '',
    '## ما لم يُتحقق منه',
    ...(notVerified.length > 0 ? notVerified.map(unresolvedLine) : ['لا توجد خطوات لم يُتحقق منها.']),
  ];

  return { text: lines.join('\n'), json };
}
