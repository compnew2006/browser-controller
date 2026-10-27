import { EXTENSION_PROTOCOL_VERSION } from './protocol.js';

export const HTTP_AUTH_PROTOCOL_VERSION = 1;

const encoder = new TextEncoder();

export class DaemonAuthenticationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DaemonAuthenticationError';
  }
}

function base64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function validNonce(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}

export function newAuthNonce() {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

async function hmac(secret, transcript) {
  if (typeof secret !== 'string' || !secret) throw new DaemonAuthenticationError('Enrollment secret is unavailable.');
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return base64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(transcript))));
}

function constantTimeStringEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return difference === 0;
}

function httpServerTranscript(challenge) {
  return [
    'bc-http-server-v1',
    String(challenge.protocolVersion),
    challenge.clientNonce,
    challenge.serverNonce,
    challenge.instanceId,
  ].join('\n');
}

function httpClientTranscript({ clientNonce, serverNonce, method, target }) {
  return [
    'bc-http-client-v1',
    String(HTTP_AUTH_PROTOCOL_VERSION),
    clientNonce,
    serverNonce,
    method.toUpperCase(),
    target,
  ].join('\n');
}

async function responseTranscript({ clientNonce, serverNonce, status, body }) {
  const digest = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(body))));
  return [
    'bc-http-response-v1',
    String(HTTP_AUTH_PROTOCOL_VERSION),
    clientNonce,
    serverNonce,
    String(status),
    digest,
  ].join('\n');
}

export async function createWebSocketClientProof(token, hello, identity = {}) {
  if (!token || !validNonce(hello?.clientNonce) || !validNonce(hello?.serverNonce) || !hello?.instanceId) {
    throw new DaemonAuthenticationError('Cannot authenticate the extension handshake.');
  }
  const capabilities = Array.isArray(identity.capabilities ?? hello.capabilities)
    ? [...(identity.capabilities ?? hello.capabilities)].sort().join(',')
    : '';
  const transcript = [
    'bc-ws-client-v1',
    String(hello.protocolVersion),
    hello.clientNonce,
    hello.serverNonce,
    hello.instanceId,
    identity.browserId || '',
    identity.browserLabel || '',
    capabilities,
  ].join('\n');
  return hmac(token, transcript);
}

export async function verifyWebSocketDaemonProof(secret, hello, expectedNonce) {
  if (!hello || hello.type !== 'hello' || !validNonce(expectedNonce) ||
      hello.clientNonce !== expectedNonce || !validNonce(hello.serverNonce) ||
      typeof hello.instanceId !== 'string' || !hello.instanceId ||
      hello.protocolVersion !== EXTENSION_PROTOCOL_VERSION || !Array.isArray(hello.capabilities)) return false;
  const transcript = [
    'bc-ws-server-v1',
    String(hello.protocolVersion),
    expectedNonce,
    hello.serverNonce,
    hello.instanceId,
    [...hello.capabilities].sort().join(','),
  ].join('\n');
  try {
    return constantTimeStringEqual(await hmac(secret, transcript), hello.authProof);
  } catch {
    return false;
  }
}

export async function authenticatedDaemonFetch({
  baseUrl,
  target,
  enrollmentSecret,
  fetchImpl = fetch,
  signal,
}) {
  if (typeof target !== 'string' || !target.startsWith('/') || target.startsWith('//')) {
    throw new DaemonAuthenticationError('Invalid authenticated daemon request target.');
  }
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const clientNonce = newAuthNonce();
  const challengeUrl = base + '/auth/challenge?clientNonce=' + encodeURIComponent(clientNonce);
  const challengeResponse = await fetchImpl(challengeUrl, { method: 'GET', cache: 'no-store', redirect: 'error', signal });
  if (!challengeResponse.ok) throw new DaemonAuthenticationError('Daemon authentication challenge was not accepted.');
  let challenge;
  try { challenge = await challengeResponse.json(); } catch {
    throw new DaemonAuthenticationError('Daemon authentication failed: malformed challenge.');
  }
  if (!validNonce(clientNonce) || challenge?.clientNonce !== clientNonce ||
      challenge?.protocolVersion !== HTTP_AUTH_PROTOCOL_VERSION || !validNonce(challenge?.serverNonce) ||
      typeof challenge?.instanceId !== 'string' || !challenge.instanceId) {
    throw new DaemonAuthenticationError('Daemon authentication failed: invalid challenge.');
  }
  const expectedServerProof = await hmac(enrollmentSecret, httpServerTranscript(challenge));
  if (!constantTimeStringEqual(expectedServerProof, challenge.serverProof)) {
    throw new DaemonAuthenticationError('Daemon authentication failed: invalid challenge proof.');
  }

  const requestUrl = new URL(target, base + '/');
  const requestTarget = requestUrl.pathname + requestUrl.search;
  const clientProof = await hmac(enrollmentSecret, httpClientTranscript({
    clientNonce,
    serverNonce: challenge.serverNonce,
    method: 'GET',
    target: requestTarget,
  }));
  const response = await fetchImpl(base + requestTarget, {
    method: 'GET',
    cache: 'no-store',
    redirect: 'error',
    signal,
    headers: {
      'X-BC-Client-Nonce': clientNonce,
      'X-BC-Server-Nonce': challenge.serverNonce,
      'X-BC-Client-Proof': clientProof,
    },
  });
  const body = await response.text();
  const responseProof = response.headers.get('X-BC-Response-Proof');
  const expectedResponseProof = await hmac(enrollmentSecret, await responseTranscript({
    clientNonce,
    serverNonce: challenge.serverNonce,
    status: response.status,
    body,
  }));
  if (!constantTimeStringEqual(expectedResponseProof, responseProof)) {
    throw new DaemonAuthenticationError('Daemon authentication failed: invalid response proof.');
  }
  return {
    ok: response.ok,
    status: response.status,
    headers: response.headers,
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}
