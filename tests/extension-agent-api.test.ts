import { beforeEach, describe, expect, it, vi } from 'vitest';

const tabs = new Map<number, { id: number; url: string; title: string }>();
const injections: Array<Record<string, any>> = [];
const debuggerCommands: string[] = [];
let nextResult: unknown = null;
let queryNodeId = 2;

(globalThis as any).chrome = {
  tabs: {
    get: async (tabId: number) => tabs.get(tabId) ?? Promise.reject(new Error(`No tab ${tabId}`)),
    query: async () => [],
  },
  scripting: {
    executeScript: vi.fn(async (request: Record<string, any>) => {
      injections.push(request);
      if (nextResult instanceof Error) throw nextResult;
      if (typeof nextResult === 'function') return [{ result: (nextResult as Function)(request) }];
      return [{ result: nextResult }];
    }),
  },
  storage: {
    session: { get: async () => ({}), set: async () => {} },
    local: { get: async () => ({}), set: async () => {} },
  },
  debugger: {
    attach: async () => {},
    detach: async () => {},
    sendCommand: async (_target: unknown, method: string) => {
      debuggerCommands.push(method);
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'DOM.querySelector') return { nodeId: queryNodeId };
      return {};
    },
  },
};

const { handleObserve, handleAct } = await import('../extension/handlers/agent-api.js');
const { observationSnapshots } = await import('../extension/lib/state.js');

describe('observe/act extension handlers', () => {
  beforeEach(() => {
    tabs.clear();
    tabs.set(7, { id: 7, url: 'https://example.test', title: 'Example' });
    injections.length = 0;
    debuggerCommands.length = 0;
    queryNodeId = 2;
    nextResult = null;
    observationSnapshots.clear();
    vi.clearAllMocks();
  });

  it('captures and registers one atomic compact observation', async () => {
    nextResult = (request: Record<string, any>) => ({
      success: true,
      snapshotId: request.args[0].snapshotId,
      documentId: 'd_page',
      documentVersion: 'd_page:1:0',
      url: 'https://example.test',
      title: 'Example',
      viewport: { width: 1000, height: 700 },
      elements: [{ ref: 'e1', role: 'button', name: 'Continue', bbox: [1, 2, 3, 4], actions: ['click'] }],
      text: 'Continue',
      metrics: { captureMs: 2, payloadBytes: 250, protocolCalls: 1 },
    });

    const result = await handleObserve({ tabId: 7, mode: 'compact' }, 'session-a');

    expect(result).toMatchObject({
      success: true,
      tabId: 7,
      documentVersion: 'd_page:1:0',
      metrics: { protocolCalls: 1 },
    });
    expect(result.snapshotId).toMatch(/^s_/);
    expect(injections).toHaveLength(1);
    expect(observationSnapshots.validate(result.snapshotId, 7, 'session-a')).toMatchObject({ ok: true });
  });

  it('rejects unsupported observation modes before touching the page', async () => {
    const result = await handleObserve({ tabId: 7, mode: 'detailed' }, 'session-a');
    expect(result).toMatchObject({ success: false, error: 'INVALID_ACTION_ARGUMENTS' });
    expect(injections).toHaveLength(0);
  });

  it('returns TAB_NOT_FOUND as a structured error', async () => {
    const result = await handleObserve({ tabId: 99 }, 'session-a');
    expect(result).toMatchObject({ success: false, error: 'TAB_NOT_FOUND', tabId: 99 });
  });

  it('does not execute a wrong-session or wrong-tab snapshot', async () => {
    observationSnapshots.register({
      snapshotId: 's_owned', tabId: 7, sessionId: 'session-a',
      documentId: 'd_page', documentVersion: 'd_page:1:0', createdAt: Date.now(),
    });

    const wrongSession = await handleAct({ tabId: 7, snapshotId: 's_owned', action: 'click', ref: 'e1' }, 'session-b');
    const wrongTab = await handleAct({ tabId: 8, snapshotId: 's_owned', action: 'click', ref: 'e1' }, 'session-a');

    expect(wrongSession).toMatchObject({ success: false, error: 'SNAPSHOT_NOT_FOUND', reason: 'WRONG_SESSION' });
    expect(wrongTab).toMatchObject({ success: false, error: 'SNAPSHOT_NOT_FOUND', reason: 'WRONG_TAB' });
    expect(injections).toHaveLength(0);
  });

  it('validates action-specific arguments before page execution', async () => {
    const result = await handleAct({ tabId: 7, snapshotId: 's_any', action: 'type', ref: 'e1' }, 'session-a');
    expect(result).toMatchObject({ success: false, error: 'INVALID_ACTION_ARGUMENTS', missing: 'text' });
    expect(injections).toHaveLength(0);
  });

  it('executes a validated action and keeps the result compact', async () => {
    observationSnapshots.register({
      snapshotId: 's_owned', tabId: 7, sessionId: 'session-a',
      documentId: 'd_page', documentVersion: 'd_page:1:0', createdAt: Date.now(),
    });
    nextResult = {
      success: true,
      ok: true,
      action: 'click',
      ref: 'e1',
      documentVersion: 'd_page:1:1',
      navigationDetected: false,
      documentChanged: false,
      url: 'https://example.test',
      metrics: { durationMs: 1, protocolCalls: 1 },
    };

    const result = await handleAct({ tabId: 7, snapshotId: 's_owned', action: 'click', ref: 'e1' }, 'session-a');

    expect(result).toMatchObject({ success: true, ok: true, tabId: 7, action: 'click', ref: 'e1' });
    expect(injections).toHaveLength(1);
  });

  it('reports an unknown action outcome instead of claiming success when navigation destroys the context', async () => {
    observationSnapshots.register({
      snapshotId: 's_navigation', tabId: 7, sessionId: 'session-a',
      documentId: 'd_page', documentVersion: 'd_page:1:0', createdAt: Date.now(),
    });
    nextResult = new Error('Execution context was invalidated by navigation');

    const result = await handleAct({
      tabId: 7, snapshotId: 's_navigation', action: 'click', ref: 'e1',
    }, 'session-a');

    expect(result).toMatchObject({
      success: false,
      error: 'STALE_STATE',
      navigationDetected: true,
      actionOutcome: 'unknown',
    });
  });

  it('preserves a known action result when cancellation arrives after page dispatch', async () => {
    observationSnapshots.register({
      snapshotId: 's_cancelled_late', tabId: 7, sessionId: 'session-a',
      documentId: 'd_page', documentVersion: 'd_page:1:0', createdAt: Date.now(),
    });
    const controller = new AbortController();
    nextResult = () => {
      controller.abort();
      return {
        success: true, ok: true, action: 'focus', ref: 'e1',
        documentVersion: 'd_page:1:1', metrics: { durationMs: 1, protocolCalls: 1 },
      };
    };

    const result = await handleAct({
      tabId: 7, snapshotId: 's_cancelled_late', action: 'focus', ref: 'e1',
    }, 'session-a', undefined, controller.signal);

    expect(result).toMatchObject({ success: true, ok: true, cancelledAfterDispatch: true });
  });

  it('hands a validated file input to the existing CDP uploader', async () => {
    observationSnapshots.register({
      snapshotId: 's_upload', tabId: 7, sessionId: 'session-a',
      documentId: 'd_page', documentVersion: 'd_page:1:0', createdAt: Date.now(),
    });
    let selectorInjection = 0;
    nextResult = (request: Record<string, any>) => {
      if (request.args?.[0]?.params?.action === 'upload') {
        return {
          success: true, ok: true, action: 'upload', ref: 'e1', preparedUpload: true,
          selector: '[data-bc-v2-upload="token"]', documentVersion: 'd_page:1:0',
          metrics: { durationMs: 1, protocolCalls: 1 },
        };
      }
      selectorInjection += 1;
      return selectorInjection === 1 ? { found: true, isFileInput: true, multiple: false } : null;
    };

    const result = await handleAct({
      tabId: 7, snapshotId: 's_upload', action: 'upload', ref: 'e1', filePath: '/tmp/resume.pdf',
    }, 'session-a');

    expect(result).toMatchObject({ success: true, ok: true, action: 'upload', files: ['/tmp/resume.pdf'] });
    expect(debuggerCommands).toEqual(['DOM.enable', 'DOM.getDocument', 'DOM.querySelector', 'DOM.setFileInputFiles']);
    expect(result.metrics).toMatchObject({ protocolCalls: 7 });
  });

  it('returns a structured stale error if the file input disappears during CDP handoff', async () => {
    observationSnapshots.register({
      snapshotId: 's_upload_stale', tabId: 7, sessionId: 'session-a',
      documentId: 'd_page', documentVersion: 'd_page:1:0', createdAt: Date.now(),
    });
    queryNodeId = 0;
    nextResult = (request: Record<string, any>) => request.args?.[0]?.params?.action === 'upload'
      ? {
        success: true, ok: true, action: 'upload', ref: 'e1', preparedUpload: true,
        selector: '[data-bc-v2-upload="token"]', documentVersion: 'd_page:1:0',
        metrics: { durationMs: 1, protocolCalls: 1 },
      }
      : { found: true, isFileInput: true, multiple: false };

    const result = await handleAct({
      tabId: 7, snapshotId: 's_upload_stale', action: 'upload', ref: 'e1', filePath: '/tmp/resume.pdf',
    }, 'session-a');

    expect(result).toMatchObject({
      success: false, error: 'STALE_STATE', reason: 'UPLOAD_HANDOFF_FAILED', ref: 'e1',
    });
  });
});
