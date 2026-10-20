/**
 * browser_emulate settings → CDP commands (pure). The handler runs them on the
 * tab's debugger session and keeps that session attached while anything is
 * active: Chrome drops every override when the debugger detaches.
 */

/** Chrome DevTools' throttling presets (throughput in bytes/s, latency in ms). */
export const NETWORK_PRESETS = Object.freeze({
  offline: { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
  'slow-3g': { offline: false, latency: 2000, downloadThroughput: 50_000, uploadThroughput: 50_000 },
  'fast-3g': { offline: false, latency: 563, downloadThroughput: 180_000, uploadThroughput: 84_375 },
  none: { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
});

/** Largest viewport side a page may be given, in CSS px. */
const MAX_VIEWPORT_PX = 10_000;
const isViewportSize = (n) => Number.isInteger(n) && n >= 1 && n <= MAX_VIEWPORT_PX;

/**
 * The Emulation.UserAgentMetadata that matches a real browser's client hints. A bare
 * userAgent override makes Chrome empty navigator.userAgentData (brands and platform
 * included), so the override carries the real browser's values instead.
 */
export function userAgentMetadataFrom(real) {
  const pairs = (list) => (Array.isArray(list) ? list.map(({ brand, version }) => ({ brand, version })) : []);
  const metadata = {
    brands: pairs(real.brands),
    fullVersionList: pairs(real.fullVersionList),
    platform: real.platform || '',
    platformVersion: real.platformVersion || '',
    architecture: real.architecture || '',
    model: real.model || '',
    mobile: Boolean(real.mobile),
  };
  if (real.bitness) metadata.bitness = real.bitness;
  if (typeof real.wow64 === 'boolean') metadata.wow64 = real.wow64;
  return metadata;
}

/**
 * Commands for the requested settings and the resulting active state.
 * Settings merge with `active`; "none", rate 1, null and "" clear their override.
 * `viewport` sets the page's CSS viewport without resizing the window; null clears it.
 * `userAgentMetadata` (from userAgentMetadataFrom) rides along with a non-empty userAgent.
 */
export function emulationPlan(params, active, { userAgentMetadata } = {}) {
  const state = { ...active };
  const commands = [];

  if (params.viewport !== undefined) {
    if (params.viewport === null) {
      commands.push(['Emulation.clearDeviceMetricsOverride', {}]);
      delete state.viewport;
    } else {
      const { width, height, deviceScaleFactor = 1, mobile = false } = params.viewport;
      if (!isViewportSize(width) || !isViewportSize(height)) {
        throw new Error(`INVALID_ARGUMENT: viewport needs whole-pixel width and height from 1 to ${MAX_VIEWPORT_PX}.`);
      }
      if (!(deviceScaleFactor > 0 && deviceScaleFactor <= 10)) {
        throw new Error('INVALID_ARGUMENT: viewport deviceScaleFactor must be above 0 and at most 10.');
      }
      const viewport = { width, height, deviceScaleFactor, mobile: Boolean(mobile) };
      commands.push(['Emulation.setDeviceMetricsOverride', viewport]);
      state.viewport = viewport;
    }
  }

  if (params.network !== undefined) {
    const preset = NETWORK_PRESETS[params.network];
    if (!preset) throw new Error(`Unknown network preset "${params.network}". Use ${Object.keys(NETWORK_PRESETS).join(', ')}.`);
    commands.push(['Network.enable', {}], ['Network.emulateNetworkConditions', preset]);
    if (params.network === 'none') delete state.network;
    else state.network = params.network;
  }

  if (params.cpuThrottling !== undefined) {
    commands.push(['Emulation.setCPUThrottlingRate', { rate: params.cpuThrottling }]);
    if (params.cpuThrottling <= 1) delete state.cpuThrottling;
    else state.cpuThrottling = params.cpuThrottling;
  }

  if (params.geolocation === null) {
    commands.push(['Emulation.clearGeolocationOverride', {}]);
    delete state.geolocation;
  } else if (params.geolocation !== undefined) {
    const { latitude, longitude, accuracy = 100 } = params.geolocation;
    commands.push(['Emulation.setGeolocationOverride', { latitude, longitude, accuracy }]);
    state.geolocation = { latitude, longitude, accuracy };
  }

  // setEmulatedMedia replaces every feature at once: send both, merged.
  if (params.colorScheme !== undefined || params.reducedMotion !== undefined) {
    for (const key of ['colorScheme', 'reducedMotion']) {
      if (params[key] === undefined) continue;
      if (params[key] === 'none') delete state[key];
      else state[key] = params[key];
    }
    commands.push(['Emulation.setEmulatedMedia', { features: [
      { name: 'prefers-color-scheme', value: state.colorScheme || '' },
      { name: 'prefers-reduced-motion', value: state.reducedMotion || '' },
    ] }]);
  }

  if (params.userAgent !== undefined) {
    const override = { userAgent: params.userAgent };
    if (params.userAgent !== '' && userAgentMetadata) override.userAgentMetadata = userAgentMetadata;
    commands.push(['Emulation.setUserAgentOverride', override]);
    if (params.userAgent === '') delete state.userAgent;
    else state.userAgent = params.userAgent;
  }

  return { commands, state };
}
