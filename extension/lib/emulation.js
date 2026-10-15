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

/**
 * Commands for the requested settings and the resulting active state.
 * Settings merge with `active`; "none", rate 1, null and "" clear their override.
 */
export function emulationPlan(params, active) {
  const state = { ...active };
  const commands = [];

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
    commands.push(['Emulation.setUserAgentOverride', { userAgent: params.userAgent }]);
    if (params.userAgent === '') delete state.userAgent;
    else state.userAgent = params.userAgent;
  }

  return { commands, state };
}
