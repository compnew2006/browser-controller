import { describe, it, expect } from 'vitest';
import net from 'node:net';
import { freePort } from './free-port.js';

/** Bind `port` on the address the daemon is given, and return the server. */
async function bind(port: number): Promise<net.Server> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}

function close(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('getFreePort', () => {
  it('hands out a port that can be bound on the address the daemon uses', async () => {
    const port = await freePort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65535);
    const server = await bind(port);
    await close(server);
  });

  it('never hands out a port that is already in use', async () => {
    // The defect this replaces: a random port out of a narrow window could
    // already be taken, and the daemon refuses to evict its owner.
    const held = await freePort();
    const server = await bind(held);
    try {
      expect(await freePort()).not.toBe(held);
    } finally {
      await close(server);
    }
  });

  it('hands out a different port every time', async () => {
    const ports = [await freePort(), await freePort(), await freePort()];
    expect(new Set(ports).size).toBe(3);
  });
});
