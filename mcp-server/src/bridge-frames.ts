/**
 * Inbound frame limits for the extension socket (used by bridge.ts).
 *
 * `ws` closes the connection (1009) for any frame above its maxPayload, before
 * the bridge can tell which call the frame answers. So the ws limit is the hard
 * ceiling below, and the soft cap is applied here: an oversized response fails
 * only the call it answers, and the connection stays up for every agent.
 */

/** Soft cap for one extension frame. BC_MAX_WS_MESSAGE_BYTES overrides it. */
export const MAX_WS_MESSAGE_BYTES = Math.max(
  1024,
  Number.parseInt(process.env.BC_MAX_WS_MESSAGE_BYTES ?? '', 10) || 1_000_000,
);

/** ws closes the socket above this; only a frame this large still tears the connection down. */
export const WS_HARD_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

/** What the check needs of a pending call: the connection it was sent to. */
export interface PendingCall {
  conn?: unknown;
}

/**
 * Oversized inbound frame (above `limit`). When it is a response to a call sent
 * to this connection, that call fails with RESPONSE_TOO_LARGE through `fail`.
 * Every extension response starts with its id (sendJson({ id, ...response })),
 * so only the head is read and the body is never parsed. Returns true when the
 * frame was oversized, so the caller stops there.
 */
export function rejectOversizedFrame(
  data: Buffer,
  limit: number,
  pending: Map<string, PendingCall>,
  conn: unknown,
  fail: (msg: { id: string; success: false; error: string }) => void,
): boolean {
  if (data.length <= limit) return false;
  const id = /^\{\s*"id"\s*:\s*"([^"\\]{1,128})"/.exec(data.subarray(0, 256).toString('utf8'))?.[1];
  const ours = id !== undefined && pending.get(id)?.conn === conn;
  console.error(`[Bridge] Oversized frame from a browser: ${data.length} bytes > ${limit}${ours ? `; failing call ${id}` : ''}`);
  if (id !== undefined && ours) {
    fail({
      id,
      success: false,
      error: `RESPONSE_TOO_LARGE: the browser sent a ${data.length}-byte response (limit ${limit} bytes). This call failed; the connection stays up. Ask for less (e.g. a smaller screenshot).`,
    });
  }
  return true;
}

/** Tools whose result may carry a `siteContext` block when the daemon sets `observe` (website memory). */
export const OBSERVABLE_TOOLS: ReadonlySet<string> = new Set(['browser_navigate', 'browser_snapshot', 'browser_click']);

/**
 * Request flag asking the extension for a `siteContext` block. It travels in `params` because the
 * frame sent by bridge.ts is a pure {tool, params} multiplexer. Only the daemon sets it: agent-supplied
 * values are dropped by `withObserve`, as with `expectFingerprints`.
 */
export const OBSERVE_FLAG = 'observe';

/**
 * Params for an extension request. For an observable tool any caller-supplied `observe` is dropped, then
 * set only when `observe` is true. Other tools keep their params untouched (action tools have their own
 * `observe: 'diff'`).
 */
export function withObserve(tool: string, params: Record<string, unknown>, observe: boolean): Record<string, unknown> {
  if (!OBSERVABLE_TOOLS.has(tool)) return params;
  const { [OBSERVE_FLAG]: _callerFlag, ...rest } = params;
  return observe ? { ...rest, [OBSERVE_FLAG]: true } : rest;
}
