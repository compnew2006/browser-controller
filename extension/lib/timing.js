/**
 * The time bounds the extension puts on a promise, in one place.
 *
 * A CDP command or a chrome.scripting call into a frozen page never answers, so
 * every such call is raced against a budget. Two outcomes are needed and the
 * difference is deliberate: a setup probe has no useful "not ready yet" answer
 * and must reject (raceReject), while an evaluate call can report the timeout
 * to its caller and keep the session (settleWithin + TIMED_OUT).
 *
 * The rejection message is passed in full, not derived from a label, because
 * two callers phrase it differently and the text reaches the agent (R5).
 */

/**
 * Settle with `promise`, or reject with `new Error(message)` after `ms`. The
 * pending call is left to settle on its own; only the race is cancelled.
 */
export function raceReject(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/** settleWithin() result when the time ran out (the pending call is left to settle on its own). */
export const TIMED_OUT = Symbol('timed out');

/**
 * Resolve with `promise`'s outcome, or with TIMED_OUT after `ms`. A CDP or
 * chrome.scripting call into a frozen page never answers, so a handler races every
 * such call against its own budget and returns on time, releasing its tab.
 */
export function settleWithin(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/** Wait `ms`; the only timer whose purpose is to let the page make progress. */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
