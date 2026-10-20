/**
 * browser_emulate: network / CPU throttling, geolocation, color scheme,
 * reduced motion and user agent for one tab, through its debugger session.
 * The session stays attached while an override is active (an idle detach
 * would silently drop them); reset detaches it, which clears everything.
 * When Chrome ends the session anyway (banner dismissed, DevTools opened), the
 * overrides it dropped are reported as `lost` on the next call; they are not
 * re-applied behind the user's back.
 */
import { resolveTab } from '../lib/page-exec.js';
import {
  withCdp, detachCdp, getCdpEmulation, setCdpEmulation,
  getLostEmulation, clearLostEmulation, clearCdpEmulation,
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

export async function handleEmulate(params) {
  const { tabId, reset = false } = params;
  const tab = await resolveTab(tabId);
  if (isProtectedUrl(tab.url)) {
    throw new Error(`Cannot access protected page (${tab.url}). Tab ${tabId} is a browser-internal page.`);
  }
  if (reset) {
    clearCdpEmulation(tabId);
    await detachCdp(tabId);
    return { success: true, active: {} };
  }
  const lost = getLostEmulation(tabId);
  const userAgentMetadata = params.userAgent ? await realUserAgentMetadata() : undefined;
  const plan = emulationPlan(params, getCdpEmulation(tabId), { userAgentMetadata }); // validates before attaching
  if (plan.commands.length) {
    await withCdp(tabId, async (send) => {
      for (const [method, args] of plan.commands) await send(method, args);
    });
    setCdpEmulation(tabId, plan.state);
  }
  if (lost) clearLostEmulation(tabId);
  const lostReport = lost
    ? { lost: Object.keys(lost.state), warning: LOST_REASON[lost.reason] || `The debugger session ended, so Chrome removed these overrides. ${LOST_NOTE}` }
    : {};
  return {
    success: true,
    active: plan.state,
    ...lostReport,
    ...(plan.commands.length && Object.keys(plan.state).length
      ? { note: 'Active while the debugger session stays attached (yellow banner); reset:true clears everything.' }
      : {}),
  };
}
