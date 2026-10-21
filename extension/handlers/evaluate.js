/**
 * browser_evaluate (contract 3.0): one expression, or statements that `return` a value, run in
 * the tab and answered with that value. Over CDP (lib/cdp-evaluate.js: page CSP does not apply).
 * Only a debugger that cannot attach falls back to chrome.scripting in the page's main world
 * (evalStep below), reported as `via: scripting`. Both share one budget.
 */
import { resolveTab, assertResponsive } from '../lib/page-exec.js';
import { MAX_RESULT_CHARS } from '../lib/state.js';
import { withCdp, settleWithin, TIMED_OUT } from '../lib/cdp-session.js';
import { cdpEvaluateSource, cdpFailure, BROWSER_EVALUATE_DEFAULT_MS, BROWSER_EVALUATE_MAX_MS } from '../lib/cdp-evaluate.js';

/** browser_evaluate: the longest value shown as text. */
const EVAL_TEXT_MAX_CHARS = 20_000;

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** The `text` of an evaluate reply: the value as compact JSON, strings unquoted; cut at EVAL_TEXT_MAX_CHARS. */
function evaluateReply(res, via) {
  const value = res.result;
  const full = res.type === 'undefined' ? 'undefined'
    : typeof value === 'string' ? value
      : JSON.stringify(value) ?? 'undefined';
  const total = typeof res.fullLength === 'number' ? res.fullLength : full.length;
  const lines = via === 'scripting' ? ['via: scripting'] : [];
  lines.push(full.slice(0, EVAL_TEXT_MAX_CHARS));
  if (total > EVAL_TEXT_MAX_CHARS) lines.push(`… truncated (${total - EVAL_TEXT_MAX_CHARS} more chars)`);
  if (res.statements) lines.push('note: statements give a value only through `return` (e.g. `const x = 2; return x * 21`)');
  return { success: true, text: lines.join('\n'), result: value, via, ...(res.truncated ? { truncated: true } : {}) };
}

/**
 * browser_evaluate (contract 3.0): the source is one expression, or statements that
 * `return` a value. Over CDP (page CSP does not apply). Only a debugger that cannot attach
 * falls back to chrome.scripting in the page's main world (CSP-bound), reported as
 * `via: scripting`. Both share one budget: TIMEOUT when it runs out.
 */
export async function handleEvaluate(params, _sessionId, _agentName, signal) {
  const { tabId, expression, timeout } = params;
  const budget = Math.min(Math.max(1000, timeout ?? BROWSER_EVALUATE_DEFAULT_MS), BROWSER_EVALUATE_MAX_MS);
  await resolveTab(tabId);
  const tab = await chrome.tabs.get(tabId);
  if (/^(chrome|chrome-extension|devtools|edge|about):/i.test(tab.url || '')) {
    throw new Error(`INVALID_ARGUMENT: Cannot evaluate on protected page (${tab.url}).`);
  }
  await assertResponsive(tabId);
  let attached = false;
  try {
    const res = await withCdp(tabId, async (send) => {
      attached = true;
      return cdpEvaluateSource(send, expression, { timeoutMs: budget, signal, tabId });
    });
    if (res.success === false) return res;
    // The script opened a dialog and waits for it: the reply names the dialog (no value yet).
    if (res.paused) return { success: true, text: res.text, result: null, via: 'cdp', dialog: res.dialog };
    return evaluateReply(res, 'cdp');
  } catch (err) {
    // Attached and still failing: the debugger broke mid-call, which is a coded failure, not a raw error.
    if (attached) return { success: false, error: cdpFailure(err) };
  }
  return evaluateByScripting(tabId, expression, budget);
}

/** How long giving up on a scripting run may wait for the page to take the drop. */
const DROP_MS = 500;
/** Scripting runs started by this worker: each gets its own token. */
let scriptRuns = 0;

/**
 * The page side of the chrome.scripting fallback, run in the page's main world (serialized
 * into the page: it uses nothing from this module). Every run has its own token. `start`
 * parks the run (its slot is null until it settles), the run stores its value under the
 * token, and `take` reads and removes only that token's value. `drop` forgets a run that
 * gave up, so the value it settles later is discarded. The page global goes once no run is left.
 */
function evalStep(op, token, code) {
  const forget = () => {
    const runs = window.__bcEvalRuns;
    if (!runs) return;
    delete runs[token];
    if (Object.keys(runs).length === 0) delete window.__bcEvalRuns;
  };
  if (op === 'take') {
    const runs = window.__bcEvalRuns;
    const out = runs ? runs[token] : null;
    if (!out) return null; // still running, or not this run's
    forget();
    return out;
  }
  if (op === 'drop') {
    forget();
    return null;
  }
  const runs = window.__bcEvalRuns || (window.__bcEvalRuns = Object.create(null));
  runs[token] = null;
  (async () => {
    let out;
    try {
      // One expression when the source parses as one, else a function body. Indirect eval: the
      // source sees the page's globals, not this function's variables. An async function's return
      // does not cross the world boundary (crbug 1304272), so the value is parked, not returned.
      const expr = String(code).trim().replace(/;+\s*$/, '');
      let pending;
      let statements = false;
      try { pending = (0, eval)(`(async () => (\n${expr}\n))()`); } catch { statements = true; pending = (0, eval)(`(async () => {\n${code}\n})()`); }
      const value = await pending;
      out = { ok: true, json: JSON.stringify(value), ...(statements && value === undefined ? { statements } : {}) };
    } catch (err) {
      out = { ok: false, error: String(err && err.message || err).slice(0, 2000) };
    }
    // A run that was dropped has no slot any more: its late value is discarded here.
    if (token in runs) runs[token] = out;
  })();
  return true;
}

/**
 * The chrome.scripting path (the debugger cannot attach). The page runs the source through
 * evalStep; a SYNC poll reads the value back. Every executeScript is raced against the budget.
 */
async function evaluateByScripting(tabId, expression, budget) {
  const deadline = Date.now() + budget;
  const left = () => Math.max(1, deadline - Date.now());
  const timedOut = {
    success: false,
    via: 'scripting',
    error: `TIMEOUT: evaluate did not finish within ${budget}ms. The page may still be running it; the call returned so the tab is free.`,
  };
  // Every page call runs evalStep under this call's token, so a value is read only by the call that started it.
  const token = `${Date.now().toString(36)}-${(scriptRuns += 1).toString(36)}`;
  const onPage = (args) => chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: evalStep, args });
  // Gives up on the run: a value it settles later is discarded on the page. Bounded, since a busy page may not answer.
  const giveUp = async () => {
    await settleWithin(onPage(['drop', token]), DROP_MS).catch(() => {});
    return timedOut;
  };
  // executeScript waits for the page's main thread. A busy page never answers, so every
  // call is raced against the budget: a frozen page returns TIMEOUT instead of holding the tab.
  const kicked = await settleWithin(onPage(['start', token, expression]), left());
  if (kicked === TIMED_OUT) return giveUp();

  let out = null;
  while (Date.now() < deadline) {
    const read = await settleWithin(onPage(['take', token]), left());
    if (read === TIMED_OUT) return giveUp();
    out = read?.[0]?.result ?? null;
    if (out) break;
    await pause(40);
  }
  if (!out) return giveUp();
  if (out.ok === false) return { success: false, via: 'scripting', error: `SCRIPT_ERROR: ${out.error}` };
  // Oversized values are cut before parsing: the page-side stringify has no bound.
  if (typeof out.json === 'string' && out.json.length > MAX_RESULT_CHARS) {
    return evaluateReply({ result: out.json.slice(0, MAX_RESULT_CHARS), truncated: true, fullLength: out.json.length }, 'scripting');
  }
  let value;
  try {
    value = out.json === undefined ? undefined : JSON.parse(out.json);
  } catch {
    value = out.json;
  }
  return evaluateReply({ result: value, type: out.json === undefined ? 'undefined' : undefined, statements: out.statements === true }, 'scripting');
}
