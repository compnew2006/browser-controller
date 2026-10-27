import http from 'node:http';
import { corsHeaders, isAllowedOrigin } from './bridge-security.js';
import { BridgeHttpAuthenticator, HTTP_AUTH_CHALLENGE_PATH } from './bridge-auth.js';

export type HttpRequestHandler = (
  req: http.IncomingMessage,
  url: URL,
) => unknown | void | Promise<unknown | void>;

interface BridgeHttpHandlerOptions {
  host: string;
  authenticator: BridgeHttpAuthenticator;
  getHandler: () => HttpRequestHandler | null;
  getPinnedOrigin: () => string | null;
  pinOrigin: (origin: string) => void;
}

/** Authenticate the shared bridge HTTP surface before dispatching daemon routes. */
export function createBridgeHttpHandler(options: BridgeHttpHandlerOptions): http.RequestListener {
  return async (req, res) => {
    const decision = isAllowedOrigin(req, options.getPinnedOrigin());
    if (req.method === 'OPTIONS') {
      if (!decision.ok) {
        res.writeHead(403).end('Forbidden');
        return;
      }
      res.writeHead(204, corsHeaders(req, decision.origin)).end();
      return;
    }
    if (!decision.ok) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    // A malformed request-target must answer 400, never throw out of the async listener (daemon crash).
    let url: URL;
    try {
      url = new URL(req.url || '/', `http://${options.host}`);
    } catch {
      res.writeHead(400, corsHeaders(req, decision.origin)).end('Bad request');
      return;
    }
    if (req.method === 'GET' && url.pathname === HTTP_AUTH_CHALLENGE_PATH) {
      try {
        const challenge = options.authenticator.issueChallenge(url.searchParams.get('clientNonce') || '');
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          ...corsHeaders(req, decision.origin),
        }).end(JSON.stringify(challenge));
      } catch {
        res.writeHead(503, corsHeaders(req, decision.origin)).end('Authentication challenge unavailable');
      }
      return;
    }

    const headerValue = (name: string): string => {
      const value = req.headers[name];
      return Array.isArray(value) ? value[0] || '' : value || '';
    };
    const clientNonce = headerValue('x-bc-client-nonce');
    const serverNonce = headerValue('x-bc-server-nonce');
    if (!options.authenticator.verifyAndConsume({
      clientNonce,
      serverNonce,
      method: req.method || '',
      target: req.url || '/',
      clientProof: headerValue('x-bc-client-proof'),
    })) {
      res.writeHead(403, corsHeaders(req, decision.origin)).end('Forbidden');
      return;
    }
    if (decision.origin && !options.getPinnedOrigin()) options.pinOrigin(decision.origin);

    const sendAuthenticated = (status: number, body: string, contentType: string): void => {
      const responseProof = options.authenticator.createResponseProof({ clientNonce, serverNonce, status, body });
      res.writeHead(status, {
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
        'X-BC-Response-Proof': responseProof,
        ...corsHeaders(req, options.getPinnedOrigin()),
      }).end(body);
    };

    const handler = options.getHandler();
    if (req.method !== 'GET' || !handler) {
      sendAuthenticated(404, 'Not found', 'text/plain');
      return;
    }
    try {
      const out = await handler(req, url);
      if (out === undefined) {
        sendAuthenticated(404, 'Not found', 'text/plain');
        return;
      }
      const body = typeof out === 'string' ? out : JSON.stringify(out);
      sendAuthenticated(200, body, typeof out === 'string' ? 'text/plain' : 'application/json');
    } catch {
      sendAuthenticated(500, 'Internal daemon error', 'text/plain');
    }
  };
}
