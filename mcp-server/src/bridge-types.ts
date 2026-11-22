/**
 * Types the bridge shares with its split-out modules: the pending tool-call
 * record and the bridge's construction options. They lived in `bridge.ts`
 * until that file hit the 600-line maintenance gate; moving them here frees
 * the room the `taskAnswer` receiver needs, without touching behaviour.
 */
import type { ExtensionConnection } from './bridge-connections.js';

export interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  tool: string;
  retries: number;
  params: Record<string, unknown>;
  /** Abort listener registered for this request (audit C2); removed on settle. */
  onAbort?: (() => void) | null;
  signal?: AbortSignal | null;
  /** The extension connection (browser) this call was sent to. */
  conn?: ExtensionConnection;
}

export interface BridgeOptions {
  port: number;
  host?: string;
  /** Auth token used to verify the extension proof after daemon identity is established. */
  token: string;
  /**
   * Enrollment secret used to prove daemon identity and authenticate HTTP
   * challenges without sending the secret to the extension or port owner.
   */
  enrollmentSecret: string;
  maxRetries?: number;
  pingIntervalMs?: number;
  defaultTimeoutMs?: number;
  maxWsPayloadBytes?: number;
  /** How long a peer may take to answer our hello with its helloAck before it is refused. */
  handshakeGraceMs?: number;
  /** How long callTool waits for an extension to connect before failing with NOT_CONNECTED. */
  connectionWaitMs?: number;
  /** Within `windowMs` (60 s) of the start or of an extension drop one is likely reconnecting: wait `ms` instead. */
  reconnectWait?: { ms: number; windowMs?: number };
}
