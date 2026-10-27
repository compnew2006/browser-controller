import crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BridgeHttpAuthenticator,
  createHttpClientProof,
  createWebSocketClientProof as tsWsClientProof,
  createWebSocketDaemonProof,
  verifyHttpResponseProof,
  verifyHttpServerProof,
  verifyWebSocketClientProof,
} from '../mcp-server/src/bridge-auth.js';
import {
  authenticatedDaemonFetch,
  createWebSocketClientProof as jsWsClientProof,
  verifyWebSocketDaemonProof,
} from '../extension/lib/daemon-auth.js';

/**
 * Golden vectors for the auth transcripts (audit F2-4). bridge-auth.ts and
 * extension/lib/daemon-auth.js build the same transcripts by hand, with no
 * shared module. Fixed inputs go through both; each runtime must produce the
 * golden HMAC, so a field-order or label drift in either copy fails here.
 * Secret and nonces are synthetic.
 */
const SECRET = 'golden-secret-not-real';
const INSTANCE = 'inst-golden';
const nonce = (offset: number): string => Buffer.from(Array.from({ length: 32 }, (_, i) => i + offset)).toString('base64url');
const CLIENT_NONCE = nonce(0);
const SERVER_NONCE = nonce(32);
const TARGET = '/status?x=1';
const BODY = '{"ok":true,"n":1}';
const CAPS = ['b', 'a']; // unsorted on purpose: both runtimes sort

const GOLDEN = {
  httpServer: 'Fg9zkkU1oHtOPH4QP5F9TKbmUo61zoAb-RgNiJJsUgc',
  httpClient: 'Z4b-yqibGjcePq__WE6oKhTt1GnS02UE9--wRApVyDs',
  httpResponse: '-1U9FNnjli5A9XExZ0zJDu_Hg8xkjXrm0VBMqEvbySA',
  wsServer: 'jG_aO-LjMSUqqo0X-ifmkcdNNqPUbshjSpoZX29SfIE',
  wsClient: 'iJtPiYpHvAUPBEd_4JHgLfmtlFNDaXZtIo3SJQakz_Q',
};

/** The transcripts written out literally: the vectors above must be their HMACs. */
const digest = crypto.createHash('sha256').update(BODY, 'utf8').digest('base64url');
const TRANSCRIPTS: Record<keyof typeof GOLDEN, string[]> = {
  httpServer: ['bc-http-server-v1', '1', CLIENT_NONCE, SERVER_NONCE, INSTANCE],
  httpClient: ['bc-http-client-v1', '1', CLIENT_NONCE, SERVER_NONCE, 'GET', TARGET],
  httpResponse: ['bc-http-response-v1', '1', CLIENT_NONCE, SERVER_NONCE, '200', digest],
  wsServer: ['bc-ws-server-v1', '2', CLIENT_NONCE, SERVER_NONCE, INSTANCE, 'a,b'],
  wsClient: ['bc-ws-client-v1', '2', CLIENT_NONCE, SERVER_NONCE, INSTANCE, 'browser-1', 'Work', 'a,b'],
};
const hmac = (fields: string[]): string => crypto.createHmac('sha256', SECRET).update(fields.join('\n'), 'utf8').digest('base64url');

const wsInput = { protocolVersion: 2, clientNonce: CLIENT_NONCE, serverNonce: SERVER_NONCE, instanceId: INSTANCE, capabilities: CAPS };

afterEach(() => { vi.restoreAllMocks(); });

describe('golden transcript vectors', () => {
  it('literal transcripts hash to the golden vectors', () => {
    for (const kind of Object.keys(GOLDEN) as Array<keyof typeof GOLDEN>) expect(hmac(TRANSCRIPTS[kind])).toBe(GOLDEN[kind]);
  });

  it('TS builds every proof byte-identically to the golden', () => {
    expect(createHttpClientProof(SECRET, CLIENT_NONCE, SERVER_NONCE, 'get', TARGET)).toBe(GOLDEN.httpClient);
    expect(new BridgeHttpAuthenticator(SECRET, INSTANCE)
      .createResponseProof({ clientNonce: CLIENT_NONCE, serverNonce: SERVER_NONCE, status: 200, body: BODY })).toBe(GOLDEN.httpResponse);
    expect(createWebSocketDaemonProof(SECRET, wsInput)).toBe(GOLDEN.wsServer);
    expect(tsWsClientProof(SECRET, { ...wsInput, browserId: 'browser-1', browserLabel: 'Work' })).toBe(GOLDEN.wsClient);
  });

  it('TS verifies the golden server-side proofs', () => {
    expect(verifyHttpServerProof(SECRET, {
      protocolVersion: 1, instanceId: INSTANCE, clientNonce: CLIENT_NONCE, serverNonce: SERVER_NONCE, serverProof: GOLDEN.httpServer,
    })).toBe(true);
    expect(verifyHttpResponseProof(SECRET, {
      clientNonce: CLIENT_NONCE, serverNonce: SERVER_NONCE, status: 200, body: BODY, proof: GOLDEN.httpResponse,
    })).toBe(true);
    expect(verifyWebSocketClientProof(SECRET, {
      protocolVersion: 2, clientNonce: CLIENT_NONCE, instanceId: INSTANCE, browserId: 'browser-1', browserLabel: 'Work',
      capabilities: CAPS, authProof: GOLDEN.wsClient,
    }, CLIENT_NONCE, INSTANCE, SERVER_NONCE)).toBe(true);
  });

  it('JS builds the WS helloAck proof byte-identically to the golden and verifies the golden hello proof', async () => {
    expect(await jsWsClientProof(SECRET, wsInput, { browserId: 'browser-1', browserLabel: 'Work' })).toBe(GOLDEN.wsClient);
    expect(await verifyWebSocketDaemonProof(SECRET, {
      type: 'hello', ...wsInput, authProof: GOLDEN.wsServer,
    }, CLIENT_NONCE)).toBe(true);
  });

  it('JS HTTP flow accepts the golden server and response proofs and sends the golden client proof', async () => {
    vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(((array: Uint8Array) => {
      array.set(Array.from({ length: 32 }, (_, i) => i));
      return array;
    }) as typeof crypto.getRandomValues);
    const sent: Array<Record<string, string>> = [];
    const fetchImpl = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
      if (String(url).includes('/auth/challenge')) {
        return new Response(JSON.stringify({
          protocolVersion: 1, instanceId: INSTANCE, clientNonce: CLIENT_NONCE, serverNonce: SERVER_NONCE, serverProof: GOLDEN.httpServer,
        }), { status: 200 });
      }
      sent.push(init?.headers ?? {});
      return new Response(BODY, { status: 200, headers: { 'X-BC-Response-Proof': GOLDEN.httpResponse } });
    });
    const response = await authenticatedDaemonFetch({
      baseUrl: 'http://127.0.0.1:1', target: TARGET, enrollmentSecret: SECRET, fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await response.text()).toBe(BODY);
    expect(sent[0]['X-BC-Client-Proof']).toBe(GOLDEN.httpClient);
    expect(sent[0]['X-BC-Client-Nonce']).toBe(CLIENT_NONCE);
  });

  it('detects drift: a local copy with swapped field order no longer matches the golden', () => {
    const drifted = [...TRANSCRIPTS.httpClient];
    [drifted[2], drifted[3]] = [drifted[3], drifted[2]]; // nonces swapped
    expect(hmac(drifted)).not.toBe(GOLDEN.httpClient);
    const wsDrift = [...TRANSCRIPTS.wsClient];
    [wsDrift[5], wsDrift[6]] = [wsDrift[6], wsDrift[5]]; // browserId/browserLabel swapped
    expect(hmac(wsDrift)).not.toBe(GOLDEN.wsClient);
  });
});
