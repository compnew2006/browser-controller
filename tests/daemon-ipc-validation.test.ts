import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import net from 'node:net';
import { buildIpcHello } from '../mcp-server/src/protocol/index.js';
import { isIpcClientMessage } from '../mcp-server/src/ipc-frame-validation.js';
import {
  connectFakeExtension, connectIpcClient, mkIsolatedStateDir, rmStateDir,
  startIsolatedDaemon, stopIsolatedDaemon,
  type DaemonHandle, type FakeExtension, type IpcClient,
} from './helpers/memory-fixtures.js';

let dir: string;
let daemon: DaemonHandle;
let extension: FakeExtension | undefined;
let client: IpcClient | undefined;

beforeEach(async () => {
  dir = mkIsolatedStateDir('bc-ipc-validation-');
  daemon = await startIsolatedDaemon(dir);
});

afterEach(async () => {
  client?.close();
  extension?.close();
  await stopIsolatedDaemon(daemon);
  rmStateDir(dir);
  client = undefined;
  extension = undefined;
});

function closed(socket: IpcClient['socket']): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('invalid IPC connection remained open')), 2000);
    socket.once('close', () => { clearTimeout(timeout); resolve(); });
  });
}

describe('daemon validates IPC request lifecycle', () => {
  it('accepts bounded activity metadata and rejects malformed or extra fields', () => {
    const actionContext = {
      eventId: '00000000-0000-4000-8000-000000000001',
      batchRunId: '00000000-0000-4000-8000-000000000002',
      batchStepIndex: 1,
    };
    const finished = {
      kind: 'batch-finished', schemaVersion: 1,
      batchRunId: actionContext.batchRunId,
      endedAt: '2026-11-09T10:00:00.000Z', executionStatus: 'completed',
    };
    const base = { kind: 'call', id: 'activity', tool: 'browser_click', params: { tabId: 1 } };

    expect(isIpcClientMessage({ ...base, activityContext: actionContext })).toBe(true);
    expect(isIpcClientMessage({ ...base, tool: 'browser_batch', params: {}, activityContext: finished })).toBe(true);
    expect(isIpcClientMessage({ ...base, activityContext: { ...actionContext, rawParams: { text: 'secret' } } })).toBe(false);
    expect(isIpcClientMessage({ ...base, activityContext: { eventId: actionContext.eventId, batchStepIndex: 1 } })).toBe(false);
  });

  it.each([
    ['event id', { kind: 'call', id: 'bad', tool: 'browser_click', params: {}, activityContext: { eventId: { toString: null } } }],
    ['batch id', { kind: 'call', id: 'bad', tool: 'browser_batch', params: {}, activityContext: {
      kind: 'batch-finished', schemaVersion: 1, batchRunId: { toString: null },
      endedAt: '2026-11-09T10:00:00.000Z', executionStatus: 'completed',
    } }],
    ['execution status', { kind: 'call', id: 'bad', tool: 'browser_batch', params: {}, activityContext: {
      kind: 'batch-finished', schemaVersion: 1, batchRunId: '00000000-0000-4000-8000-000000000002',
      endedAt: '2026-11-09T10:00:00.000Z', executionStatus: { toString: null },
    } }],
  ])('rejects non-primitive activity metadata (%s) without throwing', (_label, frame) => {
    const parsed = JSON.parse(JSON.stringify(frame));
    expect(() => isIpcClientMessage(parsed)).not.toThrow();
    expect(isIpcClientMessage(parsed)).toBe(false);
  });

  it('keeps the daemon alive after an authenticated client sends coercion-hostile activity metadata', async () => {
    client = await connectIpcClient(daemon.sockPath, daemon.token, 'malformed-activity-fixture');
    const disconnect = closed(client.socket);
    client.socket.write(`${JSON.stringify({
      kind: 'call', id: 'bad-activity', tool: 'browser_click', params: {},
      activityContext: { eventId: { toString: null } },
    })}\n`);
    await disconnect;

    const next = await connectIpcClient(daemon.sockPath, daemon.token, 'healthy-after-activity-fixture');
    next.close();
  });

  it('processes a call sent in the same packet as the authenticated hello', async () => {
    extension = await connectFakeExtension(daemon, 'pipeline-fixture');
    const socket = net.createConnection(daemon.sockPath);
    try {
      const result = new Promise<Record<string, any>>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('pipelined call did not receive a result')), 2000);
        let buffer = '';
        socket.on('data', (chunk) => {
          buffer += chunk.toString();
          let newline: number;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const message = JSON.parse(buffer.slice(0, newline));
            buffer = buffer.slice(newline + 1);
            if (message.kind === 'result' && message.id === 'pipelined') {
              clearTimeout(timeout);
              resolve(message);
            }
          }
        });
        socket.once('error', reject);
      });
      socket.write(`${JSON.stringify(buildIpcHello(daemon.token, 'pipeline-fixture'))}\n${JSON.stringify({ kind: 'call', id: 'pipelined', tool: 'browser_navigate', params: { url: 'https://example.test' } })}\n`);
      expect((await result).success).toBe(true);
    } finally {
      socket.destroy();
    }
  });

  it('rejects a non-string hello token without crashing the daemon', async () => {
    const socket = net.createConnection(daemon.sockPath);
    const disconnect = closed(socket);
    socket.write(`${JSON.stringify({ kind: 'hello', token: { malformed: true } })}\n`);
    await disconnect;
    const next = await connectIpcClient(daemon.sockPath, daemon.token, 'healthy-fixture');
    next.close();
  });

  it.each([
    ['null message', null],
    ['non-string id', { kind: 'call', id: 1, tool: 'browser_click', params: {} }],
    ['missing id', { kind: 'call', tool: 'browser_click', params: {} }],
    ['non-object parameters', { kind: 'call', id: 'bad', tool: 'browser_click', params: [] }],
  ])('closes a connection sending %s without taking down the daemon', async (_label, frame) => {
    client = await connectIpcClient(daemon.sockPath, daemon.token, 'invalid-fixture');
    const disconnect = closed(client.socket);
    client.socket.write(`${JSON.stringify(frame)}\n`);
    await disconnect;
    const next = await connectIpcClient(daemon.sockPath, daemon.token, 'healthy-fixture');
    next.close();
  });

  it('closes a client that reuses an in-flight id before dispatching its second action', async () => {
    extension = await connectFakeExtension(daemon, 'duplicate-fixture');
    // Keep the first browser action in flight until the duplicate is received.
    vi.spyOn(extension.ws, 'send').mockImplementation(() => {});
    client = await connectIpcClient(daemon.sockPath, daemon.token, 'duplicate-fixture');
    const disconnect = closed(client.socket);
    const received: Array<Record<string, unknown>> = [];
    extension.ws.on('message', (bytes) => received.push(JSON.parse(bytes.toString())));
    const first = { kind: 'call', id: 'same', tool: 'browser_click', params: { tabId: 1 } };
    const second = { kind: 'call', id: 'same', tool: 'browser_click', params: { tabId: 2 } };
    client.socket.write(`${JSON.stringify(first)}\n`);
    const waitFor = async (condition: () => boolean) => {
      const deadline = Date.now() + 2000;
      while (!condition()) {
        if (Date.now() > deadline) throw new Error('extension did not receive the expected frame');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    await waitFor(() => extension!.calls.some((call) => call.params.tabId === 1));
    client.socket.write(`${JSON.stringify(second)}\n`);
    await disconnect;
    await waitFor(() => received.some((frame) => frame.type === 'cancel'));
    expect(extension.calls.filter((call) => call.params.tabId === 2)).toHaveLength(0);
    const next = await connectIpcClient(daemon.sockPath, daemon.token, 'healthy-fixture');
    next.close();
  });
});
