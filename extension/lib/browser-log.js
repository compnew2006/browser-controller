/**
 * What the page logged, read through the debugger: the page's own console calls
 * and uncaught exceptions (Runtime). Runtime replays what it collected for the current
 * document when enabled, so a read attaches on demand instead of listening all the time.
 * Pure: `send` / `subscribe` come from lib/cdp-session.js.
 */

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

/** The message of an uncaught exception. Where it happened is `source`, kept apart so a line shows it once. */
function exceptionText(details = {}) {
  const ex = details.exception;
  const what = ex?.description ?? (ex && 'value' in ex ? String(ex.value) : '');
  return what ? `${details.text || 'Uncaught'} ${what}` : (details.text || 'Uncaught');
}

const capText = (text) => (text.length > MAX_ENTRY_CHARS ? `${text.slice(0, MAX_ENTRY_CHARS)}…[truncated]` : text);

// Where a call or exception came from: `url:line` of the first frame with a URL, and up to MAX_STACK_FRAMES frames.
const MAX_STACK_FRAMES = 10;
const frameText = (f = {}) => `at ${f.functionName || '<anonymous>'} (${f.url || '<anonymous>'}:${(f.lineNumber ?? 0) + 1}:${(f.columnNumber ?? 0) + 1})`;
const framesOf = (frames) => frames.slice(0, MAX_STACK_FRAMES).map(frameText);
function sourceOf(frames) {
  const top = frames.find((f) => f.url);
  return top ? `${top.url}:${(top.lineNumber ?? 0) + 1}` : undefined;
}

/**
 * Enable Runtime, gather the replayed console calls and uncaught exceptions of
 * the current document, switch it off again. `levels` (a Set) filters before
 * the latest `max` entries are formatted; `clear` discards what Chrome kept.
 */
export async function collectPageConsole(send, subscribe, { clear = false, levels = null, max = 200, settleMs = 100 } = {}) {
  const raw = [];
  const unsubscribe = subscribe((method, params) => {
    if (method === 'Runtime.consoleAPICalled' && !SKIPPED_TYPES.has(params?.type)) {
      const frames = params.stackTrace?.callFrames || [];
      raw.push({ level: CONSOLE_LEVELS[params.type] || 'log', args: params.args, timestamp: params.timestamp, source: sourceOf(frames), stack: framesOf(frames) });
    } else if (method === 'Runtime.exceptionThrown' && params?.exceptionDetails) {
      const d = params.exceptionDetails;
      const frames = d.stackTrace?.callFrames || [];
      const source = d.url ? `${d.url}:${(d.lineNumber ?? 0) + 1}` : sourceOf(frames);
      raw.push({ level: 'error', text: exceptionText(d), timestamp: params.timestamp, source, stack: framesOf(frames) });
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
      messages.push({
        level: m.level,
        text: capText(text),
        ...(typeof m.timestamp === 'number' ? { timestamp: Math.round(m.timestamp) } : {}),
        ...(m.source ? { source: m.source } : {}),
        ...(m.level === 'error' && m.stack.length ? { stack: m.stack } : {}),
      });
    }
    if (clear) await send('Runtime.discardConsoleEntries').catch(() => {});
  } finally {
    unsubscribe();
    await send('Runtime.disable').catch(() => {});
  }
  return messages;
}
