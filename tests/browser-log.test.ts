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
    sendCommand: async ({ tabId }: { tabId: number }, method: string) => {
      sent.push(method);
      if (method === 'Log.enable' || method === 'Audits.enable') {
        const domain = method.split('.')[0];
        for (const [m, p] of replay) if (m.startsWith(domain)) cdpListeners.forEach((fn) => fn({ tabId }, m, p));
      }
      return { result: { value: 1 } };
    },
    onEvent: { addListener: (fn: any) => cdpListeners.push(fn) },
    onDetach: { addListener: () => {} },
  },
};

const { logEntryView, summarizeIssue, aggregateIssues, collectBrowserLog } = await import('../extension/lib/browser-log.js');
const { handleConsole } = await import('../extension/handlers/tabs.js');
const { detachCdp } = await import('../extension/lib/cdp-session.js');
const { consoleByTab } = await import('../extension/lib/state.js');

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

describe('browser_console browser:true', () => {
  beforeEach(async () => {
    await detachCdp(3);
    sent.length = 0;
    consoleByTab.set(3, [{ level: 'warn', text: 'page warn', timestamp: 1, url: 'https://example.test/' }]);
    replay = [
      ['Log.entryAdded', { entry: notFound }],
      ['Log.entryAdded', { entry: { source: 'violation', level: 'verbose', text: 'Forced reflow while executing JavaScript took 40ms' } }],
      ['Audits.issueAdded', { issue: syncXhr }],
      ['Audits.issueAdded', { issue: formIssue('FormLabelForNameError') }],
    ];
  });

  it('adds what Chrome reported for the page next to the console messages', async () => {
    const res = await handleConsole({ tabId: 3, browser: true }) as any;
    expect(res.messages).toEqual([{ level: 'warn', text: 'page warn', timestamp: 1, url: 'https://example.test/' }]);
    expect(res.browser.messages.map((m: any) => `${m.level}:${m.source}`)).toEqual(['error:network', 'debug:violation']);
    expect(res.browser.issues.map((i: any) => i.type)).toEqual(['XHRSyncMainThread', 'FormLabelForNameError']);
  });

  it('applies level and pattern to Chrome messages too, and pattern to issues', async () => {
    const res = await handleConsole({ tabId: 3, browser: true, level: ['error', 'warn'], pattern: '404|XHR' }) as any;
    expect(res.messages).toEqual([]);
    expect(res.browser.messages.map((m: any) => m.source)).toEqual(['network']);
    expect(res.browser.issues.map((i: any) => i.type)).toEqual(['XHRSyncMainThread']);
  });

  it('never touches the debugger unless asked', async () => {
    const res = await handleConsole({ tabId: 3 }) as any;
    expect(res.browser).toBeUndefined();
    expect(sent).toEqual([]);
  });
});
