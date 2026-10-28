import { randomInt } from 'node:crypto';
import {
  createWebSocketDaemonProof,
  createWebSocketClientProof,
  WS_AUTH_PROTOCOL_VERSION,
} from './bridge-auth.js';

/** Wire-protocol contract shared by the thin client, daemon, and extension. */
export const PROTOCOL_VERSION = 1;
/** Version for extension WebSocket authentication; IPC remains at PROTOCOL_VERSION. */
export const EXTENSION_PROTOCOL_VERSION = WS_AUTH_PROTOCOL_VERSION;

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
export const CREDENTIAL_VAULT_CAPABILITY = 'credential-vault-v1';
/** Extension reports a `siteContext` block when a request carries `observe` (website memory). */
export const SITE_CONTEXT_CAPABILITY = 'site-context';
/** Extension reports the light `siteContext` for an observed `browser_click` (specs/004-site-navigation-map R-06). */
export const SITE_MAP_CAPABILITY = 'site-map';
/** Extension draws in-page vault approval cards and fills the username field too (specs/006-vault-site-approval). */
export const VAULT_SITE_APPROVAL_CAPABILITY = 'vault-site-approval';
/**
 * The daemon accepts `memory-admin` IPC messages from the owner CLI. Daemon-only: it is
 * not in IPC_PROTOCOL_CAPABILITIES, which both sides must send, so older clients still connect.
 */
export const MEMORY_ADMIN_CAPABILITY = 'memory-admin';

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
  CREDENTIAL_VAULT_CAPABILITY,
  // Additive: not in REQUIRED_EXTENSION_CAPABILITIES, so an extension without it still connects
  // and website memory fails closed for it (MEMORY_SCOPE_UNKNOWN).
  SITE_CONTEXT_CAPABILITY,
  // Additive too: without it clicks are not observed, and the site map learns from reads only.
  SITE_MAP_CAPABILITY,
  // Additive: without it, vault approvals open the private page and fills write the password only.
  VAULT_SITE_APPROVAL_CAPABILITY,
]);

/** What the daemon needs from the extension's helloAck. */
export const REQUIRED_EXTENSION_CAPABILITIES = Object.freeze(['tool-dispatch', 'ping-pong', TOOLS_V3_CAPABILITY]);

export const OLDER_EXTENSION_REASON =
  'The Browser Controller extension is older than 3.0: reload it at chrome://extensions.';

/**
 * A peer that never answered the hello: a pre-3.0 extension, a service worker recycled
 * mid-handshake or any silent local socket. The daemon cannot tell which, so it says so.
 */
export const HANDSHAKE_TIMEOUT_REASON =
  'A browser connection did not finish the handshake in time. If the extension is older than 3.0, reload it at chrome://extensions.';

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
  if (message.protocolVersion !== EXTENSION_PROTOCOL_VERSION) {
    // The peer is not authenticated yet and agents read this reason: name a number, never its text.
    const received = Number.isSafeInteger(message.protocolVersion) ? ` ${String(message.protocolVersion)}` : '';
    return {
      ok: false,
      legacy: false,
      reason: `Unsupported extension protocol version${received}; expected ${EXTENSION_PROTOCOL_VERSION}. Reload the extension and restart the daemon.`,
    };
  }
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
