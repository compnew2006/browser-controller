import type { ToolHost } from './types.js';

/**
 * A short fingerprint of the page's visible text: its length and a hash of it.
 *
 * Two reads with the same fingerprint are the same rendered text, so a change
 * of the fingerprint is a change of the page. The fingerprint is small, so it
 * can be compared across round trips without carrying the page's text around.
 */
const FINGERPRINT_PROBE = `const text = document.body ? document.body.innerText : '';
let h = 0;
for (let i = 0; i < text.length; i += 1) { h = (h * 31 + text.charCodeAt(i)) | 0; }
return text.length + ':' + (h >>> 0);`;

/**
 * A page's visible text, read inside the page until it stops changing.
 *
 * The probe runs in the page, so one round trip covers the whole wait: it reads
 * the rendered text every 60 ms and resolves once two consecutive reads agree
 * (the page settled) or after ~13 ticks (~800 ms, under the evaluate budget).
 * It resolves with a short sample, not the whole text: the caller wants to know
 * that the page is still, not what it says.
 *
 * The page must at least have parsed its document: a page that is still
 * loading has nothing to compare, and would look "settled" while it is empty.
 */
const STABILITY_PROBE = `const read = () => (document.body ? document.body.innerText : '');
return await new Promise((resolve) => {
  let last = null;
  let quiet = 0;
  let ticks = 0;
  const tick = () => {
    const text = read();
    quiet = text === last ? quiet + 1 : 0;
    last = text;
    ticks += 1;
    const parsed = document.readyState !== 'loading';
    if ((quiet >= 2 && parsed) || ticks >= 13) resolve(text.slice(0, 120));
    else setTimeout(tick, 60);
  };
  tick();
});`;

/** The probe's value, as text: the evaluate reply carries a string value in both `text` and `result`. */
function valueOf(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  if (record.success !== true) return undefined;
  if (typeof record.result === 'string') return record.result;
  if (typeof record.text === 'string') return record.text.split('\n').pop();
  return undefined;
}

/**
 * The outcome of one fingerprint read.
 *
 * `value` is the fingerprint, or undefined when the page could not be read.
 * `permanent` says whether that failure is the end of the road: a tab that is
 * gone never comes back, while a transient failure (the debugger detached, the
 * target went away) clears on the next call - the extension says so itself:
 * "the debugger session failed; the next call reattaches on its own".
 */
export interface FingerprintRead {
  value: string | undefined;
  permanent: boolean;
}

/**
 * Error codes that mean the page is not coming back, so a wait must stop
 * instead of retrying a tab that no longer exists.
 *
 * The extension answers a tab that is gone with TAB_NOT_FOUND (or TAB_REPLACED
 * when another tab took its place); a protected page cannot be evaluated at
 * all. Every other failure is treated as transient, because the debugger
 * detaching clears on the next call.
 */
const PERMANENT_READ_FAILURES = ['TAB_NOT_FOUND', 'TAB_REPLACED', 'NO_WINDOW', 'INVALID_ARGUMENT'];

/** The failure's coded name: the text before the first colon of an error payload. */
function failureCode(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const error = (raw as Record<string, unknown>).error;
  if (typeof error !== 'string') return undefined;
  const code = error.split(':')[0]?.trim();
  return code || undefined;
}

/**
 * The page's fingerprint, or undefined when the page cannot be read.
 *
 * A read that fails for a transient reason is reported as such, so a caller
 * that waits can try again instead of reporting a stable page as still
 * changing.
 */
export async function pageFingerprint(host: ToolHost, tabId: number): Promise<string | undefined> {
  return (await readFingerprint(host, tabId)).value;
}

/** One fingerprint read, with the failure's permanence. */
export async function readFingerprint(host: ToolHost, tabId: number): Promise<FingerprintRead> {
  if (!Number.isFinite(tabId)) return { value: undefined, permanent: true };
  try {
    const raw = await host.callTool('browser_evaluate', { tabId, expression: FINGERPRINT_PROBE, timeout: 2000 });
    const value = valueOf(raw);
    if (value !== undefined) return { value, permanent: false };
    const code = failureCode(raw);
    return { value: undefined, permanent: code !== undefined && PERMANENT_READ_FAILURES.includes(code) };
  } catch {
    // A thrown call never carries a code, so it is treated as transient: the
    // next call may well succeed, and giving up here would report a stable
    // page as one that never settled.
    return { value: undefined, permanent: false };
  }
}

/**
 * Wait for the page to settle after an action.
 *
 * An action that changes the page in place (an SPA re-render, a filter that
 * swaps a list) returns before the page has drawn the new state, so a read that
 * follows it can see the previous one. Waiting for the page to settle closes
 * that window: the read after the action sees what the action produced.
 *
 * A page that cannot run the probe (a strict CSP, a tab that is gone) is left as
 * it is: the wait is an improvement, never a new failure.
 */
export async function waitForPageToSettle(host: ToolHost, tabId: number): Promise<boolean> {
  if (!Number.isFinite(tabId)) return false;
  try {
    const raw = await host.callTool('browser_evaluate', { tabId, expression: STABILITY_PROBE, timeout: 2000 }) as Record<string, unknown>;
    return raw?.success === true;
  } catch {
    return false;
  }
}

/** How long the page is left between two fingerprint reads. */
const FINGERPRINT_STEP_MS = 100;

/**
 * How long `browser_wait {until:'stable'}` waits by default.
 */
export const STABLE_WAIT_DEFAULT_MS = 10_000;

/**
 * How many consecutive failed reads end the wait.
 *
 * A read can fail for a moment (the debugger detached, the target went away)
 * and succeed on the next one, so a single failure must not end the wait: that
 * would report a page that had already settled as one that never settled.
 * Three in a row mean the page really cannot be read.
 */
const MAX_CONSECUTIVE_READ_FAILURES = 3;

export interface SettleOutcome {
  /** Whether the page stopped changing before the deadline. */
  settled: boolean;
  /** How long the wait took. */
  waitedMs: number;
  /** Why the wait ended without the page settling, when it did not. */
  reason?: 'unreadable' | 'timeout';
}

/**
 * Wait until the page stops changing, up to `timeoutMs`.
 *
 * The page is read every 100 ms; two consecutive identical fingerprints mean
 * the page settled. A page that never settles (a clock, a live feed) reaches
 * the deadline and is reported as still changing.
 *
 * A read that fails for a transient reason is retried inside the same wait: a
 * page that was already settled must not be reported as one that never
 * settled. A failure that cannot clear (the tab is gone) ends the wait at once.
 */
export async function waitUntilStable(host: ToolHost, tabId: number, timeoutMs: number): Promise<SettleOutcome> {
  const started = Date.now();
  const deadline = started + Math.max(0, timeoutMs);
  let last: string | undefined;
  let stableRounds = 0;
  let consecutiveFailures = 0;
  while (Date.now() < deadline) {
    const read = await readFingerprint(host, tabId);
    if (read.value === undefined) {
      if (read.permanent) {
        // The page cannot be read and will not come back: there is nothing to wait for.
        return { settled: false, waitedMs: Date.now() - started, reason: 'unreadable' };
      }
      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_CONSECUTIVE_READ_FAILURES) {
        // The page stayed unreadable across retries: it is not settling.
        return { settled: false, waitedMs: Date.now() - started, reason: 'unreadable' };
      }
      await new Promise((resolve) => setTimeout(resolve, FINGERPRINT_STEP_MS));
      continue;
    }
    consecutiveFailures = 0;
    stableRounds = read.value === last ? stableRounds + 1 : 0;
    last = read.value;
    if (stableRounds >= 1) return { settled: true, waitedMs: Date.now() - started };
    await new Promise((resolve) => setTimeout(resolve, FINGERPRINT_STEP_MS));
  }
  return { settled: false, waitedMs: Date.now() - started, reason: 'timeout' };
}
