/** Keep in sync with EXTENSION_PROTOCOL_VERSION in mcp-server/src/protocol.ts. */
export const PROTOCOL_VERSION = 2;

export const EXTENSION_PROTOCOL_CAPABILITIES = Object.freeze([
  'tool-dispatch',
  'ping-pong',
  'cancellation',
  'tab-locks',
  'tools-v3',
  'credential-vault-v1',
]);

/** The 3.0 tool contract. A daemon without it is a 2.x build. */
const TOOLS_V3_CAPABILITY = 'tools-v3';
export const REQUIRED_DAEMON_CAPABILITIES = Object.freeze(['tool-dispatch', 'ping-pong', TOOLS_V3_CAPABILITY]);

export const OLDER_DAEMON_REASON =
  'The Browser Controller daemon is older than 3.0: restart your MCP client so it starts the 3.0 daemon.';

/**
 * The daemon's hello must carry an explicit protocol version and the 3.0 tool
 * contract. A hello without them comes from a pre-3.0 daemon: refused, never
 * accepted as a legacy peer (tool calls would reach an older tool contract).
 */
export function validateDaemonHello(message) {
  if (!message || message.type !== 'hello') {
    return { ok: false, legacy: false, reason: 'Invalid daemon protocol hello.' };
  }
  if (message.protocolVersion === undefined || message.protocolVersion === null) {
    return { ok: false, legacy: false, reason: OLDER_DAEMON_REASON };
  }
  if (message.protocolVersion !== PROTOCOL_VERSION) {
    // The port owner is not authenticated yet and the popup shows this reason: name a number, never its text.
    const received = Number.isSafeInteger(message.protocolVersion) ? ` ${String(message.protocolVersion)}` : '';
    return {
      ok: false,
      legacy: false,
      reason: `Unsupported protocol version${received}; expected ${PROTOCOL_VERSION}. Restart the daemon and reload the extension.`,
    };
  }
  if (!Array.isArray(message.capabilities)) {
    return { ok: false, legacy: false, reason: OLDER_DAEMON_REASON };
  }
  if (typeof message.instanceId !== 'string' || !message.instanceId ||
      typeof message.clientNonce !== 'string' || !message.clientNonce ||
      typeof message.authProof !== 'string' || !message.authProof) {
    return { ok: false, legacy: false, reason: 'Daemon authentication failed. Reload the extension and restart the daemon.' };
  }
  const missing = REQUIRED_DAEMON_CAPABILITIES.filter((capability) => !message.capabilities.includes(capability));
  if (missing.length && missing.includes(TOOLS_V3_CAPABILITY)) {
    return { ok: false, legacy: false, reason: OLDER_DAEMON_REASON };
  }
  if (missing.length) {
    return {
      ok: false,
      legacy: false,
      reason: `Missing required daemon capabilities: ${missing.join(', ')}.`,
    };
  }
  return { ok: true, legacy: false };
}

export function buildExtensionHelloAck(appVersion, identity = {}) {
  return {
    type: 'helloAck',
    protocolVersion: PROTOCOL_VERSION,
    ...(appVersion ? { appVersion } : {}),
    capabilities: EXTENSION_PROTOCOL_CAPABILITIES,
    // Multi-browser: a stable id per browser profile (+ a human label) so the
    // daemon can keep several browsers connected and route sessions to one.
    ...(identity.browserId ? { browserId: identity.browserId } : {}),
    ...(identity.browserLabel ? { browserLabel: identity.browserLabel } : {}),
  };
}
