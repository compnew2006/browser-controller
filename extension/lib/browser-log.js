/**
 * What Chrome itself reports about a page, outside the page's console API:
 * Log-domain entries (failed resource loads, deprecations, interventions,
 * violations, security) and DevTools Issues (Audits: CORS, CSP, mixed content,
 * cookies, forms…). Both domains replay what they collected for the current
 * document when enabled, so a read attaches on demand instead of listening all
 * the time. Pure: `send` / `subscribe` come from lib/cdp-session.js.
 */

const LEVELS = { warning: 'warn', verbose: 'debug' };

/** A Log.LogEntry in the shape browser_console uses for page messages. */
export function logEntryView(entry = {}) {
  const view = { level: LEVELS[entry.level] || entry.level || 'info', source: entry.source || 'other', text: String(entry.text || '') };
  if (entry.url) view.url = entry.url;
  if (typeof entry.timestamp === 'number') view.timestamp = Math.round(entry.timestamp);
  return view;
}

// Where each issue type names its specific problem and the URL it concerns.
const KIND_FIELDS = ['errorType', 'type', 'violationType', 'contentSecurityPolicyViolationType', 'violatedDirective', 'resolutionStatus', 'reason', 'blockedReason'];
const URL_FIELDS = ['url', 'blockedURL', 'insecureURL', 'cookieUrl', 'sourceURL'];

/** { code, type?, url? } for an Audits.InspectorIssue. */
export function summarizeIssue(issue = {}) {
  const details = Object.values(issue.details || {}).find((d) => d && typeof d === 'object') || {};
  const kind = KIND_FIELDS.map((f) => details[f]).find((v) => typeof v === 'string' && v)
    || details.corsErrorStatus?.corsError
    || details.cookieWarningReasons?.[0]
    || details.cookieExclusionReasons?.[0]
    || '';
  const url = URL_FIELDS.map((f) => details[f]).find((v) => typeof v === 'string' && v)
    || details.sourceCodeLocation?.url
    || details.request?.url
    || '';
  return { code: issue.code || 'Issue', ...(kind ? { type: kind } : {}), ...(url ? { url } : {}) };
}

/** One row per code+type with a count, as the DevTools Issues panel groups them. */
export function aggregateIssues(issues) {
  const byKey = new Map();
  for (const issue of issues) {
    const summary = summarizeIssue(issue);
    const key = `${summary.code}|${summary.type || ''}`;
    const seen = byKey.get(key);
    if (seen) seen.count++;
    else byKey.set(key, { ...summary, count: 1 });
  }
  return [...byKey.values()];
}

/**
 * Most Issue rows one read returns. Audits is enabled on this tab's own session,
 * so the issues come from this tab; the noise is volume (many kinds on a busy
 * page), so rows are sorted by count and the rest is summarised in one row.
 */
export const MAX_ISSUE_ROWS = 25;

/**
 * Enable Log + Audits, gather the replayed entries, switch both off again.
 * `clear` empties Chrome's log afterwards (Issues have no clear).
 */
export async function collectBrowserLog(send, subscribe, { clear = false, settleMs = 100 } = {}) {
  const messages = [];
  const issues = [];
  const unsubscribe = subscribe((method, params) => {
    if (method === 'Log.entryAdded' && params?.entry) messages.push(logEntryView(params.entry));
    else if (method === 'Audits.issueAdded' && params?.issue) issues.push(params.issue);
  });
  try {
    await send('Log.enable');
    await send('Audits.enable').catch(() => {}); // not every target exposes Audits
    if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));
    if (clear) await send('Log.clear').catch(() => {});
  } finally {
    unsubscribe();
    await send('Log.disable').catch(() => {});
    await send('Audits.disable').catch(() => {});
  }
  return { messages, issues: capIssueRows(aggregateIssues(issues)) };
}

/** Most frequent rows first, at most MAX_ISSUE_ROWS, then one row counting what was left out. */
export function capIssueRows(rows) {
  const sorted = [...rows].sort((a, b) => b.count - a.count);
  if (sorted.length <= MAX_ISSUE_ROWS) return sorted;
  const omitted = sorted.length - MAX_ISSUE_ROWS;
  return [...sorted.slice(0, MAX_ISSUE_ROWS), { code: 'Truncated', type: `${omitted} more issue kinds not listed (row cap ${MAX_ISSUE_ROWS})` }];
}
