import type net from 'node:net';

/**
 * Drop an IPC socket that has not completed the hello within `graceMs`, so an
 * idle local connection is not held forever. Returns the disarm function the
 * caller runs once the hello succeeds; the timer also stops when the socket closes.
 */
export function armIpcHelloTimer(socket: net.Socket, graceMs: number, onTimeout?: () => void): () => void {
  const timer = setTimeout(() => {
    onTimeout?.();
    socket.destroy();
  }, graceMs);
  timer.unref();
  const disarm = () => clearTimeout(timer);
  socket.once('close', disarm);
  return disarm;
}
