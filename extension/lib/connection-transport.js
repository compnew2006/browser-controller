/** Build the local WebSocket address without putting authentication in its URL. */
export function daemonWebSocketUrl(port) {
  return `ws://127.0.0.1:${port}`;
}

/** Probe liveness without credentials; only authenticated proofs establish daemon identity. */
export async function isDaemonListening(port, timeoutMs) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    await fetch(`http://127.0.0.1:${port}/status`, { cache: 'no-store', signal: abort.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Label the browser profile for multi-browser routing. */
export function defaultBrowserLabel(id) {
  const ua = navigator.userAgentData;
  const brand = ua?.brands?.find((b) => !/Not.?A.?Brand|Chromium/i.test(b.brand))?.brand || 'Chrome';
  const platform = ua?.platform || navigator.platform || '';
  return `${brand}${platform ? ` on ${platform}` : ''} (${id.slice(0, 4)})`;
}

/** Longest a pairing request (/pair, the native pairing host) may stay unanswered. */
export const PAIRING_TIMEOUT_MS = 5_000;

/**
 * Run `run(signal)` but give up after `ms`: abort the signal and reject. Races the timer too,
 * because a native message or an uncooperative fetch never looks at the signal.
 */
export function withTimeout(run, ms = PAIRING_TIMEOUT_MS) {
  const abort = new AbortController();
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => { abort.abort(); reject(new Error('request timed out')); }, ms);
  });
  return Promise.race([run(abort.signal), expired]).finally(() => clearTimeout(timer));
}
