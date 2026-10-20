/**
 * REPL-style evaluate over CDP (Runtime.evaluate replMode), like Claude in
 * Chrome's javascript tool: top-level `await`, statement lists whose LAST
 * expression is the result, `let`/`const` redeclaration across calls — no
 * function wrapper needed. Runs through the debugger, so page CSP does not
 * block it. Non-JSON values (DOM nodes, cycles, functions) come back as
 * readable descriptions instead of `{}`.
 */
import { MAX_RESULT_CHARS } from './state.js';

export const DEFAULT_EVAL_TIMEOUT_MS = 30_000;
export const MAX_EVAL_TIMEOUT_MS = 120_000;

/** Page-side serializer, run with `this` = the evaluated value. */
function serializeThis() {
  const describe = (n) => {
    if (!(n instanceof Node)) return String(n);
    if (n.nodeType !== 1) return `#${n.nodeName.toLowerCase()}`;
    let s = n.tagName.toLowerCase();
    if (n.id) s += `#${n.id}`;
    if (typeof n.className === 'string' && n.className.trim()) s += `.${n.className.trim().split(/\s+/).slice(0, 3).join('.')}`;
    const text = (n.innerText || n.value || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    return text ? `<${s}> "${text}"` : `<${s}>`;
  };
  const seen = new WeakSet();
  const out = JSON.stringify(this, (_k, v) => {
    if (typeof v === 'bigint') return `${v}n`;
    if (typeof v === 'function') return `[Function ${v.name || 'anonymous'}]`;
    if (typeof v === 'symbol') return v.toString();
    if (v === undefined) return null;
    if (typeof Node !== 'undefined' && v instanceof Node) return describe(v);
    if (v instanceof Map) return Object.fromEntries(v);
    if (v instanceof Set) return [...v];
    if (v instanceof Error) return `${v.name}: ${v.message}`;
    if (typeof NodeList !== 'undefined' && (v instanceof NodeList || v instanceof HTMLCollection)) return [...v];
    if (v && typeof v === 'object') {
      if (seen.has(v)) return '[Circular]';
      seen.add(v);
    }
    return v;
  });
  return out === undefined ? null : out;
}

function capped(value) {
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  if (raw && raw.length > MAX_RESULT_CHARS) {
    return { success: true, result: raw.slice(0, MAX_RESULT_CHARS), truncated: true, fullLength: raw.length };
  }
  return { success: true, result: value };
}

export async function cdpEvaluate(send, expression, { timeoutMs = DEFAULT_EVAL_TIMEOUT_MS, signal } = {}) {
  const budget = Math.min(Math.max(1000, timeoutMs), MAX_EVAL_TIMEOUT_MS);
  const group = `bc-eval-${Date.now()}`;
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), budget);
  });
  const aborted = signal
    ? new Promise((resolve) => {
        if (signal.aborted) resolve({ aborted: true });
        else signal.addEventListener('abort', () => resolve({ aborted: true }), { once: true });
      })
    : null;
  const timedOut = { success: false, error: `TIMEOUT: evaluate did not finish within ${budget}ms (pass a larger timeout, max ${MAX_EVAL_TIMEOUT_MS})` };
  const failed = (d) => {
    const msg = d.exception?.description || d.exception?.value || d.text || 'evaluate threw';
    return { success: false, error: String(msg).slice(0, 2000) };
  };
  // Every CDP call that can wait on the page is raced against the budget and the abort.
  const guarded = (p) => Promise.race([p, timeout, ...(aborted ? [aborted] : [])]);
  try {
    const run = send('Runtime.evaluate', {
      expression,
      replMode: true,
      awaitPromise: true,
      returnByValue: false,
      userGesture: true,
      objectGroup: group,
      timeout: budget, // bounds synchronous execution; the race below bounds awaits
    });
    const r = await guarded(run);
    if (r.aborted) return { success: false, error: 'aborted' };
    if (r.timedOut) {
      // Leave the page alone — the pending promise just resolves into nothing.
      return timedOut;
    }
    if (r.exceptionDetails) return failed(r.exceptionDetails);
    let ro = r.result || {};
    if (ro.subtype === 'promise' && ro.objectId) {
      // In replMode awaitPromise does not wait for a plain promise-valued expression
      // (the result stayed the promise, which serialized as {}): wait for it explicitly.
      const settled = await guarded(send('Runtime.awaitPromise', { promiseObjectId: ro.objectId, returnByValue: false }));
      if (settled.aborted) return { success: false, error: 'aborted' };
      if (settled.timedOut) return timedOut;
      if (settled.exceptionDetails) return failed(settled.exceptionDetails);
      ro = settled.result || {};
    }
    if (ro.type === 'undefined') return { success: true, result: null, type: 'undefined' };
    if (ro.unserializableValue !== undefined) return { success: true, result: ro.unserializableValue };
    if ('value' in ro && ro.objectId === undefined) return capped(ro.value);
    if (ro.subtype === 'node' || !ro.objectId) return capped(ro.description ?? null);
    const ser = await send('Runtime.callFunctionOn', {
      objectId: ro.objectId,
      functionDeclaration: serializeThis.toString(),
      returnByValue: true,
    });
    const json = ser?.result?.value;
    if (typeof json !== 'string') return capped(ro.description ?? null);
    if (json.length > MAX_RESULT_CHARS) return capped(json);
    try {
      return { success: true, result: JSON.parse(json) };
    } catch {
      return capped(json);
    }
  } finally {
    clearTimeout(timer);
    send('Runtime.releaseObjectGroup', { objectGroup: group }).catch(() => {});
  }
}
