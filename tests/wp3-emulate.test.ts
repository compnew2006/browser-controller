import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * browser_emulate (WP3): overrides are lost when Chrome ends the debugger
 * session (banner dismissed, DevTools opened). The next call reports them under
 * `lost` with a warning and does not silently re-apply them. about:blank is
 * allowed. A userAgent override carries the real browser's client hints, so
 * navigator.userAgentData keeps its brands.
 */

const env = vi.hoisted(() => ({
  url: 'https://example.test/',
  sent: [] as Array<[string, unknown]>,
  detachListeners: [] as Array<(source: { tabId: number }, reason?: string) => void>,
}));

(globalThis as unknown as { chrome: unknown }).chrome = {
  tabs: { get: async (id: number) => ({ id, url: env.url, windowId: 1 }), onRemoved: { addListener: () => {} } },
  windows: { get: async () => ({ width: 1280, height: 900 }) },
  debugger: {
    attach: async () => {},
    detach: async () => { env.sent.push(['detach', null]); },
    sendCommand: async (_t: unknown, method: string, params: unknown) => {
      env.sent.push([method, params]);
      return { result: { value: 1 } };
    },
    onEvent: { addListener: () => {} },
    onDetach: { addListener: (fn: (typeof env.detachListeners)[number]) => { env.detachListeners.push(fn); } },
  },
  storage: { session: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({}), set: async () => {} } },
};

const { handleEmulate } = await import('../extension/handlers/emulate.js');
const { detachCdp, hasCdp, IDLE_MS } = await import('../extension/lib/cdp-session.js');

const sentOf = (method: string) => env.sent.filter(([m]) => m === method).map(([, p]) => p);
const detachTab = (tabId: number, reason: string) => {
  for (const fn of env.detachListeners) fn({ tabId }, reason);
};

// A real browser's client hints, as navigator.userAgentData reports them in the extension's service worker.
const realClientHints = {
  brands: [{ brand: 'HeadlessChrome', version: '153' }, { brand: 'Not_A Brand', version: '8' }, { brand: 'Chromium', version: '153' }],
  getHighEntropyValues: async () => ({
    platform: 'macOS', platformVersion: '15.0.0', architecture: 'arm', model: '', mobile: false, bitness: '64', wow64: false,
    fullVersionList: [{ brand: 'Chromium', version: '153.0.8010.12' }],
  }),
};
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const setNavigator = (value: unknown) => Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });

describe('browser_emulate after the debugger session is lost', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    env.url = 'https://example.test/';
    env.sent.length = 0;
    await detachCdp(4);
    env.sent.length = 0;
  });
  afterEach(() => { vi.useRealTimers(); });

  it('reports overrides that vanished with the banner, once, and does not re-apply them', async () => {
    await handleEmulate({ tabId: 4, network: 'offline', colorScheme: 'dark' });
    env.sent.length = 0;
    detachTab(4, 'canceled_by_user');

    const res = await handleEmulate({ tabId: 4 }) as Record<string, unknown>;
    expect(res).toMatchObject({ success: true, active: {}, lost: ['network', 'colorScheme'] });
    expect(String(res.warning)).toMatch(/banner was dismissed/);
    expect(String(res.warning)).toMatch(/not re-applied/);
    expect(env.sent).toEqual([]); // a read attaches nothing and re-sends nothing

    expect(await handleEmulate({ tabId: 4 })).toEqual({ success: true, active: {} });
  });

  it('reports the loss on the next call that changes settings, and starts from what is really active', async () => {
    await handleEmulate({ tabId: 4, cpuThrottling: 4 });
    detachTab(4, 'replaced_with_devtools');
    const res = await handleEmulate({ tabId: 4, colorScheme: 'dark' }) as Record<string, unknown>;
    expect(res).toMatchObject({ success: true, active: { colorScheme: 'dark' }, lost: ['cpuThrottling'] });
    expect(String(res.warning)).toMatch(/DevTools/);
  });

  it('reset clears a pending loss without reporting it', async () => {
    await handleEmulate({ tabId: 4, cpuThrottling: 4 });
    detachTab(4, 'canceled_by_user');
    expect(await handleEmulate({ tabId: 4, reset: true })).toEqual({ success: true, active: {} });
    expect(await handleEmulate({ tabId: 4 })).toEqual({ success: true, active: {} });
  });

  it('keeps overrides attached past the idle timeout (no loss while they are set)', async () => {
    await handleEmulate({ tabId: 4, cpuThrottling: 4 });
    await vi.advanceTimersByTimeAsync(IDLE_MS * 3);
    expect(hasCdp(4)).toBe(true);
  });
});

describe('browser_emulate targets', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    env.url = 'https://example.test/';
    env.sent.length = 0;
    await detachCdp(5);
    env.sent.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
  });

  it('allows an about:blank tab', async () => {
    env.url = 'about:blank';
    const res = await handleEmulate({ tabId: 5, cpuThrottling: 2 });
    expect(res).toMatchObject({ success: true, active: { cpuThrottling: 2 } });
  });

  it('still refuses browser-internal pages', async () => {
    env.url = 'chrome://settings/';
    await expect(handleEmulate({ tabId: 5, cpuThrottling: 2 })).rejects.toThrow(/protected page/);
  });

  it('sends the real browser client hints with a userAgent override', async () => {
    setNavigator({ userAgentData: realClientHints });
    await handleEmulate({ tabId: 5, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) TestUA/1.0' });
    const [params] = sentOf('Emulation.setUserAgentOverride') as Array<Record<string, unknown>>;
    expect(params.userAgent).toBe('Mozilla/5.0 (X11; Linux x86_64) TestUA/1.0');
    expect(params.userAgentMetadata).toEqual({
      brands: realClientHints.brands,
      fullVersionList: [{ brand: 'Chromium', version: '153.0.8010.12' }],
      platform: 'macOS', platformVersion: '15.0.0', architecture: 'arm', model: '', mobile: false, bitness: '64', wow64: false,
    });
  });

  it('sends a userAgent override without metadata when the browser exposes no client hints', async () => {
    setNavigator({});
    await handleEmulate({ tabId: 5, userAgent: 'Mozilla/5.0 TestUA/1.0' });
    expect(sentOf('Emulation.setUserAgentOverride')).toEqual([{ userAgent: 'Mozilla/5.0 TestUA/1.0' }]);
  });

  it('clearing the userAgent sends no metadata', async () => {
    setNavigator({ userAgentData: realClientHints });
    await handleEmulate({ tabId: 5, userAgent: '' });
    expect(sentOf('Emulation.setUserAgentOverride')).toEqual([{ userAgent: '' }]);
  });
});
