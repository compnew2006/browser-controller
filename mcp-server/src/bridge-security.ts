import http from 'node:http';
import crypto from 'node:crypto';

const ALLOWED_METHODS = 'GET, OPTIONS';
const EXTENSION_ORIGIN_PREFIX = 'chrome-extension://';

/** Build restrictive CORS headers for the one pinned extension origin. */
export function corsHeaders(
  req: http.IncomingMessage,
  pinnedOrigin: string | null,
): http.OutgoingHttpHeaders {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin === pinnedOrigin) {
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': ALLOWED_METHODS,
      'Access-Control-Allow-Headers': 'Content-Type',
      Vary: 'Origin',
    };
  }
  return {
    'Access-Control-Allow-Methods': ALLOWED_METHODS,
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

/** Allow local non-browser clients or the exact extension origin pinned by TOFU. */
export function isAllowedOrigin(
  req: http.IncomingMessage,
  pinnedOrigin: string | null,
): { ok: boolean; origin: string | null } {
  const origin = req.headers.origin;
  if (!origin) return { ok: true, origin: null };
  if (typeof origin !== 'string' || !origin.startsWith(EXTENSION_ORIGIN_PREFIX)) {
    return { ok: false, origin: null };
  }
  return { ok: !pinnedOrigin || origin === pinnedOrigin, origin };
}

/** Prefix used to transport the auth token without putting it in the URL. */
export const AUTH_PROTOCOL_PREFIX = 'bc-auth.';

/**
 * The auth token comes only from the `bc-auth.<token>` WebSocket subprotocol. A
 * ?token= query is never read: query strings reach access logs and history.
 */
export function extractToken(req: http.IncomingMessage): string {
  const header = req.headers['sec-websocket-protocol'];
  if (header) {
    const offers = Array.isArray(header) ? header : String(header).split(',');
    for (const raw of offers) {
      const protocol = raw.trim();
      if (protocol.startsWith(AUTH_PROTOCOL_PREFIX)) {
        return protocol.slice(AUTH_PROTOCOL_PREFIX.length);
      }
    }
  }
  return '';
}

/** Compare credentials in constant time while preserving exact string equality. */
export function tokensMatch(presented: string, expected: string): boolean {
  if (!presented || !expected) return false;
  const actual = crypto.createHash('sha256').update(presented, 'utf8').digest();
  const wanted = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(actual, wanted);
}

/** Probe the authenticated daemon endpoint without trusting the port owner. */
export async function isDaemonResponsiveOnPort(
  host: string,
  port: number,
  timeoutMs = 1200,
  enrollmentSecret = '',
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = enrollmentSecret ? { 'X-BC-Enrollment': enrollmentSecret } : undefined;
  try {
    const response = await fetch(`http://${host}:${port}/pair`, { signal: controller.signal, headers });
    if (!response.ok) return false;
    const body = (await response.json()) as { token?: unknown };
    return typeof body?.token === 'string' && body.token.length > 0;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
