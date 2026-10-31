import { randomInt } from 'node:crypto';
import {
  createWebSocketDaemonProof,
  createWebSocketClientProof,
} from './auth.js';
import {
  EXTENSION_PROTOCOL_CAPABILITIES,
  EXTENSION_PROTOCOL_VERSION,
  IPC_PROTOCOL_CAPABILITIES,
  MEMORY_ADMIN_CAPABILITY,
  PROTOCOL_VERSION,
} from './capabilities.js';

/**
 * The frames of the wire: the exact objects the daemon, the thin client and
 * the extension exchange. Every field name, every field order and every
 * value here is part of the contract — a change breaks a peer, so the frames
 * are built in one place and never assembled by hand elsewhere.
 */

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

export function buildIpcHello(token: string, agentName?: string) {
  return {
    kind: 'hello' as const,
    token,
    ...(agentName ? { agentName } : {}),
    protocolVersion: PROTOCOL_VERSION,
    capabilities: IPC_PROTOCOL_CAPABILITIES,
  };
}

/** `memoryAdmin: true` only when the daemon can really serve `memory-admin` messages. */
export function buildIpcWelcome(sessionId: string, options: { memoryAdmin?: boolean } = {}) {
  return {
    kind: 'welcome' as const,
    sessionId,
    ok: true as const,
    protocolVersion: PROTOCOL_VERSION,
    capabilities: options.memoryAdmin ? [...IPC_PROTOCOL_CAPABILITIES, MEMORY_ADMIN_CAPABILITY] : IPC_PROTOCOL_CAPABILITIES,
  };
}

export function buildExtensionHello(
  appVersion: string,
  instanceId?: string,
  auth?: { clientNonce: string; serverNonce: string; enrollmentSecret: string },
) {
  const hello = {
    type: 'hello' as const,
    protocolVersion: EXTENSION_PROTOCOL_VERSION,
    appVersion,
    capabilities: EXTENSION_PROTOCOL_CAPABILITIES,
    // Optional: a daemon from before instance ids sends none.
    ...(instanceId ? { instanceId } : {}),
    ...(auth ? { clientNonce: auth.clientNonce, serverNonce: auth.serverNonce } : {}),
  };
  return auth && instanceId
    ? { ...hello, authProof: createWebSocketDaemonProof(auth.enrollmentSecret, {
      protocolVersion: EXTENSION_PROTOCOL_VERSION,
      clientNonce: auth.clientNonce,
      serverNonce: auth.serverNonce,
      instanceId,
      capabilities: EXTENSION_PROTOCOL_CAPABILITIES,
    }) }
    : hello;
}

export function buildExtensionHelloAck(
  appVersion?: string,
  auth?: { token: string; clientNonce: string; serverNonce: string; instanceId: string; browserId?: string; browserLabel?: string },
) {
  const acknowledgement = {
    type: 'helloAck' as const,
    protocolVersion: EXTENSION_PROTOCOL_VERSION,
    ...(appVersion ? { appVersion } : {}),
    capabilities: EXTENSION_PROTOCOL_CAPABILITIES,
    ...(auth ? {
      clientNonce: auth.clientNonce,
      instanceId: auth.instanceId,
      ...(auth.browserId ? { browserId: auth.browserId } : {}),
      ...(auth.browserLabel ? { browserLabel: auth.browserLabel } : {}),
    } : {}),
  };
  return auth
    ? { ...acknowledgement, authProof: createWebSocketClientProof(auth.token, {
      protocolVersion: EXTENSION_PROTOCOL_VERSION,
      clientNonce: auth.clientNonce,
      serverNonce: auth.serverNonce,
      instanceId: auth.instanceId,
      browserId: auth.browserId,
      browserLabel: auth.browserLabel,
      capabilities: EXTENSION_PROTOCOL_CAPABILITIES,
    }) }
    : acknowledgement;
}
