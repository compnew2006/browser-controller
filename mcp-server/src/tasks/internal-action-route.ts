import { TASK_LOCK_RELEASE_WIRE_ACTION, TASK_QUESTION_WIRE_ACTION } from '../protocol/wire-tools.js';
import { routeTaskLockRelease } from './task-lock-release-route.js';
import { routeTaskQuestion } from './task-question-route.js';

/** The daemon control channel used by task lifecycle actions. */
export interface TaskInternalActionBridge {
  sendControl(type: string, payload?: Record<string, unknown>): void;
}

/** Route task-only IPC actions before browser-tool policy and rate limiting. */
export function routeTaskInternalAction(
  bridge: TaskInternalActionBridge,
  sessionId: string,
  tool: string,
  params: Record<string, unknown>,
  tasksDir?: string,
) {
  if (tool === TASK_QUESTION_WIRE_ACTION) return routeTaskQuestion(bridge, params, tasksDir);
  if (tool === TASK_LOCK_RELEASE_WIRE_ACTION) return routeTaskLockRelease(bridge, sessionId, params, tasksDir);
  return undefined;
}
