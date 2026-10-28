/**
 * In-page vault approval cards (specs/006-vault-site-approval D4–D6): which tab shows one, for which
 * request and document, and the rule that keeps the agent's own input off it.
 *
 * While a card shows on a tab, CDP input to that tab is refused (cardInputGate), so the agent that
 * asked cannot press Allow itself. The open cards are kept in chrome.storage.session as well: a
 * service worker that restarts still knows them before it sends any input.
 */

const CARD_STATE_KEY = 'bcVaultApprovalCards';

/** tabId -> { requestId, documentId, origin, token, expiresAt } */
const openCards = new Map();
const expiryTimers = new Map();

/** Input that cannot start a press: a release ends one already under way, so it is let through. */
function isRelease(method, params) {
  return (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseReleased')
    || (method === 'Input.dispatchKeyEvent' && params?.type === 'keyUp')
    || (method === 'Input.dispatchTouchEvent' && (params?.type === 'touchEnd' || params?.type === 'touchCancel'))
    || method === 'Input.setInterceptDrags';
}

export const APPROVAL_PENDING_ERROR =
  'VAULT_APPROVAL_PENDING: The owner is deciding on a vault approval card on this tab. Wait for the decision, then call browser_vault again.';

async function persist() {
  try {
    await chrome.storage.session.set({ [CARD_STATE_KEY]: [...openCards].map(([tabId, card]) => ({ tabId, ...card })) });
  } catch { /* the in-memory state still gates input in this worker */ }
}

function armExpiry(tabId, card) {
  clearTimeout(expiryTimers.get(tabId));
  expiryTimers.set(tabId, setTimeout(() => {
    if (openCards.get(tabId) === card) forgetCard(tabId);
  }, Math.max(0, card.expiresAt - Date.now())));
}

function forgetCard(tabId) {
  clearTimeout(expiryTimers.get(tabId));
  expiryTimers.delete(tabId);
  const had = openCards.delete(tabId);
  if (had) void persist();
  return had;
}

/** Restores the cards a previous worker drew; input waits for it (see cardsReady). */
async function restore() {
  try {
    const stored = (await chrome.storage.session.get(CARD_STATE_KEY))?.[CARD_STATE_KEY];
    if (!Array.isArray(stored)) return;
    for (const item of stored) {
      if (!Number.isInteger(item?.tabId) || typeof item.requestId !== 'string' || typeof item.documentId !== 'string'
        || typeof item.token !== 'string' || !Number.isSafeInteger(item.expiresAt) || item.expiresAt <= Date.now()) continue;
      const card = { requestId: item.requestId, documentId: item.documentId, origin: item.origin, token: item.token, expiresAt: item.expiresAt };
      openCards.set(item.tabId, card);
      armExpiry(item.tabId, card);
    }
  } catch { /* nothing restored: no card is known */ }
}

export const cardsReady = typeof chrome !== 'undefined' && chrome.storage?.session ? restore() : Promise.resolve();

export function isApprovalCardOpen(tabId) {
  const card = openCards.get(tabId);
  if (!card) return false;
  if (card.expiresAt <= Date.now()) {
    forgetCard(tabId);
    return false;
  }
  return true;
}

/** The error for a CDP command the open card refuses, or null when it may run. */
export function cardInputGate(tabId, method, params) {
  if (typeof method !== 'string' || !method.startsWith('Input.') || isRelease(method, params)) return null;
  return isApprovalCardOpen(tabId) ? new Error(APPROVAL_PENDING_ERROR) : null;
}

/** Records a card drawn on a tab; it replaces any earlier one there. */
export function recordCard(tabId, card) {
  const entry = {
    requestId: card.requestId, documentId: card.documentId, origin: card.origin, token: card.token, expiresAt: card.expiresAt,
  };
  openCards.set(tabId, entry);
  armExpiry(tabId, entry);
  void persist();
}

export function cardOnTab(tabId) {
  return isApprovalCardOpen(tabId) ? { ...openCards.get(tabId) } : null;
}

/** Forgets the card on a tab, when it is the one for `requestId` (or any, without one); returns it. */
export function dropCard(tabId, requestId) {
  const card = openCards.get(tabId);
  if (!card || (requestId !== undefined && card.requestId !== requestId)) return null;
  forgetCard(tabId);
  return card;
}

/** Forgets every card: the daemon connection that asked for them is gone. Returns what each tab had. */
export function dropAllCards() {
  const dropped = [...openCards].map(([tabId, card]) => ({ tabId, card }));
  for (const { tabId } of dropped) forgetCard(tabId);
  return dropped;
}

/**
 * The decision a card sent, when it came from that card's own content script: this extension, the
 * card's tab, its top frame and document, with the card's token. The card stays recorded: the caller
 * drops it once the daemon has the decision (events.js), so the agent's input stays off meanwhile.
 */
export function takeCardDecision(message, sender) {
  if (!message || typeof message !== 'object' || typeof message.requestId !== 'string' || typeof message.token !== 'string') return null;
  if (!['allow', 'deny', 'page', 'cancel'].includes(message.decision) || typeof message.always !== 'boolean') return null;
  if (message.always && message.decision !== 'allow') return null;
  const tabId = sender?.tab?.id;
  if (!sender || sender.id !== chrome.runtime.id || !Number.isInteger(tabId) || sender.frameId !== 0) return null;
  const card = openCards.get(tabId);
  if (!card || card.requestId !== message.requestId || card.token !== message.token || card.expiresAt <= Date.now()) return null;
  if (typeof sender.documentId === 'string' && sender.documentId !== card.documentId) return null;
  if (typeof sender.origin === 'string' && card.origin && sender.origin !== card.origin) return null;
  return { tabId, requestId: card.requestId, decision: message.decision, always: message.always };
}
