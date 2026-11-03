import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  NATIVE_HOST_NAME, decodeMessage, encodeMessage, handleRequest, runHost,
} from '../mcp-server/src/native-host.js';
// @ts-expect-error -- plain ESM script without type declarations
import { HOST_NAME } from '../scripts/pairing.mjs';

const deps = (secret: string | null, port = 7225) => ({ readSecret: () => secret, readPort: () => port });

/** Feed `input` to the host and decode its single reply. */
async function exchange(chunks: Buffer[], hostDeps = deps('s3cret')) {
  const input = new PassThrough();
  const output = new PassThrough();
  const replies: Buffer[] = [];
  output.on('data', (c: Buffer) => replies.push(c));
  const done = runHost(input, output, hostDeps);
  for (const c of chunks) input.write(c);
  input.end();
  await done;
  return decodeMessage(Buffer.concat(replies));
}

describe('pairing native host', () => {
  it('uses the host name the installer registers', () => {
    expect(NATIVE_HOST_NAME).toBe(HOST_NAME);
  });

  it('frames messages as a 32-bit length + UTF-8 JSON, both ways', () => {
    const frame = encodeMessage({ type: 'pairing', note: 'ü' });
    expect(frame.readUInt32LE(0)).toBe(frame.length - 4);
    expect(decodeMessage(frame)).toEqual({ type: 'pairing', note: 'ü' });
    expect(decodeMessage(frame.subarray(0, frame.length - 1))).toBeUndefined();
  });

  it('answers a pairing request with the enrollment secret and the daemon port', () => {
    expect(handleRequest({ type: 'pairing' }, deps('s3cret', 9333))).toEqual({ ok: true, enrollmentSecret: 's3cret', port: 9333 });
  });

  it('says what to do when no secret exists yet, and refuses other requests', () => {
    expect(handleRequest({ type: 'pairing' }, deps(null))).toMatchObject({ ok: false, error: expect.stringMatching(/start your MCP client once/) });
    expect(handleRequest({ type: 'token' }, deps('s3cret'))).toEqual({ ok: false, error: 'Unsupported request.' });
    expect(handleRequest(null, deps('s3cret'))).toMatchObject({ ok: false });
  });

  it('reads a request split across chunks and replies once', async () => {
    const frame = encodeMessage({ type: 'pairing' });
    expect(await exchange([frame.subarray(0, 3), frame.subarray(3, 9), frame.subarray(9)])).toEqual({ ok: true, enrollmentSecret: 's3cret', port: 7225 });
  });

  it('rejects an oversized frame without reading it, and an empty stdin', async () => {
    const huge = Buffer.alloc(4);
    huge.writeUInt32LE(10 * 1024 * 1024, 0);
    expect(await exchange([huge])).toMatchObject({ ok: false, error: expect.stringMatching(/too large/) });
    expect(await exchange([])).toEqual({ ok: false, error: 'No request received.' });
  });

  it('the built host reads an isolated enrollment file over real stdio', () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-native-host-'));
    try {
      fs.writeFileSync(path.join(stateDir, 'enrollment.json'), JSON.stringify({ secret: 'synthetic-native-fixture', createdAt: 1 }), { mode: 0o600 });
      fs.writeFileSync(path.join(stateDir, 'daemon.json'), JSON.stringify({ port: 9444 }), { mode: 0o600 });
      const host = fileURLToPath(new URL('../mcp-server/dist/native-host.js', import.meta.url));
      const result = spawnSync(process.execPath, [host], {
        env: { ...process.env, BC_STATE_DIR: stateDir },
        input: encodeMessage({ type: 'pairing' }),
        timeout: 5000,
      });
      expect(result.status).toBe(0);
      expect(decodeMessage(result.stdout)).toEqual({ ok: true, enrollmentSecret: 'synthetic-native-fixture', port: 9444 });
      expect(result.stderr.toString()).not.toContain('synthetic-native-fixture');
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
