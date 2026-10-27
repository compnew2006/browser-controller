import crypto from 'node:crypto';

export const HTTP_AUTH_PROTOCOL_VERSION = 1;
export const HTTP_AUTH_CHALLENGE_PATH = '/auth/challenge';
export const WS_AUTH_PROTOCOL_VERSION = 2;

const NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DEFAULT_CHALLENGE_TTL_MS = 30_000;
const DEFAULT_MAX_CHALLENGES = 1_024;

export interface HttpAuthChallenge {
  protocolVersion: number;
  instanceId: string;
  clientNonce: string;
  serverNonce: string;
  serverProof: string;
}

export interface HttpResponseProofInput {
  clientNonce: string;
  serverNonce: string;
  status: number;
  body: string;
}

interface ChallengeState {
  clientNonce: string;
  expiresAt: number;
}

export interface BridgeHttpAuthenticatorOptions {
  ttlMs?: number;
  maxChallenges?: number;
  now?: () => number;
}

function assertSecret(secret: string): void {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error('An enrollment secret is required for HTTP authentication.');
  }
}

function validNonce(nonce: unknown): nonce is string {
  return typeof nonce === 'string' && NONCE_PATTERN.test(nonce);
}

export function isValidAuthNonce(nonce: unknown): nonce is string {
  return validNonce(nonce);
}

function mac(secret: string, transcript: string): string {
  return crypto.createHmac('sha256', secret).update(transcript, 'utf8').digest('base64url');
}

function matchesMac(secret: string, transcript: string, proof: unknown): boolean {
  if (typeof proof !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(proof)) return false;
  const actual = Buffer.from(proof, 'base64url');
  const expected = Buffer.from(mac(secret, transcript), 'base64url');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function serverTranscript(challenge: Pick<HttpAuthChallenge, 'protocolVersion' | 'instanceId' | 'clientNonce' | 'serverNonce'>): string {
  return [
    'bc-http-server-v1',
    String(challenge.protocolVersion),
    challenge.clientNonce,
    challenge.serverNonce,
    challenge.instanceId,
  ].join('\n');
}

function clientTranscript(input: {
  clientNonce: string;
  serverNonce: string;
  method: string;
  target: string;
}): string {
  return [
    'bc-http-client-v1',
    String(HTTP_AUTH_PROTOCOL_VERSION),
    input.clientNonce,
    input.serverNonce,
    input.method.toUpperCase(),
    input.target,
  ].join('\n');
}

function responseTranscript(input: HttpResponseProofInput): string {
  const digest = crypto.createHash('sha256').update(input.body, 'utf8').digest('base64url');
  return [
    'bc-http-response-v1',
    String(HTTP_AUTH_PROTOCOL_VERSION),
    input.clientNonce,
    input.serverNonce,
    String(input.status),
    digest,
  ].join('\n');
}

function normalizedCapabilities(capabilities: unknown): string {
  return Array.isArray(capabilities) && capabilities.every((item) => typeof item === 'string')
    ? [...capabilities].sort().join(',')
    : '';
}

function webSocketServerTranscript(input: {
  protocolVersion: number;
  clientNonce: string;
  serverNonce: string;
  instanceId: string;
  capabilities: unknown;
}): string {
  return [
    'bc-ws-server-v1',
    String(input.protocolVersion),
    input.clientNonce,
    input.serverNonce,
    input.instanceId,
    normalizedCapabilities(input.capabilities),
  ].join('\n');
}

function webSocketClientTranscript(input: {
  protocolVersion: number;
  clientNonce: string;
  serverNonce: string;
  instanceId: string;
  browserId?: unknown;
  browserLabel?: unknown;
  capabilities: unknown;
}): string {
  return [
    'bc-ws-client-v1',
    String(input.protocolVersion),
    input.clientNonce,
    input.serverNonce,
    input.instanceId,
    typeof input.browserId === 'string' ? input.browserId : '',
    typeof input.browserLabel === 'string' ? input.browserLabel : '',
    normalizedCapabilities(input.capabilities),
  ].join('\n');
}

export function newAuthNonce(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function createHttpClientProof(
  secret: string,
  clientNonce: string,
  serverNonce: string,
  method: string,
  target: string,
): string {
  assertSecret(secret);
  if (!validNonce(clientNonce) || !validNonce(serverNonce)) throw new Error('Invalid HTTP authentication nonce.');
  return mac(secret, clientTranscript({ clientNonce, serverNonce, method, target }));
}

export function verifyHttpServerProof(secret: string, challenge: HttpAuthChallenge): boolean {
  if (!secret || !challenge || challenge.protocolVersion !== HTTP_AUTH_PROTOCOL_VERSION ||
      typeof challenge.instanceId !== 'string' || !challenge.instanceId ||
      !validNonce(challenge.clientNonce) || !validNonce(challenge.serverNonce)) return false;
  return matchesMac(secret, serverTranscript(challenge), challenge.serverProof);
}

export function verifyHttpResponseProof(
  secret: string,
  input: HttpResponseProofInput & { proof: unknown },
): boolean {
  if (!secret || !validNonce(input.clientNonce) || !validNonce(input.serverNonce) ||
      !Number.isInteger(input.status) || typeof input.body !== 'string') return false;
  return matchesMac(secret, responseTranscript(input), input.proof);
}

export function createWebSocketDaemonProof(secret: string, input: {
  protocolVersion: number;
  clientNonce: string;
  serverNonce: string;
  instanceId: string;
  capabilities: unknown;
}): string {
  assertSecret(secret);
  if (!validNonce(input.clientNonce) || !validNonce(input.serverNonce) || !input.instanceId) {
    throw new Error('Invalid WebSocket authentication context.');
  }
  return mac(secret, webSocketServerTranscript(input));
}

export function createWebSocketClientProof(token: string, input: {
  protocolVersion: number;
  clientNonce: string;
  serverNonce: string;
  instanceId: string;
  browserId?: unknown;
  browserLabel?: unknown;
  capabilities: unknown;
}): string {
  assertSecret(token);
  if (!validNonce(input.clientNonce) || !validNonce(input.serverNonce) || !input.instanceId) {
    throw new Error('Invalid WebSocket authentication context.');
  }
  return mac(token, webSocketClientTranscript(input));
}

export function verifyWebSocketClientProof(
  token: string,
  acknowledgement: {
    protocolVersion?: unknown;
    clientNonce?: unknown;
    instanceId?: unknown;
    browserId?: unknown;
    browserLabel?: unknown;
    capabilities?: unknown;
    authProof?: unknown;
  },
  expectedNonce: string,
  expectedInstanceId: string,
  // Chosen by the daemon for this socket: an acknowledgement captured from another one never matches.
  expectedServerNonce: string,
): boolean {
  if (!token || !acknowledgement || acknowledgement.protocolVersion !== WS_AUTH_PROTOCOL_VERSION ||
      acknowledgement.clientNonce !== expectedNonce || !validNonce(expectedNonce) || !validNonce(expectedServerNonce) ||
      acknowledgement.instanceId !== expectedInstanceId || !Array.isArray(acknowledgement.capabilities) ||
      acknowledgement.capabilities.some((item) => typeof item !== 'string')) return false;
  return matchesMac(token, webSocketClientTranscript({
    protocolVersion: WS_AUTH_PROTOCOL_VERSION,
    clientNonce: expectedNonce,
    serverNonce: expectedServerNonce,
    instanceId: expectedInstanceId,
    browserId: acknowledgement.browserId,
    browserLabel: acknowledgement.browserLabel,
    capabilities: acknowledgement.capabilities,
  }), acknowledgement.authProof);
}

export class BridgeHttpAuthenticator {
  private readonly challenges = new Map<string, ChallengeState>();
  private readonly ttlMs: number;
  private readonly maxChallenges: number;
  private readonly now: () => number;

  constructor(
    private readonly secret: string,
    private readonly instanceId: string,
    options: BridgeHttpAuthenticatorOptions = {},
  ) {
    assertSecret(secret);
    if (!instanceId) throw new Error('A daemon instance id is required for HTTP authentication.');
    this.ttlMs = options.ttlMs ?? DEFAULT_CHALLENGE_TTL_MS;
    this.maxChallenges = options.maxChallenges ?? DEFAULT_MAX_CHALLENGES;
    this.now = options.now ?? Date.now;
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) throw new Error('Challenge TTL must be positive.');
    if (!Number.isInteger(this.maxChallenges) || this.maxChallenges <= 0) throw new Error('Challenge capacity must be positive.');
  }

  issueChallenge(clientNonce: string): HttpAuthChallenge {
    if (!validNonce(clientNonce)) throw new Error('Invalid client nonce.');
    this.pruneExpired();
    // A full store gives way oldest-first: refusing new challenges would let any
    // local process lock pairing and status out by requesting them in a loop.
    if (this.challenges.size >= this.maxChallenges) {
      const [oldest] = this.challenges.keys();
      this.challenges.delete(oldest);
    }
    const serverNonce = newAuthNonce();
    const challenge: HttpAuthChallenge = {
      protocolVersion: HTTP_AUTH_PROTOCOL_VERSION,
      instanceId: this.instanceId,
      clientNonce,
      serverNonce,
      serverProof: '',
    };
    challenge.serverProof = mac(this.secret, serverTranscript(challenge));
    this.challenges.set(serverNonce, { clientNonce, expiresAt: this.now() + this.ttlMs });
    return challenge;
  }

  /** Consume the challenge before verifying the proof so even a failed attempt cannot be replayed. */
  verifyAndConsume(input: {
    clientNonce: string;
    serverNonce: string;
    method: string;
    target: string;
    clientProof: unknown;
  }): boolean {
    if (!validNonce(input.clientNonce) || !validNonce(input.serverNonce)) return false;
    const issued = this.challenges.get(input.serverNonce);
    this.challenges.delete(input.serverNonce);
    if (!issued || issued.expiresAt <= this.now() || issued.clientNonce !== input.clientNonce) return false;
    return matchesMac(this.secret, clientTranscript(input), input.clientProof);
  }

  createResponseProof(input: HttpResponseProofInput): string {
    assertSecret(this.secret);
    if (!validNonce(input.clientNonce) || !validNonce(input.serverNonce)) throw new Error('Invalid HTTP authentication nonce.');
    return mac(this.secret, responseTranscript(input));
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [nonce, challenge] of this.challenges) {
      if (challenge.expiresAt <= now) this.challenges.delete(nonce);
    }
  }
}

export interface AuthenticatedHttpResponse {
  ok: boolean;
  status: number;
  body: string;
  headers: Headers;
}

export async function authenticatedHttpGet(
  baseUrl: string,
  target: string,
  secret: string,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<AuthenticatedHttpResponse> {
  assertSecret(secret);
  if (!target.startsWith('/') || target.startsWith('//')) throw new Error('Authenticated HTTP target must be an absolute path.');
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const clientNonce = newAuthNonce();
  const challengeUrl = base + HTTP_AUTH_CHALLENGE_PATH + '?clientNonce=' + encodeURIComponent(clientNonce);
  const challengeResponse = await fetchImpl(challengeUrl, { method: 'GET', cache: 'no-store', redirect: 'error', signal: options.signal });
  if (!challengeResponse.ok) throw new Error('Daemon authentication challenge was not accepted.');
  const challenge = await challengeResponse.json() as HttpAuthChallenge;
  if (challenge.clientNonce !== clientNonce || !verifyHttpServerProof(secret, challenge)) {
    throw new Error('Daemon authentication failed: invalid challenge proof.');
  }
  const requestUrl = new URL(target, base + '/');
  const requestTarget = requestUrl.pathname + requestUrl.search;
  const clientProof = createHttpClientProof(secret, clientNonce, challenge.serverNonce, 'GET', requestTarget);
  const response = await fetchImpl(base + requestTarget, {
    method: 'GET',
    cache: 'no-store',
    redirect: 'error',
    signal: options.signal,
    headers: {
      'X-BC-Client-Nonce': clientNonce,
      'X-BC-Server-Nonce': challenge.serverNonce,
      'X-BC-Client-Proof': clientProof,
    },
  });
  const body = await response.text();
  const proof = response.headers.get('X-BC-Response-Proof');
  if (!verifyHttpResponseProof(secret, {
    clientNonce,
    serverNonce: challenge.serverNonce,
    status: response.status,
    body,
    proof,
  })) {
    throw new Error('Daemon authentication failed: invalid response proof.');
  }
  return { ok: response.ok, status: response.status, body, headers: response.headers };
}
