import { isRecord } from './core/guards.js';
import type { IpcClientMessage } from './daemon-config.js';

/** Validate the shapes the daemon reads directly; memory-admin validates its own payload. */
export function isIpcClientMessage(value: unknown): value is IpcClientMessage {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'hello') {
    return typeof value.token === 'string' && (value.agentName === undefined || typeof value.agentName === 'string');
  }
  if (value.kind === 'call') {
    return typeof value.id === 'string' && value.id.length > 0
      && typeof value.tool === 'string' && value.tool.length > 0 && isRecord(value.params);
  }
  return value.kind === 'pong' || value.kind === 'memory-admin';
}
