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
  return { messages, issues: aggregateIssues(issues) };
}
