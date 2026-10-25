// Reconnect and capability-negotiation limits shared by the connection owner.
export const DEFAULT_WS_PORT = 7225;
export const RECONNECT_BASE_MS = 1000;
export const RECONNECT_MAX_MS = 30000;
// Surface a hard error only after repeated retries indicate an actual outage.
export const RECONNECT_GIVEUP_ATTEMPTS = 10;
export const KEEPALIVE_ALARM = 'keepalive';
export const KEEPALIVE_INTERVAL_MIN = 0.4;
// Bound handshake and port probes so background startup stays responsive.
export const HANDSHAKE_TIMEOUT_MS = 3_000;
export const PROBE_TIMEOUT_MS = 2_000;
