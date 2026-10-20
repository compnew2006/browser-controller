import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sent: Array<[string, unknown]> = [];
let tabUrl = 'https://example.test/';
/** What the page's layout probe (Runtime.evaluate innerWidth*innerHeight) answers: 0 = never laid out. */
let layoutValue = 1;
const detachListeners: Array<(source: { tabId: number }, reason?: string) => void> = [];
const eventListeners: Array<(source: { tabId: number }, method: string, params?: unknown) => void> = [];
(globalThis as any).chrome = {
  tabs: { get: async (id: number) => ({ id, url: tabUrl, windowId: 1 }), onRemoved: { addListener: () => {} } },
  windows: { get: async () => ({ width: 1280, height: 900 }) },
  storage: { session: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({}), set: async () => {} } },
  debugger: {
    attach: async () => {},
    detach: async () => { sent.push(['detach', null]); },
    sendCommand: async (_t: unknown, method: string, params: unknown) => { sent.push([method, params]); return { result: { value: layoutValue } }; },
    onEvent: { addListener: (fn: (source: { tabId: number }, method: string, params?: unknown) => void) => { eventListeners.push(fn); } },
    onDetach: { addListener: (fn: (source: { tabId: number }, reason?: string) => void) => { detachListeners.push(fn); } },
  },
};

const { emulationPlan, NETWORK_PRESETS } = await import('../extension/lib/emulation.js');
const { handleEmulate, clearEmulation } = await import('../extension/handlers/emulate.js');
const { detachCdp, hasCdp, pinCdp, withCdp, IDLE_MS } = await import('../extension/lib/cdp-session.js');

const detachTab = (tabId: number, reason: string) => {
  for (const fn of detachListeners) fn({ tabId }, reason);
};
const debuggerEvent = (tabId: number, method: string, params: unknown = {}) => {
  for (const fn of eventListeners) fn({ tabId }, method, params);
};
const emulationCalls = () => sent.filter(([m]) => /^(Network\.emulate|Emulation\.set(CPU|Geo|EmulatedMedia|UserAgent)|Emulation\.clearGeo)/.test(m));

describe('emulation plan (settings → CDP commands)', () => {
  it('maps presets and merges with what is already active', () => {
    const first = emulationPlan({ network: 'slow-3g', cpuThrottling: 4 }, {});
    expect(first.state).toEqual({ network: 'slow-3g', cpuThrottling: 4 });
    expect(first.commands).toEqual([
      ['Network.enable', {}],
      ['Network.emulateNetworkConditions', NETWORK_PRESETS['slow-3g']],
      ['Emulation.setCPUThrottlingRate', { rate: 4 }],
    ]);
    const second = emulationPlan({ colorScheme: 'dark' }, first.state);
    expect(second.state).toEqual({ network: 'slow-3g', cpuThrottling: 4, colorScheme: 'dark' });
    expect(second.commands).toEqual([
      ['Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }, { name: 'prefers-reduced-motion', value: '' }] }],
    ]);
  });

  it('"none", rate 1, null and "" clear their override', () => {
    const active = { network: 'offline', cpuThrottling: 6, geolocation: { latitude: 1, longitude: 2, accuracy: 100 }, colorScheme: 'dark', reducedMotion: 'reduce', userAgent: 'Bot/1' };
    const plan = emulationPlan({ network: 'none', cpuThrottling: 1, geolocation: null, colorScheme: 'none', userAgent: '' }, active);
    expect(plan.state).toEqual({ reducedMotion: 'reduce' });
    expect(plan.commands).toContainEqual(['Network.emulateNetworkConditions', NETWORK_PRESETS.none]);
    expect(plan.commands).toContainEqual(['Emulation.setCPUThrottlingRate', { rate: 1 }]);
    expect(plan.commands).toContainEqual(['Emulation.clearGeolocationOverride', {}]);
    expect(plan.commands).toContainEqual(['Emulation.setUserAgentOverride', { userAgent: '' }]);
    expect(plan.commands).toContainEqual(['Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: '' }, { name: 'prefers-reduced-motion', value: 'reduce' }] }]);
  });

  it('geolocation defaults its accuracy; nothing asked means nothing sent', () => {
    expect(emulationPlan({ geolocation: { latitude: 24.7, longitude: 46.7 } }, {}).commands)
      .toEqual([['Emulation.setGeolocationOverride', { latitude: 24.7, longitude: 46.7, accuracy: 100 }]]);
    expect(emulationPlan({}, { cpuThrottling: 2 })).toEqual({ commands: [], state: { cpuThrottling: 2 } });
  });

  it('rejects an unknown network preset', () => {
    expect(() => emulationPlan({ network: '5g' }, {})).toThrow(/Unknown network preset "5g"/);
  });
});

describe('browser_emulate', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    await detachCdp(4);
    sent.length = 0;
    tabUrl = 'https://example.test/';
    layoutValue = 1;
  });
  afterEach(() => { vi.useRealTimers(); });

  it('applies overrides and keeps the debugger session attached past the idle timeout', async () => {
    const res = await handleEmulate({ tabId: 4, network: 'offline', colorScheme: 'dark' }) as any;
    expect(res).toMatchObject({ success: true, active: { network: 'offline', colorScheme: 'dark' } });
    expect(emulationCalls().map(([m]) => m)).toEqual(['Network.emulateNetworkConditions', 'Emulation.setEmulatedMedia']);
    await vi.advanceTimersByTimeAsync(IDLE_MS * 3);
    expect(hasCdp(4)).toBe(true); // an idle detach would silently drop the overrides
    expect((await handleEmulate({ tabId: 4 }) as any).active).toEqual({ network: 'offline', colorScheme: 'dark' });
  });

  it('reset detaches the session, which clears every override', async () => {
    await handleEmulate({ tabId: 4, cpuThrottling: 4 });
    const res = await handleEmulate({ tabId: 4, reset: true }) as any;
    expect(res).toMatchObject({ success: true, active: {} });
    expect(hasCdp(4)).toBe(false);
    expect(sent.some(([m]) => m === 'detach')).toBe(true);
  });

  it('reset clears each override on the session before detaching (a bare detach can leave the viewport)', async () => {
    await handleEmulate({ tabId: 4, viewport: { width: 500, height: 700 }, cpuThrottling: 4 });
    sent.length = 0;
    await handleEmulate({ tabId: 4, reset: true });
    const methods = sent.map(([m]) => m);
    expect(methods).toContain('Emulation.clearDeviceMetricsOverride');
    expect(methods).toContain('Emulation.setCPUThrottlingRate');
    expect(methods.indexOf('Emulation.clearDeviceMetricsOverride')).toBeLessThan(methods.indexOf('detach'));
    expect(methods.indexOf('Emulation.setCPUThrottlingRate')).toBeLessThan(methods.indexOf('detach'));
  });

  it('reset reports what it cleared, not "no overrides"', async () => {
    await handleEmulate({ tabId: 4, viewport: { width: 500, height: 700 }, cpuThrottling: 4 });
    const res = await handleEmulate({ tabId: 4, reset: true }) as Record<string, unknown>;
    expect(res).toMatchObject({ success: true, active: {}, cleared: ['viewport', 'cpuThrottling'] });
    expect(res.text).toBe('cleared:\nviewport 500x700@1\ncpu 4x slower');
  });

  it('reset of a tab that was never laid out leaves it sized to its window, not 0x0', async () => {
    await handleEmulate({ tabId: 4, viewport: { width: 500, height: 700 } });
    layoutValue = 0;
    sent.length = 0;
    await handleEmulate({ tabId: 4, reset: true });
    const methods = sent.map(([m]) => m);
    const cleared = methods.indexOf('Emulation.clearDeviceMetricsOverride');
    const resized = methods.indexOf('Emulation.setDeviceMetricsOverride');
    expect(cleared).toBeGreaterThanOrEqual(0);
    expect(resized).toBeGreaterThan(cleared);
    expect(resized).toBeLessThan(methods.indexOf('detach'));
  });

  it('reset does not detach under a CDP call still in flight; the idle timer detaches once it ends', async () => {
    await handleEmulate({ tabId: 4, cpuThrottling: 4 });
    let finish: () => void = () => {};
    const inFlight = withCdp(4, () => new Promise<void>((resolve) => { finish = resolve; }));
    const res = await handleEmulate({ tabId: 4, reset: true }) as Record<string, unknown>;
    expect(res).toMatchObject({ success: true, active: {} });
    expect(sent.some(([m]) => m === 'detach')).toBe(false);
    expect(hasCdp(4)).toBe(true);
    finish();
    await inFlight;
    await vi.advanceTimersByTimeAsync(IDLE_MS + 1000);
    expect(hasCdp(4)).toBe(false);
  });

  it('reset does not detach while a mock or body capture pins the session', async () => {
    await handleEmulate({ tabId: 4, cpuThrottling: 4 });
    pinCdp(4, 'browser-mock');
    await handleEmulate({ tabId: 4, reset: true });
    expect(sent.some(([m]) => m === 'detach')).toBe(false);
    expect(hasCdp(4)).toBe(true);
  });

  it('reset does not detach while a JavaScript dialog is open on the tab; closing it lets the idle timer detach', async () => {
    await handleEmulate({ tabId: 4, colorScheme: 'dark' });
    debuggerEvent(4, 'Page.javascriptDialogOpening', { type: 'alert', message: 'hi', url: 'https://example.test/' });
    await handleEmulate({ tabId: 4, reset: true });
    expect(sent.some(([m]) => m === 'detach')).toBe(false);
    expect(hasCdp(4)).toBe(true);
    debuggerEvent(4, 'Page.javascriptDialogClosed', {});
    await vi.advanceTimersByTimeAsync(IDLE_MS + 1000);
    expect(hasCdp(4)).toBe(false);
  });

  it('clearEmulation clears every override and detaches an idle tab', async () => {
    await handleEmulate({ tabId: 4, network: 'offline', colorScheme: 'dark' });
    await clearEmulation(4);
    expect(hasCdp(4)).toBe(false);
    expect(await handleEmulate({ tabId: 4 })).toMatchObject({ success: true, active: {}, text: 'no overrides' });
  });

  it('clearEmulation never throws on a tab with no session or a detached one', async () => {
    await expect(clearEmulation(77)).resolves.toEqual({});
    await handleEmulate({ tabId: 4, cpuThrottling: 4 });
    detachTab(4, 'target_closed');
    await expect(clearEmulation(4)).resolves.toEqual({});
  });

  it('reset keeps a session a body capture or mock is using: each override is cleared instead', async () => {
    await handleEmulate({ tabId: 4, cpuThrottling: 4, colorScheme: 'dark' });
    pinCdp(4, 'network-bodies');
    sent.length = 0;
    expect(await handleEmulate({ tabId: 4, reset: true })).toMatchObject({ success: true, active: {}, text: 'cleared:\ncpu 4x slower\ncolor scheme dark' });
    expect(hasCdp(4)).toBe(true);
    expect(sent.some(([m]) => m === 'detach')).toBe(false);
    expect(emulationCalls()).toEqual([
      ['Emulation.setCPUThrottlingRate', { rate: 1 }],
      ['Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: '' }, { name: 'prefers-reduced-motion', value: '' }] }],
    ]);
  });

  it('once nothing is active the session goes back to the normal idle detach', async () => {
    await handleEmulate({ tabId: 4, cpuThrottling: 4 });
    expect((await handleEmulate({ tabId: 4, cpuThrottling: 1 }) as any).active).toEqual({});
    await vi.advanceTimersByTimeAsync(IDLE_MS + 1000);
    expect(hasCdp(4)).toBe(false);
  });

  it('only reports (without attaching) when no setting is given', async () => {
    expect(await handleEmulate({ tabId: 4 })).toMatchObject({ success: true, active: {}, text: 'no overrides' });
    expect(sent).toEqual([]);
  });

  it('refuses browser-internal pages', async () => {
    tabUrl = 'chrome://settings/';
    await expect(handleEmulate({ tabId: 4, network: 'offline' })).rejects.toThrow(/protected page/);
  });
});
