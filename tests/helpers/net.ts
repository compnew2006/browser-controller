import net from 'node:net';

/**
 * A port the operating system says is free.
 *
 * The tests used to count upwards from a fixed base, which two workers running
 * side by side could pick from at once: the second one to bind got EACCES and
 * the test failed for a reason that had nothing to do with the code. Asking the
 * operating system for port 0 and taking the port it hands out keeps the
 * workers apart.
 */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}
