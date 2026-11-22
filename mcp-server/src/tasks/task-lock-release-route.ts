import { isRecord } from '../core/guards.js';
import { ERROR_CODES, formatError } from '../core/error-codes.js';
import { isTaskId } from './task-id.js';

/** The daemon's control channel, structurally — this module never imports the bridge itself. */
export interface TaskLockReleaseBridge {
  sendControl(type: string, payload?: Record<string, unknown>): void;
}

/** Validate and forward an IPC task-lock release, scoped to the requesting client. */
export function routeTaskLockRelease(
  bridge: TaskLockReleaseBridge,
  sessionId: string,
  params: unknown,
): { success: true; result: { released: true } } | { success: false; error: string } {
  const taskId = isRecord(params) ? params.taskId : undefined;
  if (!isTaskId(taskId)) {
    return { success: false, error: formatError(ERROR_CODES.INVALID_ARGUMENT, 'task lock release requires a valid taskId') };
  }
  bridge.sendControl('taskLockRelease', { sessionId, taskId });
  return { success: true, result: { released: true } };
}
