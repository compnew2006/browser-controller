/**
 * Chrome native messaging host for zero-touch pairing.
 *
 * `npm run setup:pairing` (scripts/pairing.mjs) registers this script with the
 * Chromium browsers on the machine. Chrome starts it ONLY for the extension
 * IDs listed in the host manifest's `allowed_origins`, so a web page or a
 * co-installed extension cannot reach it. It answers one request with the
 * local enrollment secret (and the daemon's port) and exits.
 *
 * The secret stays out-of-band (SECURITY.md): it is read from
 * ~/.browser-controller/enrollment.json — which any process of this user can
 * already read — and never travels over the daemon's HTTP channel.
 *
 * stdout carries protocol frames only; diagnostics go to stderr.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DAEMON_INFO_FILE, DEFAULT_WS_PORT, readEnrollmentSecret } from './daemon-config.js';

export const NATIVE_HOST_NAME = 'com.browser_controller.pairing';
/** Requests are tiny ({type:"pairing"}); anything bigger is not ours. */
const MAX_REQUEST_BYTES = 64 * 1024;
const LITTLE_ENDIAN = os.endianness() === 'LE';

export interface PairingResponse {
  ok: boolean;
  enrollmentSecret?: string;
  port?: number;
  error?: string;
}

export interface HostDeps {
  readSecret: () => string | null;
  readPort: () => number;
}

/** Native messaging frame: 32-bit length in native byte order, then UTF-8 JSON. */
export function encodeMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  if (LITTLE_ENDIAN) header.writeUInt32LE(body.length, 0);
  else header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** The first complete frame in `buf`, or undefined while it is still incomplete. */
export function decodeMessage(buf: Buffer): unknown {
  if (buf.length < 4) return undefined;
  const length = LITTLE_ENDIAN ? buf.readUInt32LE(0) : buf.readUInt32BE(0);
  if (length > MAX_REQUEST_BYTES) throw new Error(`request too large (${length} bytes)`);
  if (buf.length < 4 + length) return undefined;
  return JSON.parse(buf.subarray(4, 4 + length).toString('utf8'));
}

/** The running daemon's port (daemon.json), else the configured default. */
function daemonPort(): number {
  try {
    const port = (JSON.parse(fs.readFileSync(DAEMON_INFO_FILE, 'utf8')) as { port?: unknown }).port;
    if (typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536) return port;
  } catch {
    // no daemon started yet
  }
  return DEFAULT_WS_PORT;
}

const defaultDeps: HostDeps = { readSecret: readEnrollmentSecret, readPort: daemonPort };

export function handleRequest(request: unknown, deps: HostDeps = defaultDeps): PairingResponse {
  if (!request || typeof request !== 'object' || (request as { type?: unknown }).type !== 'pairing') {
    return { ok: false, error: 'Unsupported request.' };
  }
  const secret = deps.readSecret();
  if (!secret) {
    return { ok: false, error: 'No enrollment secret yet: start your MCP client once so it creates ~/.browser-controller/enrollment.json.' };
  }
  return { ok: true, enrollmentSecret: secret, port: deps.readPort() };
}

/** Read one request from `input`, write one response to `output`. */
export function runHost(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  deps: HostDeps = defaultDeps,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    let done = false;
    const reply = (response: PairingResponse) => {
      if (done) return;
      done = true;
      input.removeAllListeners('data');
      output.write(encodeMessage(response), (err) => (err ? reject(err) : resolve()));
    };
    input.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      let request: unknown;
      try {
        request = decodeMessage(buf);
      } catch (err) {
        reply({ ok: false, error: err instanceof Error ? err.message : String(err) });
        return;
      }
      if (request !== undefined) reply(handleRequest(request, deps));
    });
    input.on('end', () => reply({ ok: false, error: 'No request received.' }));
    input.on('error', reject);
  });
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

if (isMainModule()) {
  runHost(process.stdin, process.stdout).then(
    () => process.exit(0),
    (err: unknown) => {
      process.stderr.write(`[${NATIVE_HOST_NAME}] ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
