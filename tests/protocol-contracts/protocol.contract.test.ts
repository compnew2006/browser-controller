/**
 * The wire contract, pinned.
 *
 * The daemon, the thin client and the Chrome extension are three independent
 * peers: none of them imports the others, so a field that is renamed, moved or
 * dropped in one place breaks the connection at runtime, not at build time.
 * These tests are the contract: they read the builders in
 * `mcp-server/src/protocol/` and assert the exact shape of every frame — the
 * key set AND the key order, because the order is what a peer that reads the
 * frame positionally depends on.
 *
 * The expectations below were derived from the code, not from memory: each
 * golden list was produced by calling the builder and printing
 * `Object.keys(frame)`.
 *
 * What is NOT pinned here, and why: the daemon builds its inline IPC `call`
 * and `result` frames inside `daemon.ts`/`index.ts` instead of through
 * `protocol/frames.ts`, so there is no single owner to pin them against.
 * Extracting those two frames into the protocol package is the fix, and it is
 * an owner decision (it changes the wire package's surface).
 */
import { describe, expect, it } from 'vitest';
import {
  EXTENSION_PROTOCOL_CAPABILITIES,
  EXTENSION_PROTOCOL_VERSION,
  IPC_PROTOCOL_CAPABILITIES,
  MEMORY_ADMIN_CAPABILITY,
  PROTOCOL_VERSION,
  TOOL_NAMES,
  buildExtensionHello,
  buildExtensionHelloAck,
  buildIpcHello,
  buildIpcWelcome,
  buildSessionId,
  isKnownWireTool,
  newAuthNonce,
  newDaemonInstanceId,
} from '../../mcp-server/src/protocol/index.js';

/** The exact key list of a frame, in the order the builder writes it. */
const GOLDEN_KEYS = {
  ipcHello: ['kind', 'token', 'protocolVersion', 'capabilities'],
  ipcHelloWithAgent: ['kind', 'token', 'agentName', 'protocolVersion', 'capabilities'],
  ipcWelcome: ['kind', 'sessionId', 'ok', 'protocolVersion', 'capabilities'],
  extensionHello: ['type', 'protocolVersion', 'appVersion', 'capabilities'],
  extensionHelloWithInstance: ['type', 'protocolVersion', 'appVersion', 'capabilities', 'instanceId'],
  extensionHelloWithAuth: ['type', 'protocolVersion', 'appVersion', 'capabilities', 'instanceId', 'clientNonce', 'serverNonce', 'authProof'],
  extensionHelloWithAuthWithoutInstance: ['type', 'protocolVersion', 'appVersion', 'capabilities', 'clientNonce', 'serverNonce'],
  extensionHelloAck: ['type', 'protocolVersion', 'capabilities'],
  extensionHelloAckWithAppVersion: ['type', 'protocolVersion', 'appVersion', 'capabilities'],
  extensionHelloAckWithBrowser: ['type', 'protocolVersion', 'appVersion', 'capabilities', 'clientNonce', 'instanceId', 'browserId', 'browserLabel', 'authProof'],
  extensionHelloAckWithoutBrowser: ['type', 'protocolVersion', 'appVersion', 'capabilities', 'clientNonce', 'instanceId', 'authProof'],
} as const;

/**
 * Compare a frame against its golden key list.
 *
 * Returns the difference instead of throwing, so the negative control below
 * can prove that the comparison actually bites: a golden list with one field
 * renamed has to be reported, not silently accepted.
 */
function frameKeyDifference(frame: Record<string, unknown>, goldenKeys: readonly string[]): string[] {
  const actual = Object.keys(frame);
  const missing = goldenKeys.filter((key) => !actual.includes(key));
  const unexpected = actual.filter((key) => !goldenKeys.includes(key));
  const order = actual.length === goldenKeys.length && actual.every((key, index) => key === goldenKeys[index]) ? [] : ['<key order>'];
  return [...missing.map((key) => `missing ${key}`), ...unexpected.map((key) => `unexpected ${key}`), ...order];
}

describe('the wire contract: frames the protocol package builds', () => {
  it('builds the IPC hello with exactly these keys, in this order', () => {
    expect(Object.keys(buildIpcHello('token-value'))).toEqual([...GOLDEN_KEYS.ipcHello]);
    expect(Object.keys(buildIpcHello('token-value', 'agent-name'))).toEqual([...GOLDEN_KEYS.ipcHelloWithAgent]);
  });

  it('carries the token, the version and the capabilities in the hello', () => {
    const hello = buildIpcHello('token-value');
    expect(hello.kind).toBe('hello');
    expect(hello.token).toBe('token-value');
    expect(hello.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(hello.capabilities).toEqual([...IPC_PROTOCOL_CAPABILITIES]);
  });

  it('omits the agent name when there is none', () => {
    expect('agentName' in buildIpcHello('token-value')).toBe(false);
    expect(buildIpcHello('token-value', 'agent-name').agentName).toBe('agent-name');
  });

  it('builds the IPC welcome with exactly these keys, in this order', () => {
    expect(Object.keys(buildIpcWelcome('s-abc123-1'))).toEqual([...GOLDEN_KEYS.ipcWelcome]);
  });

  it('announces the memory-admin capability only when the daemon can serve it', () => {
    const plain = buildIpcWelcome('s-abc123-1');
    const admin = buildIpcWelcome('s-abc123-1', { memoryAdmin: true });
    expect(plain.capabilities).toEqual([...IPC_PROTOCOL_CAPABILITIES]);
    expect(plain.capabilities).not.toContain(MEMORY_ADMIN_CAPABILITY);
    expect(admin.capabilities).toEqual([...IPC_PROTOCOL_CAPABILITIES, MEMORY_ADMIN_CAPABILITY]);
    // The key set does not change when the capability list does.
    expect(Object.keys(admin)).toEqual([...GOLDEN_KEYS.ipcWelcome]);
  });

  it('builds the extension hello with exactly these keys, in this order', () => {
    expect(Object.keys(buildExtensionHello('3.1.1'))).toEqual([...GOLDEN_KEYS.extensionHello]);
    expect(Object.keys(buildExtensionHello('3.1.1', 'abcd1234'))).toEqual([...GOLDEN_KEYS.extensionHelloWithInstance]);
  });

  it('adds the auth proof only when the daemon has both the auth and the instance id', () => {
    const auth = { clientNonce: newAuthNonce(), serverNonce: newAuthNonce(), enrollmentSecret: 'enrollment-secret' };
    const withBoth = buildExtensionHello('3.1.1', 'abcd1234', auth);
    const withoutInstance = buildExtensionHello('3.1.1', undefined, auth);
    expect(Object.keys(withBoth)).toEqual([...GOLDEN_KEYS.extensionHelloWithAuth]);
    expect(Object.keys(withoutInstance)).toEqual([...GOLDEN_KEYS.extensionHelloWithAuthWithoutInstance]);
    // The nonces travel even when the proof cannot be made: the extension
    // needs them to answer, and it is the missing instance id that blocks the
    // proof, not the missing nonce.
    expect('clientNonce' in withoutInstance).toBe(true);
    expect('authProof' in withoutInstance).toBe(false);
  });

  it('builds the extension hello ack with exactly these keys, in this order', () => {
    const auth = { token: 'token', clientNonce: newAuthNonce(), serverNonce: newAuthNonce(), instanceId: 'abcd1234' };
    const withBrowser = { ...auth, browserId: 'browser-1', browserLabel: 'Chrome' };
    expect(Object.keys(buildExtensionHelloAck())).toEqual([...GOLDEN_KEYS.extensionHelloAck]);
    expect(Object.keys(buildExtensionHelloAck('3.1.1'))).toEqual([...GOLDEN_KEYS.extensionHelloAckWithAppVersion]);
    expect(Object.keys(buildExtensionHelloAck('3.1.1', auth))).toEqual([...GOLDEN_KEYS.extensionHelloAckWithoutBrowser]);
    expect(Object.keys(buildExtensionHelloAck('3.1.1', withBrowser))).toEqual([...GOLDEN_KEYS.extensionHelloAckWithBrowser]);
  });
});

describe('the wire contract: versions and capabilities', () => {
  it('pins the protocol versions', () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(EXTENSION_PROTOCOL_VERSION).toBe(2);
  });

  it('pins the IPC capability list, contents and order', () => {
    expect([...IPC_PROTOCOL_CAPABILITIES]).toEqual([
      'heartbeat',
      'tool-routing',
      'session-locks',
      'cancellation',
      'result-envelope',
      'tools-v3',
    ]);
  });

  it('pins the extension capability list, contents and order', () => {
    expect([...EXTENSION_PROTOCOL_CAPABILITIES]).toEqual([
      'tool-dispatch',
      'ping-pong',
      'cancellation',
      'tab-locks',
      'tools-v3',
      'credential-vault-v1',
      'site-context',
      'site-map',
      'vault-site-approval',
    ]);
  });
});

describe('the wire contract: identifiers', () => {
  it('builds a session id as s-<instance>-<n>', () => {
    expect(buildSessionId('abc123', 7)).toBe('s-abc123-7');
    expect(buildSessionId('abc123', 0)).toBe('s-abc123-0');
  });

  it('builds an instance id of eight base36 characters', () => {
    const instanceId = newDaemonInstanceId();
    expect(instanceId).toMatch(/^[0-9a-z]{8}$/u);
  });
});

describe('the wire contract: the names a wire tool may have', () => {
  it('accepts every registered tool', () => {
    for (const tool of TOOL_NAMES) expect(isKnownWireTool(tool), tool).toBe(true);
    expect(TOOL_NAMES.length).toBe(22);
  });

  it('accepts the internal wire action the daemon forwards', () => {
    expect(isKnownWireTool('browser_classify_action')).toBe(true);
  });

  it('refuses the daemon-only name, so no client can ask for it', () => {
    expect(isKnownWireTool('browser_memory_internal_context')).toBe(false);
  });

  it('refuses anything that is not a tool name', () => {
    expect(isKnownWireTool('browser_not_a_tool')).toBe(false);
    expect(isKnownWireTool(42)).toBe(false);
    expect(isKnownWireTool(null)).toBe(false);
    expect(isKnownWireTool(undefined)).toBe(false);
    expect(isKnownWireTool('constructor')).toBe(false);
    expect(isKnownWireTool('__proto__')).toBe(false);
  });

  it('passes the private vault names through to the vault router', () => {
    // These are refused by the vault router with a coded denial, not by the
    // wire: the wire must not be the place that answers a vault question.
    expect(isKnownWireTool('browser_vault_internal_inspect')).toBe(true);
    expect(isKnownWireTool('browser_vault_internal_anything')).toBe(true);
  });
});

describe('the wire contract: the comparison itself bites', () => {
  it('reports a renamed field instead of accepting it', () => {
    const frame = buildIpcHello('token-value');
    const brokenGolden = GOLDEN_KEYS.ipcHello.map((key) => (key === 'token' ? 'tokne' : key));
    expect(frameKeyDifference(frame, brokenGolden)).toContain('missing tokne');
    expect(frameKeyDifference(frame, brokenGolden)).toContain('unexpected token');
  });

  it('reports a reordered frame, because the order is part of the contract', () => {
    const frame = buildIpcHello('token-value');
    const reordered = [...GOLDEN_KEYS.ipcHello].reverse();
    expect(frameKeyDifference(frame, reordered)).toContain('<key order>');
  });

  it('reports nothing for the real golden lists', () => {
    expect(frameKeyDifference(buildIpcHello('token-value'), GOLDEN_KEYS.ipcHello)).toEqual([]);
    expect(frameKeyDifference(buildIpcWelcome('s-abc123-1'), GOLDEN_KEYS.ipcWelcome)).toEqual([]);
    expect(frameKeyDifference(buildExtensionHello('3.1.1'), GOLDEN_KEYS.extensionHello)).toEqual([]);
  });
});
