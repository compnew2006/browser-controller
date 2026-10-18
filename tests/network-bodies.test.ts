import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sent: string[] = [];
let emit: (source: { tabId: number }, method: string, params: unknown) => void = () => {};
let dropSession: (source: { tabId: number }) => void = () => {};
const bodies: Record<string, string> = {};
(globalThis as any).chrome = {
  tabs: { get: async (id: number) => ({ id, url: 'https://example.test/', windowId: 1 }), onRemoved: { addListener: () => {} } },
  windows: { get: async () => ({ width: 1280, height: 900 }) },
  storage: { session: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({}), set: async () => {} } },
  debugger: {
    attach: async () => {},
    detach: async () => { sent.push('detach'); },
    sendCommand: async (_t: unknown, method: string, params: any) => {
      sent.push(method);
      if (method === 'Network.getResponseBody') return { body: bodies[params.requestId], base64Encoded: false };
      return { result: { value: 1 } };
    },
    onEvent: { addListener: (fn: typeof emit) => { emit = fn; } },
    onDetach: { addListener: (fn: typeof dropSession) => { dropSession = fn; } },
  },
};

const { handleNetwork } = await import('../extension/handlers/tabs.js');
const { networkByTab, bodyCaptureByTab, getTabBuffer, dropTabState } = await import('../extension/lib/state.js');
const { detachCdp, hasCdp, IDLE_MS } = await import('../extension/lib/cdp-session.js');

const TAB = 7;
const WALL = 1_700_000_000; // seconds, as CDP sends wallTime

/** One XHR as both sources see it: CDP events (with the body) and the webRequest buffer entry. */
async function apiCall(cdpId: string, webId: string, url: string, body: string, at = WALL) {
  bodies[cdpId] = body;
  emit({ tabId: TAB }, 'Network.requestWillBeSent', { requestId: cdpId, request: { url, method: 'GET' }, wallTime: at, type: 'XHR' });
  emit({ tabId: TAB }, 'Network.responseReceived', { requestId: cdpId, response: { status: 200, mimeType: 'application/json' } });
  emit({ tabId: TAB }, 'Network.loadingFinished', { requestId: cdpId });
  await vi.advanceTimersByTimeAsync(0);
  getTabBuffer(networkByTab, TAB).push({ id: webId, method: 'GET', url, status: 200, type: 'xmlhttprequest', timestamp: at * 1000 + 12, durationMs: 10 });
}

describe('browser_network captureBodies', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    dropTabState(TAB);
    await detachCdp(TAB);
    sent.length = 0;
  });
  afterEach(() => { vi.useRealTimers(); });

  it('says how to get a body while capture is off', async () => {
    getTabBuffer(networkByTab, TAB).push({ id: '1', method: 'GET', url: 'https://example.test/api', status: 200, type: 'xmlhttprequest', timestamp: 5, durationMs: 1 });
    const one = await handleNetwork({ tabId: TAB, requestId: '1' }) as any;
    expect(one.request.responseBody.unavailable).toMatch(/captureBodies: true/);
    expect(one.bodyCapture).toBeUndefined();
    expect(sent).toEqual([]); // reading never touches the debugger
  });

  it('captures bodies from then on, marks them in the list and returns them by requestId', async () => {
    const started = await handleNetwork({ tabId: TAB, captureBodies: true }) as any;
    expect(sent).toContain('Network.enable');
    expect(started.bodyCapture).toEqual({ active: true, bodies: 0 });
    await apiCall('c1', '41', 'https://example.test/api/items', '{"items":[1,2]}');
    getTabBuffer(networkByTab, TAB).push({ id: '42', method: 'GET', url: 'https://example.test/app.js', status: 200, type: 'script', timestamp: WALL * 1000, durationMs: 3 });

    const list = await handleNetwork({ tabId: TAB }) as any;
    expect(list.requests.map((r: any) => [r.id, !!r.hasBody])).toEqual([['41', true], ['42', false]]);
    expect(list.bodyCapture).toEqual({ active: true, bodies: 1 });

    const one = await handleNetwork({ tabId: TAB, requestId: '41' }) as any;
    expect(one.request.responseBody).toMatchObject({ text: '{"items":[1,2]}', status: 200, mimeType: 'application/json', length: 15 });
    expect((await handleNetwork({ tabId: TAB, requestId: '42' }) as any).request.responseBody.unavailable).toMatch(/^Not captured/);
  });

  it('keeps the debugger attached while capturing, and lets it idle out after captureBodies:false', async () => {
    await handleNetwork({ tabId: TAB, captureBodies: true });
    await vi.advanceTimersByTimeAsync(IDLE_MS * 3);
    expect(hasCdp(TAB)).toBe(true);

    const stopped = await handleNetwork({ tabId: TAB, captureBodies: false }) as any;
    expect(stopped.bodyCapture).toEqual({ active: false, bodies: 0 });
    expect(sent).not.toContain('Network.disable'); // browser_emulate throttling shares the domain
    await apiCall('c2', '43', 'https://example.test/api/late', '{}');
    expect(bodyCaptureByTab.get(TAB)!.bodies.size).toBe(0); // events after stop are ignored
    await vi.advanceTimersByTimeAsync(IDLE_MS + 1);
    expect(hasCdp(TAB)).toBe(false);
  });

  it('reports capture as stopped once the debugger session detaches (banner closed)', async () => {
    await handleNetwork({ tabId: TAB, captureBodies: true });
    await apiCall('c3', '44', 'https://example.test/api/a', '{"a":1}');
    dropSession({ tabId: TAB });
    const after = await handleNetwork({ tabId: TAB, requestId: '44' }) as any;
    expect(after.bodyCapture).toEqual({ active: false, bodies: 1 });
    expect(after.request.responseBody.text).toBe('{"a":1}'); // what was captured stays readable

    await handleNetwork({ tabId: TAB, captureBodies: true }); // restart re-enables on the new session
    expect(sent.filter((m) => m === 'Network.enable')).toHaveLength(2);
    expect((await handleNetwork({ tabId: TAB }) as any).bodyCapture.active).toBe(true);
  });

  it('clear:true drops the captured bodies with the requests', async () => {
    await handleNetwork({ tabId: TAB, captureBodies: true });
    await apiCall('c4', '45', 'https://example.test/api/b', '{"b":2}');
    await handleNetwork({ tabId: TAB, clear: true });
    expect(bodyCaptureByTab.get(TAB)!.bodies.size).toBe(0);
    expect(getTabBuffer(networkByTab, TAB)).toHaveLength(0);
  });
});
