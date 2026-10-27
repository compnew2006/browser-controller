import http from 'node:http';
import { authenticatedHttpGet } from './bridge-auth.js';

const ALLOWED_METHODS = 'GET, OPTIONS';
const ALLOWED_HEADERS = 'X-BC-Client-Nonce, X-BC-Server-Nonce, X-BC-Client-Proof';
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
      'Access-Control-Allow-Headers': ALLOWED_HEADERS,
      'Access-Control-Expose-Headers': 'X-BC-Response-Proof',
      Vary: 'Origin',
    };
  }
  return {
    'Access-Control-Allow-Methods': ALLOWED_METHODS,
    'Access-Control-Allow-Headers': ALLOWED_HEADERS,
    'Access-Control-Expose-Headers': 'X-BC-Response-Proof',
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

/** Verify the daemon's proof on the occupied port without sending a raw secret. */
export async function isDaemonResponsiveOnPort(
  host: string,
  port: number,
  timeoutMs = 1200,
  enrollmentSecret = '',
): Promise<boolean> {
  if (!enrollmentSecret) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await authenticatedHttpGet(
      `http://${host}:${port}`,
      '/status',
      enrollmentSecret,
      { signal: controller.signal },
    );
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
