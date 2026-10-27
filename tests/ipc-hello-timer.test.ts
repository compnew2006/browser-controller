import { afterEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import { armIpcHelloTimer } from '../mcp-server/src/ipc-hello-timer.js';

// A real local TCP pair on an OS-assigned port (no fixed port to collide with other files).
describe('armIpcHelloTimer (F1-2)', () => {
  const open: net.Socket[] = [];
  let server: net.Server | null = null;
  afterEach(async () => {
    open.forEach((s) => s.destroy());
    open.length = 0;
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = null;
  });

  async function pair(): Promise<{ serverSide: net.Socket; client: net.Socket }> {
    let serverSide!: net.Socket;
    server = net.createServer((s) => { serverSide = s; open.push(s); });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const client = net.createConnection((server.address() as net.AddressInfo).port, '127.0.0.1');
    open.push(client);
    await new Promise<void>((r) => client.once('connect', r));
    await new Promise((r) => setTimeout(r, 20));
    return { serverSide, client };
  }

  it('destroys a socket that never completes the hello within the grace', async () => {
    const { serverSide, client } = await pair();
    const closed = new Promise<void>((r) => client.once('close', () => r()));
    armIpcHelloTimer(serverSide, 60);
    await closed;
    expect(serverSide.destroyed).toBe(true);
  });

  it('leaves a socket alone once disarmed after a completed hello', async () => {
    const { serverSide } = await pair();
    const disarm = armIpcHelloTimer(serverSide, 60);
    disarm();
    await new Promise((r) => setTimeout(r, 150));
    expect(serverSide.destroyed).toBe(false);
  });

  it('is cleared when the socket closes first', async () => {
    const { serverSide, client } = await pair();
    armIpcHelloTimer(serverSide, 60);
    client.destroy();
    await new Promise((r) => setTimeout(r, 150));
    expect(serverSide.destroyed).toBe(true); // closed by the peer, no throw from a late timer
  });
});
