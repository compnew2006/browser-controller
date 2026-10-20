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

const { logEntryView, summarizeIssue, aggregateIssues, collectBrowserLog, collectPageConsole } = await import('../extension/lib/browser-log.js');
const { handleConsole } = await import('../extension/handlers/tabs.js');
const { detachCdp } = await import('../extension/lib/cdp-session.js');

const formIssue = (errorType: string) => ({ code: 'GenericIssue', details: { genericIssueDetails: { errorType, frameId: 'f' } } });
const syncXhr = { code: 'DeprecationIssue', details: { deprecationIssueDetails: { type: 'XHRSyncMainThread', sourceCodeLocation: { url: 'https://example.test/', lineNumber: 3 } } } };
const notFound = { source: 'network', level: 'error', text: 'Failed to load resource: the server responded with a status of 404 (Not Found)', url: 'https://example.test/missing.png', timestamp: 1000.6 };

describe('browser log (Chrome-reported messages and Issues)', () => {
  it('maps Log entries to console-style levels', () => {
    expect(logEntryView(notFound)).toEqual({ level: 'error', source: 'network', text: notFound.text, url: notFound.url, timestamp: 1001 });
    expect(logEntryView({ level: 'warning', source: 'violation', text: 'x' })).toEqual({ level: 'warn', source: 'violation', text: 'x' });
    expect(logEntryView({ level: 'verbose', source: 'other', text: 'y' }).level).toBe('debug');
  });

  it('summarizes an issue by code, the specific problem and where it happened', () => {
    expect(summarizeIssue(syncXhr)).toEqual({ code: 'DeprecationIssue', type: 'XHRSyncMainThread', url: 'https://example.test/' });
    expect(summarizeIssue({ code: 'CorsIssue', details: { corsIssueDetails: { corsErrorStatus: { corsError: 'MissingAllowOriginHeader' }, request: { url: 'https://api.example/x' } } } }))
      .toEqual({ code: 'CorsIssue', type: 'MissingAllowOriginHeader', url: 'https://api.example/x' });
    expect(summarizeIssue({ code: 'CookieIssue', details: { cookieIssueDetails: { cookieWarningReasons: ['WarnSameSiteUnspecifiedLaxAllowUnsafe'] } } }).type)
      .toBe('WarnSameSiteUnspecifiedLaxAllowUnsafe');
    expect(summarizeIssue({})).toEqual({ code: 'Issue' });
  });

  it('counts repeats of the same issue like the DevTools Issues panel', () => {
    const f = 'FormEmptyIdAndNameAttributesForInputError';
    expect(aggregateIssues([formIssue(f), syncXhr, formIssue(f), formIssue(f)])).toEqual([
      { code: 'GenericIssue', type: f, count: 3 },
      { code: 'DeprecationIssue', type: 'XHRSyncMainThread', url: 'https://example.test/', count: 1 },
    ]);
  });

  it('collects the replay, then switches the domains off again and stops listening', async () => {
    const calls: string[] = [];
    let listener: ((m: string, p: any) => void) | null = null;
    const send = async (m: string) => {
      calls.push(m);
      if (m === 'Log.enable') listener?.('Log.entryAdded', { entry: notFound });
      if (m === 'Audits.enable') listener?.('Audits.issueAdded', { issue: syncXhr });
      return {};
    };
    const subscribe = (fn: any) => { listener = fn; return () => { listener = null; }; };
    const out = await collectBrowserLog(send, subscribe, { clear: true, settleMs: 0 });
    expect(out.messages).toHaveLength(1);
    expect(out.issues).toEqual([{ code: 'DeprecationIssue', type: 'XHRSyncMainThread', url: 'https://example.test/', count: 1 }]);
    expect(calls).toEqual(['Log.enable', 'Audits.enable', 'Log.clear', 'Log.disable', 'Audits.disable']);
    expect(listener).toBeNull();
  });
});

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
    expect(out).toEqual([
      { level: 'log', text: 'early 42 {"id":"o1"}', timestamp: 10 },
      { level: 'error', text: 'Error reading query stream: TypeError: x\n    at f (https://a.test/app.js:4:1)', timestamp: 11 },
      { level: 'warn', text: 'undefined null', timestamp: 12 },
      { level: 'error', text: 'Uncaught Error: boom\n    at https://a.test/:5:30', timestamp: 14 },
      { level: 'error', text: 'Uncaught (in promise) nope (https://a.test/:10)', timestamp: 15 },
    ]);
    // Runtime only replays from a disabled state; it is switched off again.
    expect(calls).toEqual(['Runtime.disable', 'Runtime.enable', 'Runtime.callFunctionOn', 'Runtime.discardConsoleEntries', 'Runtime.disable']);
    expect(listener).toBeNull();
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

describe('browser_console browser:true', () => {
  beforeEach(async () => {
    await detachCdp(3);
    sent.length = 0;
    replay = [
      ['Runtime.consoleAPICalled', { type: 'warning', timestamp: 1, args: [{ type: 'string', value: 'page warn' }] }],
      ['Log.entryAdded', { entry: notFound }],
      ['Log.entryAdded', { entry: { source: 'violation', level: 'verbose', text: 'Forced reflow while executing JavaScript took 40ms' } }],
      ['Audits.issueAdded', { issue: syncXhr }],
      ['Audits.issueAdded', { issue: formIssue('FormLabelForNameError') }],
    ];
  });

  it('adds what Chrome reported for the page next to the console messages', async () => {
    const res = await handleConsole({ tabId: 3, browser: true }) as any;
    expect(res.messages).toEqual([{ level: 'warn', text: 'page warn', timestamp: 1 }]);
    expect(res.browser.messages.map((m: any) => `${m.level}:${m.source}`)).toEqual(['error:network', 'debug:violation']);
    expect(res.browser.issues.map((i: any) => i.type)).toEqual(['XHRSyncMainThread', 'FormLabelForNameError']);
  });

  it('applies level and pattern to Chrome messages too, and pattern to issues', async () => {
    const res = await handleConsole({ tabId: 3, browser: true, level: ['error', 'warn'], pattern: '404|XHR' }) as any;
    expect(res.messages).toEqual([]);
    expect(res.browser.messages.map((m: any) => m.source)).toEqual(['network']);
    expect(res.browser.issues.map((i: any) => i.type)).toEqual(['XHRSyncMainThread']);
  });

  it('reads the page console through Runtime only, unless asked for more', async () => {
    const res = await handleConsole({ tabId: 3 }) as any;
    expect(res.messages).toEqual([{ level: 'warn', text: 'page warn', timestamp: 1 }]);
    expect(res.browser).toBeUndefined();
    expect(sent.filter((m) => /^Runtime\.(en|dis)able/.test(m))).toEqual(['Runtime.disable', 'Runtime.enable', 'Runtime.disable']);
    expect(sent.some((m) => m.startsWith('Log.') || m.startsWith('Audits.'))).toBe(false);
  });
});
