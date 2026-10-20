import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakePage, type FakeDocument, type FakeElement } from './helpers/fake-dom.js';

/**
 * Two mocks in one: chrome.scripting runs page functions in-process and, like
 * Chrome, answers a function that throws with a bare null (the uncaught error
 * is recorded by the page runtime, as lib/page-dom.js does through an
 * isolated-world error listener). chrome.debugger answers from a queue for the
 * Runtime.evaluate calls that run_action and upload_file make.
 */
const cdpCalls: Array<{ method: string; params: Record<string, any> }> = [];
/** Answers for the run_action evaluations, in order (a Promise never settles). */
const runQueue: unknown[] = [];
const g = globalThis as any;

g.chrome = {
  tabs: { get: async (id: number) => ({ id, url: 'https://example.test/page', windowId: 1 }), query: async () => [], onRemoved: { addListener: () => {} } },
  scripting: {
    executeScript: async (o: { func: (...a: any[]) => unknown; args?: unknown[] }) => {
      try {
        const value = await o.func(...(o.args ?? []));
        return [{ result: value === undefined ? null : value }];
      } catch (err) {
        g.__bcPageError = { message: (err as Error).message, at: Date.now() };
        return [{ result: null }];
      }
    },
  },
  storage: { session: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({}), set: async () => {} } },
  debugger: {
    attach: async () => {},
    detach: async () => {},
    sendCommand: async (_target: unknown, method: string, params: Record<string, any> = {}) => {
      cdpCalls.push({ method, params });
      if (method === 'Runtime.evaluate' && (String(params.expression).includes('(async function') || String(params.expression).includes('data-bc-upload'))) {
        if (String(params.expression).includes('data-bc-upload')) return { result: { objectId: 'node-1' } };
        return runQueue.length ? runQueue.shift() : {};
      }
      return {};
    },
    onDetach: { addListener: () => {} },
  },
};

const { PAGE_DOM_INSTALL, PAGE_DOM_VERSION, } = await import('../extension/lib/page-dom.js');
const { execDom, safeExec } = await import('../extension/lib/page-exec.js');
const { handleRunAction, handleUploadFile } = await import('../extension/handlers/cdp.js');
const session = await import('../extension/lib/cdp-session.js');
const { fallbackByTab } = await import('../extension/lib/state.js');

let doc: FakeDocument;

beforeEach(async () => {
  cdpCalls.length = 0;
  runQueue.length = 0;
  g.__bcPageError = null;
  doc = installFakePage();
  fallbackByTab.clear();
  PAGE_DOM_INSTALL(PAGE_DOM_VERSION);
  await session.detachCdp(5);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a page function that throws is a failure for its caller (was: bare null)', () => {
  it('execDom rejects with SCRIPT_ERROR carrying the thrown message', async () => {
    const err = await execDom(1, () => { throw new Error('boom'); }).catch((e: any) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({ code: 'SCRIPT_ERROR', message: 'SCRIPT_ERROR: boom' });
  });

  it('an in-band { __bcScriptError } result is a SCRIPT_ERROR too', async () => {
    await expect(safeExec(1, () => ({ __bcScriptError: 'bad input' }), [])).rejects.toMatchObject({ message: 'SCRIPT_ERROR: bad input' });
  });

  it('a function that returns null or undefined without an error still resolves to that value', async () => {
    expect(await safeExec(1, () => null, [])).toBeNull();
    expect(await safeExec(1, () => undefined, [])).toBeNull();
  });

  it('an error recorded before this call does not fail a later call', async () => {
    g.__bcPageError = { message: 'old one', at: Date.now() - 60_000 };
    expect(await safeExec(1, () => null, [])).toBeNull();
    expect(g.__bcPageError).toBeNull(); // the stale record was taken and cleared
  });

  it('the page runtime records uncaught errors in the isolated world (when the page exposes a listener)', () => {
    const listeners: Record<string, (e: any) => void> = {};
    g.addEventListener = (type: string, fn: (e: any) => void) => { listeners[type] = fn; };
    g.__bcErrorRecorder = undefined;
    PAGE_DOM_INSTALL(PAGE_DOM_VERSION + 1000); // a fresh install (the version check forces it)
    listeners.error({ error: new Error('listener saw this') });
    expect(g.__bcPageError).toMatchObject({ message: 'listener saw this' });
    delete g.addEventListener;
    delete g.__bcErrorRecorder;
  });
});

describe('browser_run_action', () => {
  it('a thrown error fails with SCRIPT_ERROR (was success:true with the error as the result)', async () => {
    runQueue.push({ result: { value: { __bcOk: false, message: 'nope' } } });
    const res = await handleRunAction({ tabId: 5, code: '({ execute() { throw new Error("nope"); } })', actionParams: {} });
    expect(res).toEqual({ success: false, error: 'SCRIPT_ERROR: nope' });
  });

  it('a plain value is returned once, not wrapped as text inside a content envelope', async () => {
    runQueue.push({ result: { value: { __bcOk: true, result: 'Title' } } });
    expect(await handleRunAction({ tabId: 5, code: 'document.title', actionParams: {} })).toEqual({ success: true, result: 'Title' });
  });

  it('an action that returns MCP-style content keeps that content as its result', async () => {
    const content = { content: [{ type: 'text', text: 'hi' }] };
    runQueue.push({ result: { value: { __bcOk: true, result: content } } });
    expect(await handleRunAction({ tabId: 5, code: '({ execute() { return { content: [] }; } })', actionParams: {} }))
      .toEqual({ success: true, result: content });
  });

  it('multi-statement code is retried as a statement body after the expression form fails to parse', async () => {
    runQueue.push({ exceptionDetails: { text: 'Uncaught SyntaxError: Unexpected token var', exception: { className: 'SyntaxError' } } });
    runQueue.push({ result: { value: { __bcOk: true, result: 42 } } });
    const code = 'var a = 40; var b = 2; return a + b;';
    const res = await handleRunAction({ tabId: 5, code, actionParams: {} });
    expect(res).toEqual({ success: true, result: 42 });
    const evals = cdpCalls.filter((c) => c.method === 'Runtime.evaluate' && String(c.params.expression).includes('(async function'));
    expect(evals).toHaveLength(2);
    expect(evals[1].params.expression).toContain(code);
  });

  it('a run that never finishes returns TIMEOUT after 25 s instead of holding the tab', async () => {
    runQueue.push(new Promise(() => {}));
    await session.ensureCdp(5); // attach under real timers; only the run is timed
    vi.useFakeTimers();
    const pending = handleRunAction({ tabId: 5, code: 'new Promise(() => {})', actionParams: {} });
    await vi.advanceTimersByTimeAsync(25_000);
    await expect(pending).resolves.toMatchObject({ success: false, error: expect.stringMatching(/^TIMEOUT: /) });
  });
});

describe('browser_upload_file', () => {
  it('sets the file once, fires no events from the page side, and reports basenames only', async () => {
    const input: FakeElement = doc.el('input', { id: 'file', type: 'file' });
    doc.body.append(input);
    const res = await handleUploadFile({ tabId: 5, selector: '#file', filePath: '/Users/someone/private/resume.pdf' });
    expect(res).toEqual({ success: true, files: ['resume.pdf'], selector: '#file' });
    const setCalls = cdpCalls.filter((c) => c.method === 'DOM.setFileInputFiles');
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].params.files).toEqual(['/Users/someone/private/resume.pdf']);
    // Chromium fires input/change itself on setFileInputFiles; the page side must not add more.
    expect(input.events).not.toContain('input');
    expect(input.events).not.toContain('change');
    expect(input.attrs.has('data-bc-upload')).toBe(false);
  });
});
