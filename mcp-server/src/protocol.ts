import { randomInt } from 'node:crypto';

/** Wire-protocol contract shared by the thin client, daemon, and extension. */
export const PROTOCOL_VERSION = 1;

/** Random id: 8 base36 characters. */
export function newDaemonInstanceId(): string {
  let id = '';
  for (let i = 0; i < 8; i++) id += randomInt(36).toString(36);
  return id;
}

/**
 * The id of this daemon process. The extension gets it in the hello and drops
 * the locks of any previous instance; it is also the prefix of every session id
 * this process hands out, so session ids never repeat across daemon restarts.
 */
export const DAEMON_INSTANCE_ID = newDaemonInstanceId();

/** `s-<instance>-<n>`: unique across daemon restarts, readable in logs and UI. */
export function buildSessionId(instanceId: string, seq: number): string {
  return `s-${instanceId}-${seq}`;
}

/** The 3.0 tool contract. A peer without it is a 2.x build. */
export const TOOLS_V3_CAPABILITY = 'tools-v3';

/**
 * IPC (thin client <-> daemon). The socket had no version before 3.0 and both sides
 * advertise the same five capabilities then, so tools-v3 is what marks a 3.0 peer.
 */
export const IPC_PROTOCOL_CAPABILITIES = Object.freeze([
  'heartbeat',
  'tool-routing',
  'session-locks',
  'cancellation',
  'result-envelope',
  TOOLS_V3_CAPABILITY,
]);

export const EXTENSION_PROTOCOL_CAPABILITIES = Object.freeze([
  'tool-dispatch',
  'ping-pong',
  'cancellation',
  'tab-locks',
  'tools-v3',
]);

/** What the daemon needs from the extension's helloAck. */
export const REQUIRED_EXTENSION_CAPABILITIES = Object.freeze(['tool-dispatch', 'ping-pong', TOOLS_V3_CAPABILITY]);

export const OLDER_EXTENSION_REASON =
  'The Browser Controller extension is older than 3.0: reload it at chrome://extensions.';

export interface ProtocolCheck {
  ok: boolean;
  legacy: boolean;
  reason?: string;
}

export function validateProtocolVersion(version: unknown): ProtocolCheck {
  if (version === undefined || version === null) return { ok: false, legacy: false, reason: 'Missing protocol version.' };
  if (version === PROTOCOL_VERSION) return { ok: true, legacy: false };
  return {
    ok: false,
    legacy: false,
    reason: `Unsupported protocol version ${String(version)}; expected ${PROTOCOL_VERSION}. Restart the daemon and reload the extension.`,
  };
}

export function validateCapabilities(
  capabilities: unknown,
  required: readonly string[],
): ProtocolCheck {
  if (!Array.isArray(capabilities) || capabilities.some((item) => typeof item !== 'string')) {
    return { ok: false, legacy: false, reason: 'Invalid protocol capabilities payload.' };
  }
  const missing = required.filter((capability) => !capabilities.includes(capability));
  if (missing.length) {
    return {
      ok: false,
      legacy: false,
      reason: `Missing required protocol capabilities: ${missing.join(', ')}.`,
    };
  }
  return { ok: true, legacy: false };
}

/**
 * The extension's helloAck must carry the 3.0 contract. A peer that lacks
 * tools-v3, or sends no capabilities at all, is a pre-3.0 build: it gets the
 * reason that tells the user what to do, never a legacy acceptance.
 */
export function validateExtensionCapabilities(capabilities: unknown): ProtocolCheck {
  if (capabilities === undefined || capabilities === null) return { ok: false, legacy: false, reason: OLDER_EXTENSION_REASON };
  const check = validateCapabilities(capabilities, REQUIRED_EXTENSION_CAPABILITIES);
  if (check.ok || (Array.isArray(capabilities) && capabilities.includes(TOOLS_V3_CAPABILITY))) return check;
  return { ok: false, legacy: false, reason: OLDER_EXTENSION_REASON };
}

/**
 * Gate for the extension's helloAck, run before any tool call is routed to it.
 * An explicit protocolVersion and the 3.0 capabilities are both required: a
 * helloAck that omits them is refused, not accepted as a legacy peer.
 */
export function validateExtensionHelloAck(message: { protocolVersion?: unknown; capabilities?: unknown }): ProtocolCheck {
  if (message.protocolVersion === undefined || message.protocolVersion === null) {
    return { ok: false, legacy: false, reason: OLDER_EXTENSION_REASON };
  }
  const version = validateProtocolVersion(message.protocolVersion);
  if (!version.ok) return version;
  return validateExtensionCapabilities(message.capabilities);
}

/** Thin client's reason when the daemon it reached is from before 3.0. */
export const OLDER_DAEMON_IPC_REASON =
  'The running Browser Controller daemon is older than 3.0: stop it (npm run daemon:stop, or end the pid in its daemon.lock), then restart your MCP client so the 3.0 daemon starts.';

/** Daemon's reason when the MCP client that connected is from before 3.0. */
export const OLDER_CLIENT_IPC_REASON =
  'This MCP client is older than 3.0: restart your MCP client so it starts the 3.0 client.';

/**
 * IPC handshake gate, run on both sides: the thin client checks the daemon's welcome,
 * the daemon checks the client's hello. A peer with no explicit protocolVersion, or
 * without tools-v3, is from before 3.0 and gets `olderReason`; it is never accepted
 * as a legacy peer. Otherwise the rest of the IPC contract is checked as before.
 */
export function validateIpcHandshake(message: { protocolVersion?: unknown; capabilities?: unknown }, olderReason: string): ProtocolCheck {
  if (message.protocolVersion === undefined || message.protocolVersion === null) {
    return { ok: false, legacy: false, reason: olderReason };
  }
  const version = validateProtocolVersion(message.protocolVersion);
  if (!version.ok) return version;
  const capabilities = message.capabilities;
  if (!Array.isArray(capabilities) || !capabilities.includes(TOOLS_V3_CAPABILITY)) {
    return { ok: false, legacy: false, reason: olderReason };
  }
  return validateCapabilities(capabilities, IPC_PROTOCOL_CAPABILITIES);
}

export function buildIpcHello(token: string, agentName?: string) {
  return {
    kind: 'hello' as const,
    token,
    ...(agentName ? { agentName } : {}),
    protocolVersion: PROTOCOL_VERSION,
    capabilities: IPC_PROTOCOL_CAPABILITIES,
  };
}

export function buildIpcWelcome(sessionId: string) {
  return {
    kind: 'welcome' as const,
    sessionId,
    ok: true as const,
    protocolVersion: PROTOCOL_VERSION,
    capabilities: IPC_PROTOCOL_CAPABILITIES,
  };
}

export function buildExtensionHello(appVersion: string, instanceId?: string) {
  return {
    type: 'hello' as const,
    protocolVersion: PROTOCOL_VERSION,
    appVersion,
    capabilities: EXTENSION_PROTOCOL_CAPABILITIES,
    // Optional: a daemon from before instance ids sends none.
    ...(instanceId ? { instanceId } : {}),
  };
}

export function buildExtensionHelloAck(appVersion?: string) {
  return {
    type: 'helloAck' as const,
    protocolVersion: PROTOCOL_VERSION,
    ...(appVersion ? { appVersion } : {}),
    capabilities: EXTENSION_PROTOCOL_CAPABILITIES,
  };
}
