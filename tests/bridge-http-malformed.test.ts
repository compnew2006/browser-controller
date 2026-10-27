import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { createBridgeHttpHandler } from '../mcp-server/src/bridge-http.js';
import { BridgeHttpAuthenticator } from '../mcp-server/src/bridge-auth.js';

let server: http.Server | null = null;
const unhandled: unknown[] = [];
const onUnhandled = (e: unknown) => { unhandled.push(e); };

afterEach(async () => {
  process.off('unhandledRejection', onUnhandled);
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
});

function raw(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(port, '127.0.0.1');
    let out = '';
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(request));
    sock.on('data', (d: string) => { out += d; });
    sock.on('end', () => resolve(out));
    sock.on('close', () => resolve(out));
    sock.on('error', reject);
    setTimeout(() => { sock.destroy(); resolve(out); }, 1500);
  });
}

describe('bridge http listener: malformed request-target', () => {
  it('answers 400 for an unparseable absolute-form target and keeps serving', async () => {
    process.on('unhandledRejection', onUnhandled);
    server = http.createServer(createBridgeHttpHandler({
      host: '127.0.0.1',
      authenticator: new BridgeHttpAuthenticator('synthetic-secret', 'daemon-a'),
      getHandler: () => null,
      getPinnedOrigin: () => null,
      pinOrigin: () => {},
    }));
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;

    const bad = await raw(port, 'GET http://:99999/ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    expect(bad).toMatch(/^HTTP\/1\.1 400 /);
    await new Promise((r) => setTimeout(r, 50));
    expect(unhandled).toEqual([]);

    const ok = await raw(port, 'GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    expect(ok).toMatch(/^HTTP\/1\.1 403 /);
  });
});
