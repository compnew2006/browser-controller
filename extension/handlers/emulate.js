/**
 * browser_emulate: viewport, network / CPU throttling, geolocation, color scheme,
 * reduced motion and user agent for one tab, through its debugger session.
 * The session stays attached while an override is active (an idle detach
 * would silently drop them). reset clears each override explicitly first (a
 * bare detach can leave a viewport behind), then detaches — unless a body
 * capture or a mock is using the session, which then keeps it attached.
 * When Chrome ends the session anyway (banner dismissed, DevTools opened), the
 * overrides it dropped are reported as `lost` on the next call; they are not
 * re-applied behind the user's back.
 */
import { resolveTab } from '../lib/page-exec.js';
import {
  withCdp, detachCdp, getCdpEmulation, setCdpEmulation, hasCdp,
  getLostEmulation, clearLostEmulation, clearCdpEmulation, isCdpInUse, ensureViewport,
} from '../lib/cdp-session.js';
import { emulationPlan, userAgentMetadataFrom } from '../lib/emulation.js';

/** Browser-internal pages refuse a debugger; about:blank is an ordinary page to emulate. */
function isProtectedUrl(url) {
  return /^(chrome|chrome-extension|devtools|edge|about):/i.test(url || '') && url !== 'about:blank';
}

/** The real browser's client hints, as navigator.userAgentData reports them here; undefined when unavailable. */
async function realUserAgentMetadata() {
  const uad = globalThis.navigator?.userAgentData;
  if (!uad || typeof uad.getHighEntropyValues !== 'function') return undefined;
  try {
    const hints = await uad.getHighEntropyValues([
      'fullVersionList', 'platform', 'platformVersion', 'architecture', 'model', 'mobile', 'bitness', 'wow64',
    ]);
    return userAgentMetadataFrom({ ...hints, brands: uad.brands });
  } catch {
    return undefined;
  }
}

const LOST_NOTE = 'They were not re-applied; send the settings again if still needed.';
const LOST_REASON = {
  canceled_by_user: `The debugger banner was dismissed, so Chrome removed these overrides. ${LOST_NOTE}`,
  replaced_with_devtools: `DevTools was opened on this tab, so Chrome removed these overrides. ${LOST_NOTE}`,
};

/** The settings that clear each override emulationPlan knows. */
const CLEARED = { viewport: null, network: 'none', cpuThrottling: 1, geolocation: null, colorScheme: 'none', reducedMotion: 'none', userAgent: '' };

const lostWarningOf = (lost) => LOST_REASON[lost.reason] || `The debugger session ended, so Chrome removed these overrides. ${LOST_NOTE}`;

/** One line per active override, as the agent reads it. */
function activeLines(state) {
  const lines = [];
  if (state.viewport) {
    const { width, height, deviceScaleFactor, mobile } = state.viewport;
    lines.push(`viewport ${width}x${height}@${deviceScaleFactor}${mobile ? ' mobile' : ''}`);
  }
  if (state.network) lines.push(`network ${state.network}`);
  if (state.cpuThrottling) lines.push(`cpu ${state.cpuThrottling}x slower`);
  if (state.geolocation) lines.push(`geolocation ${state.geolocation.latitude}, ${state.geolocation.longitude}`);
  if (state.colorScheme) lines.push(`color scheme ${state.colorScheme}`);
  if (state.reducedMotion) lines.push(`reduced motion ${state.reducedMotion}`);
  if (state.userAgent) lines.push(`user agent ${state.userAgent.length > 80 ? `${state.userAgent.slice(0, 79)}…` : state.userAgent}`);
  return lines;
}

/**
 * A geolocation override reaches the page only once the site may read the location. Before that,
 * its first request waits on Chrome's permission prompt (for the user, not the agent) or fails.
 */
const GEOLOCATION_PERMISSION = {
  prompt: 'geolocation permission: not decided for this site. Its first location request shows Chrome\'s permission prompt and waits for the user: ask them to allow it, or the page gets no position.',
  denied: 'geolocation permission: blocked for this site. Its location requests fail with PERMISSION_DENIED whatever the override; the user can allow it in the site settings.',
};

/** The page's geolocation permission state ("granted", "prompt", "denied"), or undefined when the page cannot tell. */
async function geolocationPermission(send) {
  try {
    const res = await send('Runtime.evaluate', {
      expression: "navigator.permissions.query({ name: 'geolocation' }).then((s) => s.state)",
      awaitPromise: true,
      returnByValue: true,
    });
    return res?.result?.value;
  } catch {
    return undefined;
  }
}

/** The result: `text` is what the agent reads; `active` and `lost` are data. */
function report(active, lost, extra = {}, notes = []) {
  const lines = activeLines(active);
  if (lines.length === 0) lines.push('no overrides');
  lines.push(...notes);
  if (lost) lines.push(`lost: ${Object.keys(lost.state).join(', ')}. ${lostWarningOf(lost)}`);
  const lostReport = lost ? { lost: Object.keys(lost.state), warning: lostWarningOf(lost) } : {};
  return { success: true, text: lines.join('\n'), active, ...lostReport, ...extra };
}

/** Result of reset: the overrides it cleared (data), or "no overrides" when there were none. */
function resetReport(cleared) {
  const lines = activeLines(cleared);
  if (lines.length === 0) return report({}, null);
  return { success: true, text: ['cleared:', ...lines].join('\n'), active: {}, cleared: Object.keys(cleared) };
}

/**
 * Clear every override this handler can set on the tab, and forget them in the stored state. The
 * session is detached only when nothing else uses it: a CDP call in flight, a body capture or mock,
 * or an open dialog. Otherwise the idle timer detaches it once they end. A tab that is gone, or whose
 * session already ended (Chrome dropped the overrides with it), has nothing left to clear: this does
 * not throw for it. Returns the overrides that were set.
 */
export async function clearEmulation(tabId) {
  const active = getCdpEmulation(tabId);
  clearLostEmulation(tabId);
  if (Object.keys(active).length) {
    const plan = emulationPlan(Object.fromEntries(Object.keys(active).map((key) => [key, CLEARED[key]])), active);
    try {
      await withCdp(tabId, async (send) => {
        for (const [method, args] of plan.commands) await send(method, args);
        // Clearing a viewport override on a background tab that was never laid out would leave it 0x0 again.
        if (active.viewport) await ensureViewport(tabId).catch(() => {});
      });
    } catch (err) {
      if (hasCdp(tabId)) {
        throw new Error(`DEBUGGER_UNAVAILABLE: could not clear the overrides on tab ${tabId} (${err?.message || err}).`, { cause: err });
      }
      // The session ended meanwhile: Chrome has already dropped what it held.
    }
    setCdpEmulation(tabId, plan.state);
  }
  if (!isCdpInUse(tabId)) {
    clearCdpEmulation(tabId);
    await detachCdp(tabId);
  }
  return active;
}

export async function handleEmulate(params) {
  const { tabId, reset = false } = params;
  const tab = await resolveTab(tabId);
  if (isProtectedUrl(tab.url)) {
    throw new Error(`INVALID_ARGUMENT: Cannot access protected page (${tab.url}). Tab ${tabId} is a browser-internal page.`);
  }
  if (reset) return resetReport(await clearEmulation(tabId));
  const lost = getLostEmulation(tabId);
  const userAgentMetadata = params.userAgent ? await realUserAgentMetadata() : undefined;
  const plan = emulationPlan(params, getCdpEmulation(tabId), { userAgentMetadata }); // validates before attaching
  let permission;
  if (plan.commands.length) {
    await withCdp(tabId, async (send) => {
      for (const [method, args] of plan.commands) await send(method, args);
      if (params.geolocation) permission = await geolocationPermission(send);
    });
    setCdpEmulation(tabId, plan.state);
  }
  if (lost) clearLostEmulation(tabId);
  const blocked = GEOLOCATION_PERMISSION[permission];
  return report(plan.state, lost, {
    ...(plan.commands.length && Object.keys(plan.state).length
      ? { note: 'Active while the debugger session stays attached (yellow banner); reset:true clears everything.' }
      : {}),
    ...(blocked ? { permission } : {}),
  }, blocked ? [blocked] : []);
}
