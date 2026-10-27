import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeHttpAuthenticator } from '../mcp-server/src/bridge-auth.js';
import { authenticatedDaemonFetch } from '../extension/lib/daemon-auth.js';

const SECRET = 'synthetic-enrollment-secret-for-tests';
const TOKEN = 'synthetic-pairing-token';
const INSTANCE_ID = 'daemon-a';
let auth: BridgeHttpAuthenticator;
let fetchMock: ReturnType<typeof vi.fn>;
let requests: Array<{ url: string; init?: RequestInit }> = [];

function response(status: number, body: string, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

beforeEach(() => {
  auth = new BridgeHttpAuthenticator(SECRET, INSTANCE_ID);
  requests = [];
  fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({ url: url.toString(), init });
    if (url.pathname === '/auth/challenge') {
      const challenge = auth.issueChallenge(url.searchParams.get('clientNonce') ?? '');
      return response(200, JSON.stringify(challenge));
    }

    const headers = new Headers(init?.headers);
    const clientNonce = headers.get('X-BC-Client-Nonce') ?? '';
    const serverNonce = headers.get('X-BC-Server-Nonce') ?? '';
    const clientProof = headers.get('X-BC-Client-Proof') ?? '';
    const accepted = auth.verifyAndConsume({
      clientNonce,
      serverNonce,
      method: init?.method ?? 'GET',
      target: url.pathname + url.search,
      clientProof,
    });
    expect(accepted).toBe(true);
    const body = JSON.stringify({ token: TOKEN });
    const proof = auth.createResponseProof({ clientNonce, serverNonce, status: 200, body });
    return response(200, body, { 'x-bc-response-proof': proof });
  });
});

describe('authenticatedDaemonFetch', () => {
  it('verifies the daemon before sending a proof and verifies the response before parsing it', async () => {
    const result = await authenticatedDaemonFetch({
      baseUrl: 'http://127.0.0.1:7225',
      target: '/pair',
      enrollmentSecret: SECRET,
      fetchImpl: fetchMock,
    });

    expect(await result.json()).toEqual({ token: TOKEN });
    expect(requests).toHaveLength(2);
    expect(requests[0].url).toMatch(/^http:\/\/127\.0\.0\.1:7225\/auth\/challenge\?clientNonce=/);
    expect(requests[1].url).toBe('http://127.0.0.1:7225/pair');
    for (const request of requests) {
      expect(request.url).not.toContain(SECRET);
      expect(request.url).not.toContain(TOKEN);
      expect(new Headers(request.init?.headers).get('X-BC-Enrollment')).toBeNull();
    }
  });

  it('does not send a request proof when the challenge responder is forged', async () => {
    fetchMock.mockImplementationOnce(async (input: string | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return response(200, JSON.stringify({
        protocolVersion: 1,
        instanceId: INSTANCE_ID,
        clientNonce: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        serverNonce: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
        serverProof: 'forged',
      }));
    });

    await expect(authenticatedDaemonFetch({
      baseUrl: 'http://127.0.0.1:7225',
      target: '/pair',
      enrollmentSecret: SECRET,
      fetchImpl: fetchMock,
    })).rejects.toThrow(/authentication/i);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).not.toContain(SECRET);
  });

  it('does not send a request proof when a challenge echoes the nonce but was signed without the secret', async () => {
    fetchMock.mockImplementationOnce(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push({ url: url.toString(), init });
      // Every field matches the request; only the enrollment secret behind the proof differs.
      const forged = new BridgeHttpAuthenticator('a-different-enrollment-secret', INSTANCE_ID)
        .issueChallenge(url.searchParams.get('clientNonce') ?? '');
      return response(200, JSON.stringify(forged));
    });

    await expect(authenticatedDaemonFetch({
      baseUrl: 'http://127.0.0.1:7225',
      target: '/pair',
      enrollmentSecret: SECRET,
      fetchImpl: fetchMock,
    })).rejects.toThrow(/invalid challenge proof/i);
    expect(requests).toHaveLength(1);
  });

  it('rejects a response whose body was changed after the daemon signed it', async () => {
    fetchMock.mockImplementationOnce(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push({ url: url.toString(), init });
      const challenge = auth.issueChallenge(url.searchParams.get('clientNonce') ?? '');
      return response(200, JSON.stringify(challenge));
    }).mockImplementationOnce(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push({ url: url.toString(), init });
      const headers = new Headers(init?.headers);
      const clientNonce = headers.get('X-BC-Client-Nonce') ?? '';
      const serverNonce = headers.get('X-BC-Server-Nonce') ?? '';
      const body = JSON.stringify({ token: TOKEN });
      const proof = auth.createResponseProof({ clientNonce, serverNonce, status: 200, body });
      return response(200, JSON.stringify({ token: 'tampered-token' }), { 'x-bc-response-proof': proof });
    });

    await expect(authenticatedDaemonFetch({
      baseUrl: 'http://127.0.0.1:7225',
      target: '/pair',
      enrollmentSecret: SECRET,
      fetchImpl: fetchMock,
    })).rejects.toThrow(/authentication/i);
  });
});
