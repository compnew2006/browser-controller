/**
 * What a trusted input did, read back from the page once it is sent (lib/trusted-input.js
 * sends it): the field's value, a press that landed outside its target, and whether the page
 * got the input at all (a Chrome dialog over the tab takes all of it).
 */
import { safeExec } from './page-exec.js';

/**
 * Close the tab's input window and read back what the input did (pageRelease). `typed` is the
 * text just inserted, when there was one. A page that navigated away answers {}.
 */
export async function releaseShield(tabId, typed = null) {
  try { return (await safeExec(tabId, pageRelease, [typed])) || {}; } catch { return {}; /* page navigated away */ }
}

/**
 * INPUT_BLOCKED: the page got none of `what` (a click at…, the keys…). Chrome's own dialogs
 * over a tab take its input; the debugger can neither see nor close them.
 */
export function inputBlockedError(what) {
  return `INPUT_BLOCKED: the page got none of ${what}. A Chrome dialog over the tab (a password-breach warning after a login, a permission prompt) takes its input: ask the user to close it, or go on in a new tab.`;
}

/**
 * Close the agent's input window; report ordinary field values and only booleans for sensitive fields,
 * (`missed`) a press that landed outside the element it aimed at, and (`pressSeen`,
 * `moveSeen`, `keysSeen`: false when none of it arrived) the input the page got. With
 * `typed`, what the text did to the aimed field: `changed`, `holdsTyped`, `matchesTyped`, `full` (its maxlength).
 */
function pageRelease(typed) {
  window.__bcAgentInputUntil = 0;
  const outcome = watchOutcome();
  let a = document.activeElement;
  for (let i = 0; a && i < 10; i++) {
    if (a.shadowRoot && a.shadowRoot.activeElement) { a = a.shadowRoot.activeElement; continue; }
    if (a.tagName !== 'IFRAME') break;
    try { a = a.contentDocument.activeElement; } catch { break; }
  }
  const focusedTag = a && a !== document.body ? a.tagName.toLowerCase() + (a.id ? `#${a.id}` : '') : undefined;
  // The value is the field the caller aimed at: a Tab typed into it moves focus elsewhere.
  const located = window.__bcLocatedEl || null;
  const before = window.__bcLocatedValue;
  window.__bcLocatedEl = null;
  window.__bcLocatedValue = null;
  const target = located && located.isConnected !== false ? located : (focusedTag ? a : null);
  if (!target) return { value: null, ...outcome };
  const value = typeof target.value === 'string' ? target.value : target.isContentEditable ? target.textContent : null;
  const D = globalThis.__bcDom;
  let secret = target.type === 'password';
  try { if (D && D.isSensitiveField) secret = secret || D.isSensitiveField(target); } catch { /* retain local field-hint checks */ }
  if (!secret) {
    let labels = '';
    try { labels = Array.from(target.labels || []).map((label) => label.textContent || '').join(' '); } catch { /* non-native control */ }
    const hints = [target.type, target.autocomplete, target.name, target.id, target.getAttribute?.('aria-label'), target.placeholder, target.title, labels].join(' ').toLowerCase();
    secret = /passw|passwd|pwd|secret|credential|token|api[\s_-]*key|one[\s_-]*time|otp|2fa|mfa|verification[\s_-]*code|security[\s_-]*code|auth(?:entication)?[\s_-]*(?:code|token|key)|cc[\s_-]*(?:number|exp|csc|cvc|name)|(?:credit|debit)[\s_-]*card|card[\s_-]*(?:number|code|security)|cvv|cvc|iban|bank[\s_-]*account|routing[\s_-]*number/i.test(hints);
  }
  if (!secret && typeof value === 'string') {
    const digits = value.replace(/[\s-]/g, '');
    if (/^\d{13,19}$/.test(digits)) {
      let sum = 0;
      let double = false;
      for (let i = digits.length - 1; i >= 0; i--) {
        let digit = Number(digits[i]);
        if (double) { digit *= 2; if (digit > 9) digit -= 9; }
        sum += digit;
        double = !double;
      }
      secret = sum % 10 === 0;
    }
  }
  // Only booleans leave the page for sensitive fields; the raw value never enters the extension background.
  const effect = typeof typed === 'string' && target === located && typeof value === 'string' && typeof before === 'string'
    ? {
      changed: value !== before,
      holdsTyped: value.includes(typed.replace(/\r\n?/g, '\n')),
      matchesTyped: value.slice(0, 100) === typed.replace(/\r\n?/g, '\n').slice(0, 100),
      ...(target.maxLength > 0 && value.length >= target.maxLength ? { full: target.maxLength } : {}),
    }
    : {};
  return {
    value: secret || value == null ? null : value.slice(0, 100),
    secret,
    ...(secret ? { hasValue: typeof value === 'string' && value.length > 0 } : {}),
    ...(focusedTag ? { focusedTag } : {}),
    ...outcome,
    ...effect,
  };

  /** What the watched input did (pageLocate watchInput): a missed press, and which kinds of it arrived. */
  function watchOutcome() {
    const watch = globalThis.__bcPressWatch;
    globalThis.__bcPressWatch = null;
    if (!watch) return {};
    watch.off();
    const out = {};
    if (!watch.blind) {
      // A pointer that does not move gets no move event: one already over the target has hovered it.
      const hovered = () => { try { return !!watch.hoverEl && watch.hoverEl.matches(':hover'); } catch { return false; } };
      for (const g of watch.watched) out[`${g}Seen`] = watch.seen.has(g) || (g === 'move' && hovered());
    }
    const missed = pressMissed(watch);
    return missed ? { ...out, missed } : out;
  }

  /** The element a watched press landed on instead of its target, or null. */
  function pressMissed(watch) {
    const D = globalThis.__bcDom;
    const { el, hit } = watch;
    if (!el || !hit || !D || hit === el || D.composedContains(el, hit) || D.labelsOf(el).some((l) => D.composedContains(l, hit))) return null;
    // A press inside a closed shadow root is seen at its host: that is no miss.
    for (let r = el.getRootNode(); r && r.host; r = r.host.getRootNode()) if (r.host === hit) return null;
    const name = D.nameOf(hit).slice(0, 60);
    return `${D.describe(hit)}${name ? ` "${name}"` : ''}`;
  }
}
