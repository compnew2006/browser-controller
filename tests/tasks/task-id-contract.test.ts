import { describe, expect, it } from 'vitest';
import { isIpcClientMessage } from '../../mcp-server/src/ipc-frame-validation.js';
import { TASK_ID_PATTERN } from '../../extension/lib/generated-contract.js';
import { routeTaskLockRelease } from '../../mcp-server/src/tasks/task-lock-release-route.js';
import { isTaskId } from '../../mcp-server/src/tasks/task-id.js';

describe('persisted task id contract', () => {
  it('keeps legacy task ids usable in browser activity and lock release frames', () => {
    const taskId = 'legacy_task-1';
    expect(new RegExp(`^${TASK_ID_PATTERN}$`, 'u').test(taskId)).toBe(isTaskId(taskId));
    const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const bridge = {
      sendControl(type: string, payload: Record<string, unknown>) {
        sent.push({ type, payload });
      },
    };

    expect(isIpcClientMessage({
      kind: 'call',
      id: 'legacy-task-step',
      tool: 'browser_snapshot',
      params: { tabId: 1 },
      activityContext: {
        eventId: '00000000-0000-4000-8000-000000000001',
        taskId,
      },
    })).toBe(true);
    expect(routeTaskLockRelease(bridge, 'session-1', { taskId })).toEqual({
      success: true,
      result: { released: true },
    });
    expect(sent).toEqual([{ type: 'taskLockRelease', payload: { sessionId: 'session-1', taskId } }]);
  });
});
