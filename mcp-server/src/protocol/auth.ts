import crypto from 'node:crypto';

/**
 * The authentication half of the wire handshake: the nonces, the transcripts
 * and the proofs the daemon and the extension exchange before any tool call.
 *
 * It lives inside the protocol package because a transcript IS the wire
 * contract: whoever owns the contract must own the bytes that prove it. The
 * local HTTP authentication of the popup stays in bridge-auth.ts, which
 * re-exports the names below so that no importer has to change.
 */

/** Version for extension WebSocket authentication; IPC remains at PROTOCOL_VERSION. */
export const WS_AUTH_PROTOCOL_VERSION = 2;

const NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** A shared secret is required before any transcript is signed. */
export function assertSecret(secret: string): void {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error('An enrollment secret is required for HTTP authentication.');
  }
}

/** Is this a nonce of the shape the handshake accepts? */
export function validNonce(nonce: unknown): nonce is string {
  return typeof nonce === 'string' && NONCE_PATTERN.test(nonce);
}

/** Is this a nonce of the shape the handshake accepts? */
export function isValidAuthNonce(nonce: unknown): nonce is string {
  return validNonce(nonce);
}

/** The HMAC of a transcript under a secret. */
export function mac(secret: string, transcript: string): string {
  return crypto.createHmac('sha256', secret).update(transcript, 'utf8').digest('base64url');
}

/** Compare a proof with the expected one without leaking its length or content. */
export function matchesMac(secret: string, transcript: string, proof: unknown): boolean {
  if (typeof proof !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(proof)) return false;
  const actual = Buffer.from(proof, 'base64url');
  const expected = Buffer.from(mac(secret, transcript), 'base64url');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/**
 * The capability list in a canonical order, so both sides sign the same bytes
 * whatever order the lists were written in.
 */
function normalizedCapabilities(capabilities: unknown): string {
  return Array.isArray(capabilities) && capabilities.every((item) => typeof item === 'string')
    ? [...capabilities].sort().join(',')
    : '';
}

/** The transcript the daemon signs when it says hello to the extension. */
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

/** The transcript the extension signs when it acknowledges the daemon's hello. */
export function webSocketClientTranscript(input: {
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

/** A fresh 256-bit nonce, base64url encoded. */
export function newAuthNonce(): string {
  return crypto.randomBytes(32).toString('base64url');
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
