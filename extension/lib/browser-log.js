/**
 * What a page logged, read through the debugger: the page's own console calls
 * and uncaught exceptions (Runtime), and what Chrome itself reports outside
 * the console API: Log-domain entries (failed resource loads, deprecations,
 * interventions, violations, security) and DevTools Issues (Audits: CORS, CSP,
 * mixed content, cookies, forms…). Each domain replays what it collected for
 * the current document when enabled, so a read attaches on demand instead of
 * listening all the time. Pure: `send` / `subscribe` come from lib/cdp-session.js.
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

// The page's own console: Runtime replays the current document's console API
// calls and uncaught exceptions (with stacks) when enabled, so nothing has to
// wrap the page's console. A wrapper made every site's console.error show up
// as an error of the extension (its frame was the top of the stack).
const CONSOLE_LEVELS = { warning: 'warn', assert: 'error', error: 'error', info: 'info', debug: 'debug' };
const SKIPPED_TYPES = new Set(['endGroup', 'clear', 'profile', 'profileEnd']);
const MAX_ENTRY_CHARS = 2000;
const STRINGIFY = `function (...values) {
  return values.map((v) => {
    let s;
    try { s = JSON.stringify(v); } catch { s = undefined; }
    if (s === undefined) s = String(v);
    return s.length > ${MAX_ENTRY_CHARS} ? s.slice(0, ${MAX_ENTRY_CHARS}) : s;
  });
}`;

/** RemoteObject → text, without asking the page. */
function argText(arg = {}) {
  if ('value' in arg) return typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value);
  if (arg.unserializableValue) return arg.unserializableValue;
  if (arg.type === 'undefined') return 'undefined';
  return arg.description ?? arg.type ?? '';
}

/** Plain objects and arrays read best as JSON; errors, nodes, maps… by their description. */
const wantsJson = (arg) => arg.objectId && arg.type === 'object' && (!arg.subtype || arg.subtype === 'array');

async function consoleText(send, args = []) {
  const texts = args.map(argText);
  const objects = args.map((arg, i) => [arg, i]).filter(([arg]) => wantsJson(arg));
  if (objects.length) {
    try {
      const { result } = await send('Runtime.callFunctionOn', {
        objectId: objects[0][0].objectId,
        functionDeclaration: STRINGIFY,
        arguments: objects.map(([arg]) => ({ objectId: arg.objectId })),
        returnByValue: true,
        silent: true,
      });
      (result?.value || []).forEach((text, k) => { texts[objects[k][1]] = text; });
    } catch { /* keep the descriptions */ }
  }
  return texts.join(' ');
}

function exceptionText(details = {}) {
  const ex = details.exception;
  const what = ex?.description ?? (ex && 'value' in ex ? String(ex.value) : '');
  const where = details.url ? ` (${details.url}:${(details.lineNumber ?? 0) + 1})` : '';
  if (!what) return `${details.text || 'Uncaught'}${where}`;
  return `${details.text || 'Uncaught'} ${what}${what.includes('\n    at ') ? '' : where}`;
}

const capText = (text) => (text.length > MAX_ENTRY_CHARS ? `${text.slice(0, MAX_ENTRY_CHARS)}…[truncated]` : text);

/**
 * Enable Runtime, gather the replayed console calls and uncaught exceptions of
 * the current document, switch it off again. `levels` (a Set) filters before
 * the latest `max` entries are formatted; `clear` discards what Chrome kept.
 */
export async function collectPageConsole(send, subscribe, { clear = false, levels = null, max = 200, settleMs = 100 } = {}) {
  const raw = [];
  const unsubscribe = subscribe((method, params) => {
    if (method === 'Runtime.consoleAPICalled' && !SKIPPED_TYPES.has(params?.type)) {
      raw.push({ level: CONSOLE_LEVELS[params.type] || 'log', args: params.args, timestamp: params.timestamp });
    } else if (method === 'Runtime.exceptionThrown' && params?.exceptionDetails) {
      raw.push({ level: 'error', text: exceptionText(params.exceptionDetails), timestamp: params.timestamp });
    }
  });
  const messages = [];
  try {
    await send('Runtime.disable').catch(() => {}); // Runtime only replays when it is switched on
    await send('Runtime.enable');
    if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));
    const picked = (levels ? raw.filter((m) => levels.has(m.level)) : raw).slice(-max);
    for (const m of picked) {
      const text = m.text ?? await consoleText(send, m.args);
      if (!text) continue;
      messages.push({ level: m.level, text: capText(text), ...(typeof m.timestamp === 'number' ? { timestamp: Math.round(m.timestamp) } : {}) });
    }
    if (clear) await send('Runtime.discardConsoleEntries').catch(() => {});
  } finally {
    unsubscribe();
    await send('Runtime.disable').catch(() => {});
  }
  return messages;
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
