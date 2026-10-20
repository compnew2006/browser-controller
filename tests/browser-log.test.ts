import { beforeEach, describe, expect, it } from 'vitest';

// chrome.debugger mock: Log/Audits replay what the page collected when enabled.
const cdpListeners: Array<(source: { tabId: number }, method: string, params: any) => void> = [];
const sent: string[] = [];
let replay: Array<[string, any]> = [];
(globalThis as any).chrome = {
  tabs: { get: async (id: number) => ({ id, url: 'https://example.test/', windowId: 1 }), onRemoved: { addListener: () => {} } },
  windows: { get: async () => ({ width: 1280, height: 900 }) },
  storage: { session: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({}), set: async () => {} } },
  debugger: {
    attach: async () => {},
    detach: async () => {},
    sendCommand: async ({ tabId }: { tabId: number }, method: string, params: any) => {
      sent.push(method);
      if (method === 'Log.enable' || method === 'Audits.enable' || method === 'Runtime.enable') {
        const domain = method.split('.')[0];
        for (const [m, p] of replay) if (m.startsWith(domain)) cdpListeners.forEach((fn) => fn({ tabId }, m, p));
      }
      if (method === 'Runtime.callFunctionOn') return { result: { value: params.arguments.map((a: any) => `json:${a.objectId}`) } };
      return { result: { value: 1 } };
    },
    onEvent: { addListener: (fn: any) => cdpListeners.push(fn) },
    onDetach: { addListener: () => {} },
  },
};

const { collectPageConsole } = await import('../extension/lib/browser-log.js');
const { handleLogs } = await import('../extension/handlers/logs.js');
const { detachCdp } = await import('../extension/lib/cdp-session.js');

describe('page console (Runtime replay)', () => {
  const str = (value: string) => ({ type: 'string', value });

  it('formats console calls and uncaught exceptions, JSON only for plain objects and arrays', async () => {
    const calls: string[] = [];
    let listener: ((m: string, p: any) => void) | null = null;
    const send = async (m: string, p: any = {}) => {
      calls.push(m);
      if (m === 'Runtime.enable') {
        listener?.('Runtime.consoleAPICalled', { type: 'log', timestamp: 10.4, args: [str('early'), { type: 'number', value: 42 }, { type: 'object', objectId: 'o1', description: 'Object' }] });
        listener?.('Runtime.consoleAPICalled', { type: 'error', timestamp: 11, args: [str('Error reading query stream:'), { type: 'object', subtype: 'error', objectId: 'e1', description: "TypeError: x\n    at f (https://a.test/app.js:4:1)" }] });
        listener?.('Runtime.consoleAPICalled', { type: 'warning', timestamp: 12, args: [{ type: 'undefined' }, { type: 'object', subtype: 'null', value: null }] });
        listener?.('Runtime.consoleAPICalled', { type: 'endGroup', timestamp: 13, args: [] });
        listener?.('Runtime.exceptionThrown', { timestamp: 14, exceptionDetails: { text: 'Uncaught', url: 'https://a.test/', lineNumber: 4, exception: { type: 'object', subtype: 'error', description: 'Error: boom\n    at https://a.test/:5:30' } } });
        listener?.('Runtime.exceptionThrown', { timestamp: 15, exceptionDetails: { text: 'Uncaught (in promise)', url: 'https://a.test/', lineNumber: 9, exception: { type: 'string', value: 'nope' } } });
      }
      if (m === 'Runtime.callFunctionOn') return { result: { value: p.arguments.map((a: any) => `{"id":"${a.objectId}"}`) } };
      return {};
    };
    const subscribe = (fn: any) => { listener = fn; return () => { listener = null; }; };
    const out = await collectPageConsole(send, subscribe, { clear: true, settleMs: 0 });
    // Where an exception happened is its own `source` (a line prints it once), not part of the text.
    expect(out).toEqual([
      { level: 'log', text: 'early 42 {"id":"o1"}', timestamp: 10 },
      { level: 'error', text: 'Error reading query stream: TypeError: x\n    at f (https://a.test/app.js:4:1)', timestamp: 11 },
      { level: 'warn', text: 'undefined null', timestamp: 12 },
      { level: 'error', text: 'Uncaught Error: boom\n    at https://a.test/:5:30', timestamp: 14, source: 'https://a.test/:5' },
      { level: 'error', text: 'Uncaught (in promise) nope', timestamp: 15, source: 'https://a.test/:10' },
    ]);
    // Runtime only replays from a disabled state; it is switched off again.
    expect(calls).toEqual(['Runtime.disable', 'Runtime.enable', 'Runtime.callFunctionOn', 'Runtime.discardConsoleEntries', 'Runtime.disable']);
    expect(listener).toBeNull();
  });

  it('gives a console error its call site and the frames below it (callFrames), a plain call no stack', async () => {
    let listener: ((m: string, p: any) => void) | null = null;
    const frame = (functionName: string, lineNumber: number) => ({ functionName, url: 'https://a.test/app.js', lineNumber, columnNumber: 2 });
    const send = async (m: string) => {
      if (m === 'Runtime.enable') {
        listener?.('Runtime.consoleAPICalled', { type: 'error', timestamp: 20, args: [str('save failed')], stackTrace: { callFrames: [frame('save', 9), frame('onClick', 19)] } });
        listener?.('Runtime.consoleAPICalled', { type: 'log', timestamp: 21, args: [str('ok')], stackTrace: { callFrames: [frame('save', 9)] } });
      }
      return {};
    };
    const subscribe = (fn: any) => { listener = fn; return () => { listener = null; }; };
    const out = await collectPageConsole(send, subscribe, { settleMs: 0 });
    expect(out).toEqual([
      { level: 'error', text: 'save failed', timestamp: 20, source: 'https://a.test/app.js:10', stack: ['at save (https://a.test/app.js:10:3)', 'at onClick (https://a.test/app.js:20:3)'] },
      { level: 'log', text: 'ok', timestamp: 21, source: 'https://a.test/app.js:10' },
    ]);
  });

  it('filters levels before formatting and keeps only the latest entries', async () => {
    let listener: ((m: string, p: any) => void) | null = null;
    const formatted: string[] = [];
    const send = async (m: string, p: any = {}) => {
      if (m === 'Runtime.enable') {
        for (let i = 0; i < 5; i++) listener?.('Runtime.consoleAPICalled', { type: i % 2 ? 'error' : 'log', args: [{ type: 'object', objectId: `o${i}` }] });
      }
      if (m === 'Runtime.callFunctionOn') { formatted.push(p.objectId); return { result: { value: ['x'] } }; }
      return {};
    };
    const subscribe = (fn: any) => { listener = fn; return () => { listener = null; }; };
    const out = await collectPageConsole(send, subscribe, { levels: new Set(['error']), max: 1, settleMs: 0 });
    expect(out).toEqual([{ level: 'error', text: 'x' }]);
    expect(formatted).toEqual(['o3']);
  });
});

describe('browser_logs console block (Runtime replay only)', () => {
  // Chrome's own Log and Audits events are replayed too, so the test shows they are not read.
  const notFound = { source: 'network', level: 'error', text: 'Failed to load resource', url: 'https://example.test/missing.png', timestamp: 1000.6 };
  const syncXhr = { code: 'DeprecationIssue', details: {} };
  beforeEach(async () => {
    await detachCdp(3);
    sent.length = 0;
    replay = [
      ['Runtime.consoleAPICalled', { type: 'warning', timestamp: 1, args: [{ type: 'string', value: 'page warn' }] }],
      ['Runtime.consoleAPICalled', { type: 'error', timestamp: 2, args: [{ type: 'string', value: 'page broke' }] }],
      ['Log.entryAdded', { entry: notFound }],
      ['Audits.issueAdded', { issue: syncXhr }],
    ];
  });

  it('reads the page console through Runtime only: Chrome Log and Issues are not part of the console block', async () => {
    const res = await handleLogs({ tabId: 3, kind: 'console' }) as any;
    expect(res.messages).toEqual([
      { level: 'warn', text: 'page warn', timestamp: 1 },
      { level: 'error', text: 'page broke', timestamp: 2 },
    ]);
    expect(res.text.split('\n')[0]).toBe('console (2):');
    expect(sent.filter((m) => /^Runtime\.(en|dis)able/.test(m))).toEqual(['Runtime.disable', 'Runtime.enable', 'Runtime.disable']);
    expect(sent.some((m) => m.startsWith('Log.') || m.startsWith('Audits.'))).toBe(false);
  });

  it('errors:true and filter narrow the console block', async () => {
    expect((await handleLogs({ tabId: 3, kind: 'console', errors: true }) as any).messages).toEqual([{ level: 'error', text: 'page broke', timestamp: 2 }]);
    expect((await handleLogs({ tabId: 3, kind: 'console', filter: 'WARN' }) as any).messages).toEqual([{ level: 'warn', text: 'page warn', timestamp: 1 }]);
  });
});
