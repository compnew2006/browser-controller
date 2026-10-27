import { newAuthNonce } from '../../mcp-server/src/bridge-auth.js';
import { createWebSocketClientProof } from '../../mcp-server/src/bridge-auth.js';
import { EXTENSION_PROTOCOL_CAPABILITIES, EXTENSION_PROTOCOL_VERSION } from '../../mcp-server/src/protocol.js';

export const TEST_BRIDGE_TOKEN = 'synthetic-bridge-token-for-tests';
export const TEST_ENROLLMENT_SECRET = 'synthetic-enrollment-secret-for-tests';

export function testBridgeCredentials() {
  return { token: TEST_BRIDGE_TOKEN, enrollmentSecret: TEST_ENROLLMENT_SECRET };
}

export function sendAuthInit(socket: { send(data: string): void }): string {
  const clientNonce = newAuthNonce();
  socket.send(JSON.stringify({ type: 'authInit', clientNonce }));
  return clientNonce;
}

export function authenticatedHelloAck(hello: Record<string, any>, identity: {
  browserId?: string;
  browserLabel?: string;
  capabilities?: string[];
} = {}): string {
  const capabilities = identity.capabilities ?? [...EXTENSION_PROTOCOL_CAPABILITIES];
  const ack = {
    type: 'helloAck',
    protocolVersion: EXTENSION_PROTOCOL_VERSION,
    appVersion: 'test',
    capabilities,
    clientNonce: hello.clientNonce,
    instanceId: hello.instanceId,
    ...(identity.browserId ? { browserId: identity.browserId } : {}),
    ...(identity.browserLabel ? { browserLabel: identity.browserLabel } : {}),
  };
  return JSON.stringify({
    ...ack,
    authProof: createWebSocketClientProof(TEST_BRIDGE_TOKEN, {
      protocolVersion: ack.protocolVersion,
      clientNonce: ack.clientNonce,
      serverNonce: hello.serverNonce,
      instanceId: ack.instanceId,
      browserId: ack.browserId,
      browserLabel: ack.browserLabel,
      capabilities: ack.capabilities,
    }),
  });
}
