import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sent: Array<[string, unknown]> = [];
let tabUrl = 'https://example.test/';
(globalThis as any).chrome = {
  tabs: { get: async (id: number) => ({ id, url: tabUrl, windowId: 1 }), onRemoved: { addListener: () => {} } },
  windows: { get: async () => ({ width: 1280, height: 900 }) },
  storage: { session: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({}), set: async () => {} } },
  debugger: {
    attach: async () => {},
    detach: async () => { sent.push(['detach', null]); },
    sendCommand: async (_t: unknown, method: string, params: unknown) => { sent.push([method, params]); return { result: { value: 1 } }; },
    onEvent: { addListener: () => {} },
    onDetach: { addListener: () => {} },
  },
};

const { emulationPlan, NETWORK_PRESETS } = await import('../extension/lib/emulation.js');
const { handleEmulate } = await import('../extension/handlers/emulate.js');
const { detachCdp, hasCdp, IDLE_MS } = await import('../extension/lib/cdp-session.js');

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

  it('once nothing is active the session goes back to the normal idle detach', async () => {
    await handleEmulate({ tabId: 4, cpuThrottling: 4 });
    expect((await handleEmulate({ tabId: 4, cpuThrottling: 1 }) as any).active).toEqual({});
    await vi.advanceTimersByTimeAsync(IDLE_MS + 1000);
    expect(hasCdp(4)).toBe(false);
  });

  it('only reports (without attaching) when no setting is given', async () => {
    expect(await handleEmulate({ tabId: 4 })).toEqual({ success: true, active: {} });
    expect(sent).toEqual([]);
  });

  it('refuses browser-internal pages', async () => {
    tabUrl = 'chrome://settings/';
    await expect(handleEmulate({ tabId: 4, network: 'offline' })).rejects.toThrow(/protected page/);
  });
});
