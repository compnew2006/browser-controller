import { isRecord } from '../core/guards.js';
import { ERROR_CODES, formatError } from '../core/error-codes.js';
import { isTaskId } from './task-id.js';
import { pushTaskStatus } from './task-status.js';

/** The daemon's control channel, structurally — this module never imports the bridge itself. */
export interface TaskLockReleaseBridge {
  sendControl(type: string, payload?: Record<string, unknown>): void;
}

/** Validate and forward an IPC task-lock release, scoped to the requesting client. */
export function routeTaskLockRelease(
  bridge: TaskLockReleaseBridge,
  sessionId: string,
  params: unknown,
  tasksDir?: string,
): { success: true; result: { released: true } } | { success: false; error: string } {
  const taskId = isRecord(params) ? params.taskId : undefined;
  if (!isTaskId(taskId)) {
    return { success: false, error: formatError(ERROR_CODES.INVALID_ARGUMENT, 'task lock release requires a valid taskId') };
  }
  bridge.sendControl('taskLockRelease', { sessionId, taskId });
  // The release runs in `runTaskWithReport`'s finally, so a run just
  // ended in the MCP process — a pause or a settle — and its record is
  // already saved: push the list at this pause/settle moment. The MCP
  // process never notifies the daemon itself, so this wire action is the
  // daemon's only sight of an MCP-side run ending.
  void pushTaskStatus(bridge, tasksDir);
  return { success: true, result: { released: true } };
}
