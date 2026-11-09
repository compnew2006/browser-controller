import { isRecord } from './core/guards.js';
import type { IpcClientMessage } from './daemon-config.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTION_TOOLS = new Set([
  'browser_click', 'browser_type', 'browser_fill', 'browser_navigate', 'browser_snapshot',
  'browser_scroll', 'browser_handle_dialog', 'browser_evaluate',
]);

function validActivityContext(value: unknown, tool: string, params: Record<string, unknown>): boolean {
  if (!isRecord(value)) return false;
  if (value.kind === 'batch-finished') {
    return tool === 'browser_batch' && Object.keys(params).length === 0
      && Object.keys(value).every((key) => ['kind', 'schemaVersion', 'batchRunId', 'endedAt', 'executionStatus'].includes(key))
      && value.schemaVersion === 1 && typeof value.batchRunId === 'string' && UUID_RE.test(value.batchRunId)
      && typeof value.endedAt === 'string' && value.endedAt.length <= 40
      && Number.isFinite(Date.parse(value.endedAt))
      && typeof value.executionStatus === 'string'
      && ['completed', 'failed', 'aborted', 'unknown'].includes(value.executionStatus);
  }
  const keys = Object.keys(value);
  return ACTION_TOOLS.has(tool)
    && keys.every((key) => ['eventId', 'batchRunId', 'batchStepIndex'].includes(key))
    && typeof value.eventId === 'string' && UUID_RE.test(value.eventId)
    && ((value.batchRunId === undefined && value.batchStepIndex === undefined)
      || (typeof value.batchRunId === 'string' && UUID_RE.test(value.batchRunId)
        && typeof value.batchStepIndex === 'number' && Number.isInteger(value.batchStepIndex)
        && value.batchStepIndex >= 1 && value.batchStepIndex <= 50));
}

/** Validate the shapes the daemon reads directly; memory-admin validates its own payload. */
export function isIpcClientMessage(value: unknown): value is IpcClientMessage {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'hello') {
    return typeof value.token === 'string' && (value.agentName === undefined || typeof value.agentName === 'string');
  }
  if (value.kind === 'call') {
    if (typeof value.id !== 'string' || value.id.length === 0
      || typeof value.tool !== 'string' || value.tool.length === 0 || !isRecord(value.params)) return false;
    return value.activityContext === undefined || validActivityContext(value.activityContext, value.tool, value.params);
  }
  return value.kind === 'pong' || value.kind === 'memory-admin';
}
