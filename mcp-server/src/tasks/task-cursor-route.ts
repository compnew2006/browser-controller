import { isRecord } from '../core/guards.js';
import { ERROR_CODES, formatError } from '../core/error-codes.js';
import { isTaskId } from './task-id.js';

/** The daemon's control channel, structurally — this module never imports the bridge itself. */
export interface TaskCursorBridge {
  sendControl(type: string, payload?: Record<string, unknown>): void;
}

/**
 * Validate and forward a task-cursor lifecycle signal, scoped to the
 * requesting client. No task-list push: toggling the cursor changes no
 * task record, unlike the lock release.
 */
export function routeTaskCursor(
  bridge: TaskCursorBridge,
  sessionId: string,
  params: unknown,
): { success: true; result: { enabled: boolean } } | { success: false; error: string } {
  const taskId = isRecord(params) ? params.taskId : undefined;
  const enabled = isRecord(params) ? params.enabled : undefined;
  if (!isTaskId(taskId)) {
    return { success: false, error: formatError(ERROR_CODES.INVALID_ARGUMENT, 'task cursor signal requires a valid taskId') };
  }
  if (typeof enabled !== 'boolean') {
    return { success: false, error: formatError(ERROR_CODES.INVALID_ARGUMENT, 'task cursor signal requires enabled to be a boolean') };
  }
  bridge.sendControl('taskCursor', { sessionId, taskId, enabled });
  return { success: true, result: { enabled } };
}
