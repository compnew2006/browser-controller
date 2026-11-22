/** Task ids share this pattern across the task store, daemon IPC, and extension contract. */
export const TASK_ID_PATTERN = '[A-Za-z0-9][A-Za-z0-9_-]{0,127}';

const TASK_ID_RE = new RegExp(`^${TASK_ID_PATTERN}$`, 'u');

export function isTaskId(value: unknown): value is string {
  return typeof value === 'string' && TASK_ID_RE.test(value);
}
