import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTIVITY_STORAGE_KEY, ACTIVITY_TOOL_NAMES as EXTENSION_ACTIVITY_TOOLS, createActivityLog, createInputActivity } from '../extension/lib/activity-log.js';
import { isIpcClientMessage } from '../mcp-server/src/ipc-frame-validation.js';
import { allTools } from '../mcp-server/src/tools/index.js';
import { ACTIVITY_TOOL_NAMES as SERVER_ACTIVITY_TOOLS, activityOperationFor } from '../mcp-server/src/tools/types.js';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const event = (n: number, patch: Record<string, unknown> = {}) => ({
  kind: 'action',
  schemaVersion: 1,
  eventId: uuid(n),
  tabId: 7,
  pageVisitId: uuid(900),
  host: 'example.test',
  tool: 'browser_click',
  operation: 'click',
  startedAt: '2026-11-09T10:00:00.000Z',
  executionStatus: 'running',
  ...patch,
});

function sessionArea(initial: Record<string, unknown> = {}) {
  const values = structuredClone(initial);
  return {
    values,
    get: vi.fn(async (key: string) => ({ [key]: structuredClone(values[key]) })),
    set: vi.fn(async (items: Record<string, unknown>) => Object.assign(values, structuredClone(items))),
  };
}

describe('chrome action activity log', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('keeps server, extension, and IPC action-tool classifications aligned', () => {
    const serverNames = allTools.map((tool) => tool.name).filter((name) => activityOperationFor(name)).sort();
    expect([...SERVER_ACTIVITY_TOOLS]).toEqual(serverNames);
    expect([...EXTENSION_ACTIVITY_TOOLS]).toEqual(serverNames);
    expect(activityOperationFor('browser_snapshot')).toBe('snapshot');
    for (const tool of allTools) {
      const accepted = isIpcClientMessage({
        kind: 'call', id: 'activity-classification', tool: tool.name, params: { tabId: 1 },
        activityContext: { eventId: uuid(99) },
      });
      expect(accepted).toBe(serverNames.includes(tool.name));
    }
  });

  it('keeps action and batch-finished fixtures within the internal JSON contract', () => {
    const schemaPath = resolve(process.cwd(), 'specs/contracts/chrome-action-activity.schema.json');
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
    const validate = new Ajv2020({ strict: false, validateFormats: false }).compile(schema);
    const action = event(1, {
      dispatchStatus: 'sent',
      inputCounts: { confirmed: 1, uncertain: 0, required: 1 },
      targetElementId: 'confirm',
      batchRunId: uuid(100),
      batchStepIndex: 2,
    });
    const marker = {
      kind: 'batch-finished', schemaVersion: 1, batchRunId: uuid(100),
      endedAt: '2026-11-09T10:00:01.000Z', executionStatus: 'completed',
    };

    expect(validate(action), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...action, tool: 'browser_snapshot', operation: 'snapshot' }), JSON.stringify(validate.errors)).toBe(true);
    expect(validate(marker), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...action, rawParams: { text: 'private' } })).toBe(false);
  });

  it('bounds events, deduplicates transport retries, and survives a worker recreation', async () => {
    const area = sessionArea();
    const firstWorker = createActivityLog(area, { makeId: () => uuid(901) });
    for (let i = 1; i <= 501; i++) await firstWorker.append(event(i));
    await firstWorker.append(event(501, { targetLabel: 'duplicate retry' }));

    expect((await firstWorker.get()).events).toHaveLength(500);
    expect((await firstWorker.get()).historyTruncated).toBe(true);
    const restartedWorker = createActivityLog(area, { makeId: () => uuid(902) });
    const restored = await restartedWorker.get();
    expect(restored.events).toHaveLength(500);
    expect(restored.events[0].eventId).toBe(uuid(2));
  });

  it('restores in-flight actions as unknown and batches without a marker as incomplete', async () => {
    const batchRunId = uuid(210);
    const area = sessionArea({
      [ACTIVITY_STORAGE_KEY]: {
        schemaVersion: 1, events: [event(1, { batchRunId, batchStepIndex: 1 })],
        currentVisits: [], historyTruncated: false, incompleteBatchRunIds: [], includeElementNames: true,
      },
    });
    const restored = await createActivityLog(area).get();
    expect(restored.events[0].executionStatus).toBe('unknown');
    expect(restored.incompleteBatchRunIds).toContain(batchRunId);
    expect(restored.truncatedBatchRunIds).toEqual([]);
  });

  it('bounds a resolved page element id before it enters session storage', async () => {
    const log = createActivityLog(sessionArea());
    await log.append(event(1, { targetLabel: 'Save', targetElementId: 'x'.repeat(300) }));
    const stored = (await log.get()).events[0];
    expect(stored.targetElementId).toHaveLength(160);
    expect(stored.targetLabel).toBe('Save');
  });

  it('removes labels written under the older unsafe label policy when the log is loaded', async () => {
    const area = sessionArea({
      [ACTIVITY_STORAGE_KEY]: {
        schemaVersion: 1, events: [event(1, { targetLabel: 'private page text', targetElementId: 'confirm' })],
        currentVisits: [], historyTruncated: false, incompleteBatchRunIds: [], includeElementNames: true,
      },
    });
    await createActivityLog(area).get();

    const persisted = (area.values[ACTIVITY_STORAGE_KEY] as { events: Array<Record<string, unknown>> }).events[0];
    expect(persisted).not.toHaveProperty('targetLabel');
    expect(JSON.stringify(persisted)).not.toContain('private page text');
    expect(persisted.targetElementId).toBe('confirm');
    expect((area.values[ACTIVITY_STORAGE_KEY] as { elementLabelPolicyVersion: number }).elementLabelPolicyVersion).toBe(2);
  });

  it('shares the first storage read so an erase cannot be undone by a late initial read', async () => {
    const initial = {
      schemaVersion: 1, events: [event(1, { targetLabel: 'Save', targetElementId: 'confirm' })],
      currentVisits: [], historyTruncated: false, incompleteBatchRunIds: [], includeElementNames: true,
      elementLabelPolicyVersion: 2,
    };
    const values = { [ACTIVITY_STORAGE_KEY]: structuredClone(initial) } as Record<string, unknown>;
    let releaseRead!: () => void;
    const area = {
      get: vi.fn(async () => {
        await new Promise<void>((resolve) => { releaseRead = resolve; });
        return { [ACTIVITY_STORAGE_KEY]: structuredClone(values[ACTIVITY_STORAGE_KEY]) };
      }),
      set: vi.fn(async (items: Record<string, unknown>) => Object.assign(values, structuredClone(items))),
    };
    const log = createActivityLog(area);
    const firstRead = log.get();
    const erase = log.setElementNamesVisible(false);
    await vi.waitFor(() => expect(area.get).toHaveBeenCalledTimes(1));
    releaseRead();
    await Promise.all([firstRead, erase]);
    await log.append(event(2));

    const persisted = values[ACTIVITY_STORAGE_KEY] as { events: Array<Record<string, unknown>>; includeElementNames: boolean };
    expect(area.get).toHaveBeenCalledTimes(1);
    expect(persisted.includeElementNames).toBe(false);
    expect(JSON.stringify(persisted.events)).not.toContain('confirm');
  });

  it('does not restore element ids when privacy changes off and on during an action', async () => {
    const log = createActivityLog(sessionArea());
    const token = await log.getElementDetailsToken();
    await log.setElementNamesVisible(false);
    await log.setElementNamesVisible(true);
    await log.append(event(1, { targetElementId: 'confirm' }), token);

    expect((await log.get()).events[0]).not.toHaveProperty('targetElementId');
  });

  it('does not reveal ids captured while details were hidden if privacy is re-enabled before completion', async () => {
    const log = createActivityLog(sessionArea());
    await log.setElementNamesVisible(false);
    const token = await log.getElementDetailsToken();
    await log.setElementNamesVisible(true);
    await log.append(event(1, { targetElementId: 'confirm' }), token);

    expect((await log.get()).events[0]).not.toHaveProperty('targetElementId');
  });

  it('counts clicks only after both the mouse press and release are confirmed', () => {
    const confirmed = createInputActivity('browser_click', { count: 1 })!;
    confirmed.observe('Input.dispatchMouseEvent', { type: 'mousePressed' }, 'sent');
    expect(confirmed.summary().inputCounts).toEqual({ confirmed: 0, uncertain: 1, required: 1 });

    const uncertain = createInputActivity('browser_click', { count: 1 })!;
    uncertain.observe('Input.dispatchMouseEvent', { type: 'mousePressed' }, 'sent');
    uncertain.observe('Input.dispatchMouseEvent', { type: 'mouseReleased' }, 'unknown');
    expect(uncertain.summary().inputCounts).toEqual({ confirmed: 0, uncertain: 1, required: 1 });

    confirmed.observe('Input.dispatchMouseEvent', { type: 'mouseReleased' }, 'sent');
    expect(confirmed.summary().inputCounts).toEqual({ confirmed: 1, uncertain: 0, required: 1 });
  });

  it('waits for in-flight batch activity before recording its completion marker', async () => {
    const log = createActivityLog(sessionArea());
    const batchRunId = uuid(250);
    const marker = {
      kind: 'batch-finished' as const, schemaVersion: 1 as const, batchRunId,
      endedAt: '2026-11-09T10:00:01.000Z', executionStatus: 'completed' as const,
    };
    let releaseAppend!: () => void;
    const appendGate = new Promise<void>((resolve) => { releaseAppend = resolve; });
    const finishActivity = log.beginBatchActivity(batchRunId);
    const child = (async () => {
      await appendGate;
      await log.append(event(1, { batchRunId, batchStepIndex: 1 }));
      finishActivity();
    })();
    const finished = log.finishBatch(marker);
    releaseAppend();

    await Promise.all([child, finished]);
    expect((await log.get()).events[0]).toMatchObject({ batchEndedAt: marker.endedAt, batchExecutionStatus: 'completed' });
  });

  it('stores host-only visits and rotates document visits without changing SPA history', async () => {
    const area = sessionArea();
    let nextId = 77;
    const log = createActivityLog(area, { makeId: () => uuid(nextId++) });
    const first = await log.ensureVisit(7, 'https://user:secret@example.test/private/path?q=secret#top');
    const sameDocument = await log.ensureVisit(7, 'https://example.test/another-spa-route');
    const nextDocument = await log.rotateVisit(7, 'https://next.example.test/login?token=secret');

    expect(first).toMatchObject({ tabId: 7, host: 'example.test' });
    expect(sameDocument.pageVisitId).toBe(first.pageVisitId);
    expect(nextDocument).toMatchObject({ tabId: 7, host: 'next.example.test' });
    expect(nextDocument.pageVisitId).not.toBe(first.pageVisitId);
    expect(JSON.stringify(await log.get())).not.toMatch(/secret|private\/path|another-spa-route/);
  });

  it('erases saved element details and prevents queued writes from restoring them', async () => {
    const area = sessionArea();
    let releaseWrite: (() => void) | undefined;
    area.set.mockImplementationOnce(async (items) => {
      await new Promise<void>((resolveWrite) => { releaseWrite = resolveWrite; });
      Object.assign(area.values, structuredClone(items));
    });
    const log = createActivityLog(area);
    const append = log.append(event(1, { targetLabel: 'موافق', targetElementId: 'confirm' }));
    await vi.waitFor(() => expect(releaseWrite).toBeTypeOf('function'));
    const hide = log.setElementNamesVisible(false);
    releaseWrite?.();
    await Promise.all([append, hide]);

    const stored = await log.get();
    expect(stored.includeElementNames).toBe(false);
    expect(stored.events[0]).not.toHaveProperty('targetLabel');
    expect(stored.events[0]).not.toHaveProperty('targetElementId');
    await log.append(event(2, { targetLabel: 'إرسال' }));
    expect((await log.get()).events.every((item) => !('targetLabel' in item) && !('targetElementId' in item))).toBe(true);
  });

  it('marks evicted batch history incomplete and applies finish markers only to visible groups', async () => {
    const area = sessionArea();
    const log = createActivityLog(area);
    await log.append(event(1, { batchRunId: uuid(200), batchStepIndex: 1 }));
    await log.append(event(2, { batchRunId: uuid(200), batchStepIndex: 2 }));
    await log.finishBatch({
      kind: 'batch-finished', schemaVersion: 1, batchRunId: uuid(200),
      endedAt: '2026-11-09T10:00:01.000Z', executionStatus: 'completed',
    });
    for (let i = 3; i <= 502; i++) await log.append(event(i));

    const snapshot = await log.get();
    expect(snapshot.events[0].eventId).toBe(uuid(3));
    expect(snapshot.incompleteBatchRunIds).toContain(uuid(200));
    expect(snapshot.truncatedBatchRunIds).toContain(uuid(200));
    expect(snapshot.events.filter((item) => item.batchRunId === uuid(200))).toHaveLength(0);
  });

  it('keeps a finished batch marked incomplete when an earlier step was evicted', async () => {
    const log = createActivityLog(sessionArea());
    const batchRunId = uuid(220);
    await log.append(event(1, { batchRunId, batchStepIndex: 1 }));
    await log.append(event(2, { batchRunId, batchStepIndex: 2 }));
    for (let i = 3; i <= 501; i++) await log.append(event(i));
    await log.finishBatch({
      kind: 'batch-finished', schemaVersion: 1, batchRunId,
      endedAt: '2026-11-09T10:00:01.000Z', executionStatus: 'completed',
    });

    const snapshot = await log.get();
    expect(snapshot.incompleteBatchRunIds).toContain(batchRunId);
    expect(snapshot.truncatedBatchRunIds).toContain(batchRunId);
    expect(snapshot.events.find((item) => item.batchRunId === batchRunId)).toMatchObject({
      batchEndedAt: '2026-11-09T10:00:01.000Z', batchExecutionStatus: 'completed',
    });
  });

  it('clears history without clearing the current visit map', async () => {
    const area = sessionArea();
    const log = createActivityLog(area, { makeId: () => uuid(300) });
    const visit = await log.ensureVisit(7, 'https://example.test/');
    await log.append(event(1));
    await log.clear();

    expect(await log.get()).toMatchObject({ events: [], currentVisits: [visit], historyTruncated: false });
  });

  it('removes a closed tab from open visits while retaining its event history', async () => {
    const area = sessionArea();
    const log = createActivityLog(area, { makeId: () => uuid(400) });
    await log.ensureVisit(7, 'https://example.test/');
    await log.append(event(1));
    await log.closeVisit(7);

    expect((await log.get()).currentVisits).toEqual([]);
    expect((await log.get()).events).toHaveLength(1);
  });
});
