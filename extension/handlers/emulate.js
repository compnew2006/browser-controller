/**
 * browser_emulate: network / CPU throttling, geolocation, color scheme,
 * reduced motion and user agent for one tab, through its debugger session.
 * The session stays attached while an override is active (an idle detach
 * would silently drop them); reset detaches it, which clears everything.
 */
import { resolveTab } from '../lib/page-exec.js';
import { withCdp, detachCdp, getCdpEmulation, setCdpEmulation } from '../lib/cdp-session.js';
import { emulationPlan } from '../lib/emulation.js';

export async function handleEmulate(params) {
  const { tabId, reset = false } = params;
  const tab = await resolveTab(tabId);
  if (/^(chrome|chrome-extension|devtools|edge|about):/i.test(tab.url || '')) {
    throw new Error(`Cannot access protected page (${tab.url}). Tab ${tabId} is a browser-internal page.`);
  }
  if (reset) {
    await detachCdp(tabId);
    return { success: true, active: {} };
  }
  const plan = emulationPlan(params, getCdpEmulation(tabId)); // validates before attaching
  if (!plan.commands.length) return { success: true, active: plan.state };
  await withCdp(tabId, async (send) => {
    for (const [method, args] of plan.commands) await send(method, args);
  });
  setCdpEmulation(tabId, plan.state);
  return {
    success: true,
    active: plan.state,
    ...(Object.keys(plan.state).length
      ? { note: 'Active while the debugger session stays attached (yellow banner); reset:true clears everything.' }
      : {}),
  };
}
