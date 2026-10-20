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

export const IPC_PROTOCOL_CAPABILITIES = Object.freeze([
  'heartbeat',
  'tool-routing',
  'session-locks',
  'cancellation',
  'result-envelope',
]);

export const EXTENSION_PROTOCOL_CAPABILITIES = Object.freeze([
  'tool-dispatch',
  'ping-pong',
  'cancellation',
  'observe-act-v2',
  'tab-locks',
  'webmcp',
]);

export interface ProtocolCheck {
  ok: boolean;
  legacy: boolean;
  reason?: string;
}

export function validateProtocolVersion(version: unknown): ProtocolCheck {
  if (version === undefined || version === null) return { ok: true, legacy: true };
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
  if (capabilities === undefined || capabilities === null) return { ok: true, legacy: true };
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
