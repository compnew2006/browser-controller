/**
 * The in-page vault approval card (specs/006-vault-site-approval D4–D6). Injected as a classic script
 * into the top document's isolated world, it draws one card in a closed shadow root, in the top layer,
 * and accepts the owner's choice only from real input on a card that is visible and armed. The
 * background accepts that choice only from this tab, document and token; while the card shows, it
 * refuses the agent's CDP input to the tab.
 */
(() => {
  if (globalThis.__bcVaultCard) return;

  const ARM_MS = 600;
  const MAX_RESHOWS = 3;

  const STRINGS = {
    en: {
      brand: 'Credential vault',
      title: (agent, host) => `Allow ${agent} to use your saved sign-ins on ${host}?`,
      body: (profile) => `It can list and fill the accounts saved for this site in the “${profile}” profile until the vault locks. Passwords never reach the agent.`,
      account: (label) => `Account to fill: ${label}`,
      unlock: 'Allowing also unlocks the vault on this device.',
      always: 'Always allow this site',
      alwaysHint: 'Later requests from this site are approved without asking, and each one is logged.',
      allow: 'Allow',
      deny: 'Deny',
      page: 'Decide on the vault page',
      working: 'Saving your choice…',
      failed: 'Your choice could not be saved. Decide on the vault page instead.',
      covered: 'Something on the page covers this card. Move it out of the way, then choose again.',
      moved: 'This card just moved. Wait a moment, then choose again.',
      agentInput: 'The agent just acted on this page. Wait a moment, then choose again.',
      unfocused: 'Click inside this window first, then choose again.',
    },
    ar: {
      brand: 'خزنة بيانات الدخول',
      title: (agent, host) => `هل تسمح لـ ${agent} باستخدام بيانات الدخول المحفوظة على ${host}؟`,
      body: (profile) => `سيتمكن من عرض الحسابات المحفوظة لهذا الموقع في ملف «${profile}» وملئها حتى تُقفل الخزنة. كلمات المرور لا تصل إلى الوكيل أبدًا.`,
      account: (label) => `الحساب الذي سيُملأ: ${label}`,
      unlock: 'السماح يفتح الخزنة على هذا الجهاز أيضًا.',
      always: 'اسمح لهذا الموقع دائمًا',
      alwaysHint: 'الطلبات القادمة من هذا الموقع تُعتمد بدون سؤال، وكل طلب يُسجَّل.',
      allow: 'سماح',
      deny: 'رفض',
      page: 'القرار من صفحة الخزنة',
      working: 'جارٍ حفظ اختيارك…',
      failed: 'تعذّر حفظ اختيارك. اتخذ القرار من صفحة الخزنة.',
      covered: 'في الصفحة شيء يغطي هذه البطاقة. أبعده ثم اختر مرة أخرى.',
      moved: 'تحركت هذه البطاقة للتو. انتظر لحظة ثم اختر مرة أخرى.',
      agentInput: 'الوكيل تعامل مع الصفحة للتو. انتظر لحظة ثم اختر مرة أخرى.',
      unfocused: 'انقر داخل هذه النافذة أولًا ثم اختر مرة أخرى.',
    },
  };

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .card {
      --surface: #131316; --surface-2: #1b1b20; --border: #26262c; --border-2: #33333b;
      --ink: #ededf0; --ink-2: #a1a1aa; --ink-3: #8a8a96;
      --accent: #818cf8; --accent-2: #6264eb; --accent-soft: rgba(129, 140, 248, .12);
      --warn: #fbbf24; --err: #f87171;
      width: min(384px, calc(100vw - 24px));
      max-height: calc(100vh - 32px);
      overflow: auto;
      padding: 16px 16px 14px;
      border: 1px solid var(--border-2);
      border-radius: 12px;
      background: var(--surface);
      color: var(--ink);
      color-scheme: dark;
      font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans Arabic", Tahoma, sans-serif;
      -webkit-font-smoothing: antialiased;
      box-shadow: 0 22px 48px -14px rgba(0, 0, 0, .62), 0 3px 10px rgba(0, 0, 0, .34);
      animation: arrive 280ms cubic-bezier(.16, 1, .3, 1);
    }
    .card ::selection { background: rgba(129, 140, 248, .34); color: #fff; }
    /* A slide only: a card fading in reads as covered to the visibility check, which delays arming. */
    @keyframes arrive { from { transform: translateY(-8px); } }
    .brand { display: flex; align-items: center; gap: 8px; color: var(--ink-3); font-size: 11.5px; font-weight: 600; }
    .mark {
      display: grid; place-items: center; width: 24px; height: 24px; flex: none;
      border: 1px solid rgba(129, 140, 248, .28); border-radius: 7px;
      background: var(--accent-soft); color: var(--accent);
    }
    .mark svg { width: 14px; height: 14px; }
    h2 { margin: 12px 0 0; font-size: 15px; line-height: 1.35; font-weight: 640; letter-spacing: -.01em; text-wrap: balance; overflow-wrap: anywhere; }
    .origin { margin: 3px 0 0; color: var(--ink-3); font-size: 12px; direction: ltr; text-align: start; overflow-wrap: anywhere; unicode-bidi: plaintext; }
    p { margin: 0; }
    .body { margin-top: 10px; color: var(--ink-2); font-size: 12.5px; }
    .account {
      margin-top: 10px; padding: 7px 10px; border: 1px solid var(--border); border-radius: 7px;
      background: var(--surface-2); color: var(--ink); font-size: 12px; overflow-wrap: anywhere;
    }
    .unlock { display: flex; gap: 7px; margin-top: 10px; color: #fcd34d; font-size: 12px; }
    .unlock svg { width: 14px; height: 14px; flex: none; margin-top: 2px; color: var(--warn); }
    .always { display: grid; grid-template-columns: auto 1fr; column-gap: 8px; margin-top: 12px; color: var(--ink); font-size: 12.5px; font-weight: 550; cursor: pointer; }
    .always input { width: 15px; height: 15px; margin: 2px 0 0; accent-color: var(--accent-2); cursor: pointer; }
    .always small { grid-column: 2; color: var(--ink-3); font-size: 11.5px; font-weight: 450; }
    .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 14px; }
    button { font: inherit; }
    .button {
      position: relative; overflow: hidden;
      min-height: 34px; padding: 6px 14px;
      border: 1px solid var(--border-2); border-radius: 7px;
      background: var(--surface-2); color: var(--ink);
      font-size: 12.5px; font-weight: 620; cursor: pointer;
      transition: background 140ms ease, border-color 140ms ease, opacity 140ms ease;
    }
    .button:hover:not(:disabled) { border-color: #555563; background: #222229; }
    .button.primary { border-color: var(--accent-2); background: var(--accent-2); color: #fff; }
    .button.primary:hover:not(:disabled) { border-color: var(--accent); background: #5558e7; }
    .button:disabled { cursor: default; opacity: .5; }
    .card[data-arming] .button.primary { opacity: 1; }
    .card[data-arming] .button.primary::after {
      content: ""; position: absolute; inset-inline-start: 0; bottom: 0; height: 2px; width: 100%;
      background: rgba(255, 255, 255, .7); transform-origin: left center; transform: scaleX(0);
    }
    .card[data-arming="run"] .button.primary::after { animation: arm ${ARM_MS}ms linear both; }
    .card[dir="rtl"][data-arming] .button.primary::after { transform-origin: right center; }
    @keyframes arm { from { transform: scaleX(0); } to { transform: scaleX(1); } }
    .link {
      margin-inline-start: auto; padding: 4px 2px; border: 0; background: none;
      color: var(--ink-2); font-size: 12px; font-weight: 550; cursor: pointer;
      text-decoration: underline; text-decoration-color: rgba(161, 161, 170, .4); text-underline-offset: 3px;
    }
    .link:hover:not(:disabled) { color: var(--ink); text-decoration-color: currentColor; }
    .link:disabled { cursor: default; opacity: .5; }
    .button:focus-visible, .link:focus-visible, .always input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .status { margin-top: 10px; color: var(--ink-2); font-size: 12px; }
    .status[data-kind="error"] { color: #fecaca; }
    .status:empty { display: none; }
    @media (prefers-reduced-motion: reduce) {
      .card, .card[data-arming="run"] .button.primary::after { animation: none; }
      .button { transition: none; }
    }
  `;

  const SVG_NS = 'http://www.w3.org/2000/svg';
  function icon(paths) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.6');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of paths) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      svg.append(path);
    }
    return svg;
  }
  const KEY_ICON = ['M10.2 2.2a3.6 3.6 0 1 1-2.9 5.8L3 12.3V14h1.8v-1.3h1.3v-1.3h1.4l1.3-1.3', 'M11.4 5.1h.01'];
  const LOCK_ICON = ['M4.5 7V5.2a3.5 3.5 0 0 1 6.9-.8', 'M3.5 7h9v6.5h-9z', 'M8 9.6v1.4'];

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  let current = null;

  function validConfig(config) {
    const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;
    return !!config && text(config.requestId, 200) && text(config.token, 200) && text(config.origin, 2048)
      && ['list', 'fill'].includes(config.purpose) && text(config.agentName, 120) && text(config.browserLabel, 120)
      && typeof config.unlock === 'boolean' && (config.account === undefined || text(config.account, 120))
      && Number.isSafeInteger(config.expiresAt) && config.expiresAt > Date.now();
  }

  function hostOf(origin) {
    try { return new URL(origin).host; } catch { return origin; }
  }

  /** A name inside a sentence of the other direction keeps its own order (FSI … PDI). */
  function isolate(text) {
    return `⁨${text}⁩`;
  }

  function teardown(state) {
    state.hiding = true;
    clearTimeout(state.expiry);
    clearTimeout(state.armTimer);
    clearTimeout(state.visibilityFallback);
    removeEventListener('resize', state.onResize);
    state.removal?.disconnect();
    state.attributes?.disconnect();
    state.visibility?.disconnect();
    try { if (state.host.matches(':popover-open')) state.host.hidePopover(); } catch { /* not in the top layer */ }
    state.host.remove();
    if (current === state) current = null;
  }

  function hide(requestId) {
    if (!current || (requestId !== undefined && current.config.requestId !== requestId)) return false;
    teardown(current);
    return true;
  }

  function send(state, decision, always, onAnswer) {
    let answered = false;
    const answer = (response) => {
      if (answered) return;
      answered = true;
      onAnswer?.(response && typeof response === 'object' ? response : { success: false });
    };
    try {
      chrome.runtime.sendMessage({
        type: 'vaultCardDecision', requestId: state.config.requestId, token: state.config.token, decision, always,
      }, (response) => answer(chrome.runtime.lastError ? { success: false } : response));
    } catch {
      answer({ success: false });
    }
  }

  function say(state, key, kind = 'error') {
    state.status.textContent = state.strings[key];
    state.status.dataset.kind = kind;
  }

  /** Where the card stands. Its height is left out: the card's own status line changes it, never the controls' place. */
  function rectOf(element) {
    const { left, top, width } = element.getBoundingClientRect();
    return [left, top, width].map(Math.round).join(',');
  }

  /** Choices wait: the buttons stay off until arm() has run its full time again. */
  function disarm(state) {
    clearTimeout(state.armTimer);
    state.armedAt = Infinity;
    state.card.dataset.arming = '';
    if (!state.pending) for (const control of state.buttons) control.disabled = true;
  }

  /** The card takes a choice once it has stood still, uncovered, for ARM_MS. */
  function arm(state) {
    disarm(state);
    void state.card.offsetWidth;
    state.card.dataset.arming = 'run';
    state.armedAt = Date.now() + ARM_MS;
    state.armTimer = setTimeout(() => {
      state.rect = rectOf(state.host);
      delete state.card.dataset.arming;
      if (!state.pending) for (const control of state.buttons) control.disabled = false;
    }, ARM_MS);
  }

  /** After a move, resize or change to the host: wait again, and only while the card can be seen. */
  function rearm(state) {
    if (state.hiding) return;
    if (!state.tracksVisibility || state.visible) arm(state);
    else disarm(state);
  }

  /**
   * Real input from the owner, on this card as the page shows it: never a script, the agent, a covered
   * card, or one the page moved under the pointer. `region` is the control the input must land on.
   */
  function trustedChoice(state, event, region) {
    if (!event.isTrusted || state.pending || state.hiding || Date.now() < state.armedAt) return false;
    if ((Number(window.__bcAgentInputUntil) || 0) > Date.now()) { say(state, 'agentInput'); return false; }
    if (!document.hasFocus()) { say(state, 'unfocused'); return false; }
    if (state.tracksVisibility && !state.visible) { say(state, 'covered'); return false; }
    if (state.rect !== rectOf(state.host)) { rearm(state); say(state, 'moved'); return false; }
    // A pointer click must land on this control through the page; a keyboard press (detail 0) has no point.
    if (event.detail > 0 && (event.clientX || event.clientY)) {
      const outer = document.elementFromPoint(event.clientX, event.clientY);
      const inner = state.root.elementFromPoint(event.clientX, event.clientY);
      if (outer !== state.host || !inner || !region.contains(inner)) { say(state, 'covered'); return false; }
    }
    return true;
  }

  function choose(state, decision, event) {
    const button = event.currentTarget;
    if (!trustedChoice(state, event, button)) return;
    state.pending = true;
    for (const control of state.controls) control.disabled = true;
    say(state, 'working', 'info');
    send(state, decision, decision === 'allow' && state.always.checked, (response) => {
      if (current !== state) return;
      if (response.success === true) {
        teardown(state);
        return;
      }
      state.pending = false;
      for (const control of state.controls) control.disabled = false;
      state.allow.disabled = true;
      state.deny.disabled = true;
      say(state, 'failed');
      state.page.focus({ preventScroll: true });
    });
  }

  /** A card the page took down or hid still leaves the owner a way to decide: the private vault page. */
  function pageTookCard(state) {
    if (state.hiding || current !== state) return;
    teardown(state);
    send(state, 'page', false);
  }

  function show(config) {
    if (!validConfig(config)) return false;
    if (current) teardown(current);
    const lang = typeof config.lang === 'string' && config.lang.toLowerCase().startsWith('ar') ? 'ar' : 'en';
    const strings = STRINGS[lang];
    const host = document.createElement('bc-vault-approval');
    // Read by the lock shield (lib/overlay.js) in this same isolated world; page scripts cannot see it.
    host.__bcVaultHost = true;
    const hostStyle = [
      'all: initial !important', 'position: fixed !important', 'top: 16px !important', 'inset-inline-end: 16px !important',
      'inset-inline-start: auto !important', 'bottom: auto !important', 'margin: 0 !important', 'padding: 0 !important',
      'border: 0 !important', 'background: transparent !important', 'overflow: visible !important',
      'width: auto !important', 'height: auto !important', 'display: block !important',
      'z-index: 2147483647 !important', 'opacity: 1 !important', 'transform: none !important', 'filter: none !important',
      `direction: ${lang === 'ar' ? 'rtl' : 'ltr'} !important`,
    ].join(';');
    host.style.cssText = hostStyle;
    const root = host.attachShadow({ mode: 'closed' });
    const style = node('style');
    style.textContent = CSS;
    const card = node('section', 'card');
    card.dir = lang === 'ar' ? 'rtl' : 'ltr';
    card.lang = lang;
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'false');
    card.setAttribute('aria-labelledby', 'bc-card-title');
    card.setAttribute('aria-describedby', 'bc-card-body');
    card.dataset.arming = '';

    const brand = node('div', 'brand');
    const mark = node('span', 'mark');
    mark.append(icon(KEY_ICON));
    brand.append(mark, node('span', '', `Browser Controller · ${strings.brand}`));
    const title = node('h2', '', strings.title(isolate(config.agentName), isolate(hostOf(config.origin))));
    title.id = 'bc-card-title';
    const origin = node('p', 'origin', config.origin);
    const body = node('p', 'body', strings.body(isolate(config.browserLabel)));
    body.id = 'bc-card-body';
    card.append(brand, title, origin, body);
    if (config.purpose === 'fill' && config.account) card.append(node('p', 'account', strings.account(isolate(config.account))));
    if (config.unlock) {
      const unlock = node('p', 'unlock');
      unlock.append(icon(LOCK_ICON), node('span', '', strings.unlock));
      card.append(unlock);
    }
    const always = node('label', 'always');
    const alwaysInput = node('input');
    alwaysInput.type = 'checkbox';
    always.append(alwaysInput, node('span', '', strings.always), node('small', '', strings.alwaysHint));
    const actions = node('div', 'actions');
    const allow = node('button', 'button primary', strings.allow);
    const deny = node('button', 'button', strings.deny);
    const page = node('button', 'link', strings.page);
    for (const button of [allow, deny, page]) button.type = 'button';
    allow.disabled = true;
    deny.disabled = true;
    page.disabled = true;
    actions.append(allow, deny, page);
    const status = node('p', 'status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    card.append(always, actions, status);
    root.append(style, card);

    const state = {
      config, strings, host, root, card, status, allow, deny, page, always: alwaysInput,
      controls: [allow, deny, page, alwaysInput], buttons: [allow, deny, page],
      armedAt: Infinity, pending: false, hiding: false, reshows: 0, changes: 0,
      visible: false, tracksVisibility: false, rect: null, hostStyle, parent: null,
    };
    current = state;
    // The agent's input is refused from now on: a later mark means it tried to aim at this card.
    window.__bcAgentInputUntil = 0;
    allow.addEventListener('click', (event) => choose(state, 'allow', event));
    deny.addEventListener('click', (event) => choose(state, 'deny', event));
    page.addEventListener('click', (event) => choose(state, 'page', event));
    // "Always" outlasts this request, so it takes the same real, armed, in-place input as the buttons.
    alwaysInput.addEventListener('click', (event) => { if (!trustedChoice(state, event, always)) event.preventDefault(); });

    (document.documentElement || document).appendChild(host);
    state.parent = host.parentNode;
    if (typeof host.showPopover === 'function') {
      host.setAttribute('popover', 'manual');
      try { host.showPopover(); } catch { /* stays a fixed layer above the page */ }
      host.addEventListener('toggle', (event) => {
        if (event.newState !== 'closed' || state.hiding) return;
        if (++state.reshows > MAX_RESHOWS) { pageTookCard(state); return; }
        try { host.showPopover(); } catch { pageTookCard(state); }
      });
    }
    // The card is a child of the root element. Taken out, or moved anywhere else, it is the page's doing.
    state.removal = new MutationObserver(() => { if (!host.isConnected || host.parentNode !== state.parent) pageTookCard(state); });
    state.removal.observe(document, { childList: true });
    if (state.parent && state.parent !== document) state.removal.observe(state.parent, { childList: true });
    // A page that restyles the host could move the card under the owner's pointer: the style is put
    // back and the card waits again. A page that keeps at it gets the vault page instead.
    state.attributes = new MutationObserver(() => {
      if (state.hiding) return;
      if (++state.changes > MAX_RESHOWS) { pageTookCard(state); return; }
      for (const name of host.getAttributeNames()) if (name !== 'style' && name !== 'popover') host.removeAttribute(name);
      host.style.cssText = state.hostStyle;
      if (typeof host.showPopover === 'function') host.setAttribute('popover', 'manual');
      state.attributes.takeRecords();
      rearm(state);
    });
    state.attributes.observe(host, { attributes: true });
    state.onResize = () => rearm(state);
    addEventListener('resize', state.onResize);
    // The whole card must be in view and uncovered for ARM_MS before a choice counts (FR-006).
    const canTrack = typeof IntersectionObserverEntry === 'function' && 'isVisible' in IntersectionObserverEntry.prototype;
    try {
      if (!canTrack) throw new Error('no visibility tracking');
      state.visibility = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (typeof entry.isVisible !== 'boolean') continue;
          state.tracksVisibility = true;
          if (entry.isVisible === state.visible) continue;
          state.visible = entry.isVisible;
          rearm(state);
        }
      }, { trackVisibility: true, delay: 100 });
      state.visibility.observe(card);
      // A browser that never reports keeps the timed arming; the hit test still guards pointer clicks.
      state.visibilityFallback = setTimeout(() => { if (!state.tracksVisibility) arm(state); }, 1_500);
    } catch {
      arm(state);
    }
    state.expiry = setTimeout(() => { if (current === state) teardown(state); }, config.expiresAt - Date.now());
    return true;
  }

  globalThis.__bcVaultCard = Object.freeze({ show, hide });
})();
