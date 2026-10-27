import net from 'node:net';

/**
 * Does a Browser Controller daemon answer on the IPC socket? Any protocol
 * frame back proves it (a non-hello first frame gets a `denied` reply), so a
 * recycled pid that owns no such socket is told apart from a real daemon.
 * Mirrors ipcAnswers in scripts/daemon.mjs.
 */
export function ipcAnswers(socketPath: string, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (answered: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(answered);
    };
    const sock = net.createConnection(socketPath);
    const timer = setTimeout(() => finish(false), timeoutMs);
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(JSON.stringify({ kind: 'probe' }) + '\n'));
    sock.on('data', (chunk: string) => {
      buf += chunk;
      try {
        const msg = JSON.parse(buf.split('\n')[0]);
        finish(!!msg && typeof msg.kind === 'string');
      } catch { /* wait for the rest of the line */ }
    });
    sock.on('error', () => finish(false));
    sock.on('close', () => finish(false));
  });
}
