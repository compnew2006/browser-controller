/** Keep in sync with mcp-server/src/protocol.ts (guarded by protocol tests). */
export const PROTOCOL_VERSION = 1;

export const EXTENSION_PROTOCOL_CAPABILITIES = Object.freeze([
  'tool-dispatch',
  'ping-pong',
  'cancellation',
  'observe-act-v2',
  'tab-locks',
]);

const REQUIRED_DAEMON_CAPABILITIES = Object.freeze(['tool-dispatch', 'ping-pong']);

export function validateDaemonHello(message) {
  if (!message || message.type !== 'hello') {
    return { ok: false, legacy: false, reason: 'Invalid daemon protocol hello.' };
  }
  if (message.protocolVersion === undefined || message.protocolVersion === null) {
    return { ok: true, legacy: true };
  }
  if (message.protocolVersion !== PROTOCOL_VERSION) {
    return {
      ok: false,
      legacy: false,
      reason: `Unsupported protocol version ${String(message.protocolVersion)}; expected ${PROTOCOL_VERSION}. Restart the daemon and reload the extension.`,
    };
  }
  if (!Array.isArray(message.capabilities)) {
    return { ok: false, legacy: false, reason: 'Invalid daemon protocol capabilities.' };
  }
  const missing = REQUIRED_DAEMON_CAPABILITIES.filter((capability) => !message.capabilities.includes(capability));
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
