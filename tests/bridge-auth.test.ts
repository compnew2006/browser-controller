import { describe, expect, it } from 'vitest';
import {
  BridgeHttpAuthenticator,
  createHttpClientProof,
  verifyHttpServerProof,
  verifyHttpResponseProof,
} from '../mcp-server/src/bridge-auth.js';

const SECRET = 'synthetic-enrollment-secret-for-tests';
const NONCE_A = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function pairRequest(clientNonce: string, serverNonce: string) {
  return {
    clientNonce,
    serverNonce,
    method: 'GET',
    target: '/pair',
    clientProof: createHttpClientProof(SECRET, clientNonce, serverNonce, 'GET', '/pair'),
  };
}

describe('BridgeHttpAuthenticator', () => {
  it('issues a server-verifiable challenge tied to the caller nonce and daemon instance', () => {
    const auth = new BridgeHttpAuthenticator(SECRET, 'daemon-a');
    const challenge = auth.issueChallenge(NONCE_A);

    expect(challenge).toMatchObject({ protocolVersion: 1, clientNonce: NONCE_A, instanceId: 'daemon-a' });
    expect(verifyHttpServerProof(SECRET, challenge)).toBe(true);
    expect(verifyHttpServerProof('different-secret', challenge)).toBe(false);
    expect(verifyHttpServerProof(SECRET, { ...challenge, instanceId: 'daemon-b' })).toBe(false);
  });

  it('consumes a valid challenge once and binds authorization to method and exact target', () => {
    const auth = new BridgeHttpAuthenticator(SECRET, 'daemon-a');
    const challenge = auth.issueChallenge(NONCE_A);
    const clientProof = createHttpClientProof(
      SECRET, NONCE_A, challenge.serverNonce, 'GET', '/pair?scope=extension',
    );
    const request = {
      clientNonce: NONCE_A,
      serverNonce: challenge.serverNonce,
      method: 'GET',
      target: '/pair?scope=extension',
      clientProof,
    };

    expect(auth.verifyAndConsume(request)).toBe(true);
    expect(auth.verifyAndConsume(request)).toBe(false);

    const altered = auth.issueChallenge(NONCE_A);
    expect(auth.verifyAndConsume({
      ...request,
      serverNonce: altered.serverNonce,
      target: '/status',
      clientProof,
    })).toBe(false);
  });

  it('expires challenges', () => {
    let now = 100;
    const auth = new BridgeHttpAuthenticator(SECRET, 'daemon-a', { ttlMs: 50, now: () => now });
    const first = auth.issueChallenge(NONCE_A);
    now += 51;
    expect(auth.verifyAndConsume(pairRequest(NONCE_A, first.serverNonce))).toBe(false);
  });

  // Refusing new challenges when full would let any local process lock pairing and status out.
  it('keeps a hard capacity by evicting the oldest outstanding challenge, never by refusing a new one', () => {
    const auth = new BridgeHttpAuthenticator(SECRET, 'daemon-a', { maxChallenges: 2 });
    const nonces = ['A', 'B', 'C', 'D'].map((letter) => letter.repeat(43));
    const challenges = nonces.map((nonce) => auth.issueChallenge(nonce));

    expect(auth.verifyAndConsume(pairRequest(nonces[0], challenges[0].serverNonce))).toBe(false);
    expect(auth.verifyAndConsume(pairRequest(nonces[1], challenges[1].serverNonce))).toBe(false);
    expect(auth.verifyAndConsume(pairRequest(nonces[2], challenges[2].serverNonce))).toBe(true);
    expect(auth.verifyAndConsume(pairRequest(nonces[3], challenges[3].serverNonce))).toBe(true);
  });

  it('authenticates the exact response status and body', () => {
    const auth = new BridgeHttpAuthenticator(SECRET, 'daemon-a');
    const challenge = auth.issueChallenge(NONCE_A);
    const body = JSON.stringify({ token: 'synthetic-token' });
    const proof = auth.createResponseProof({
      clientNonce: NONCE_A,
      serverNonce: challenge.serverNonce,
      status: 200,
      body,
    });

    expect(verifyHttpResponseProof(SECRET, {
      clientNonce: NONCE_A,
      serverNonce: challenge.serverNonce,
      status: 200,
      body,
      proof,
    })).toBe(true);
    expect(verifyHttpResponseProof(SECRET, {
      clientNonce: NONCE_A,
      serverNonce: challenge.serverNonce,
      status: 403,
      body,
      proof,
    })).toBe(false);
    expect(verifyHttpResponseProof(SECRET, {
      clientNonce: NONCE_A,
      serverNonce: challenge.serverNonce,
      status: 200,
      body: JSON.stringify({ token: 'forged-token' }),
      proof,
    })).toBe(false);
  });
});
