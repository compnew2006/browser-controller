import net from 'node:net';

/**
 * Ports already handed out by this process, so two callers never receive the
 * same one.
 */
const handedOut = new Set<number>();

/**
 * A TCP port the operating system says is free right now.
 *
 * The daemon tests used to pick a random port out of a narrow window (50
 * ports in `tests/daemon.test.ts`, 2 000 in `tests/daemon-wire-tools.test.ts`,
 * a stride of 4 in `tests/daemon-restart.test.ts`). Two test processes running
 * at the same time could land on the same port, and the daemon — by design —
 * refuses to kill whoever already owns it ("Refusing to terminate another
 * process automatically", `mcp-server/src/bridge.ts:227`). The test file then
 * died with a bare `EADDRINUSE` instead of the assertion it was written for.
 *
 * Asking the kernel for an ephemeral port removes the collision window: the OS
 * hands out a port that is not in use, and the kernel keeps the ephemeral range
 * away from the developer's real daemon (port 7225) and from the narrow
 * windows the other test files used to pick from.
 *
 * The port is bound on `127.0.0.1` because that is the host the daemon is
 * given (`WS_HOST`): a port free on `0.0.0.0` is not necessarily free on the
 * loopback address, and vice versa.
 */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('free port: the server reported no TCP address')));
        return;
      }
      const { port } = address;
      server.close(() => {
        // The kernel may repeat a port it just released; never hand the same
        // one to two callers in this process.
        if (handedOut.has(port)) {
          freePort().then(resolve, reject);
          return;
        }
        handedOut.add(port);
        resolve(port);
      });
    });
  });
}
