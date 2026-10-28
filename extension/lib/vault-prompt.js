import { cardOnTab, cardsReady, dropAllCards, dropCard, recordCard } from './vault-card.js';
import {
  executeVaultScript, getMainDocument, isPrivateVaultTab, isPrivateVaultUrl, safeFailure,
} from './vault-exec.js';

/**
 * The vault approval card's browser actions (specs/006-vault-site-approval D4): drawing the card on
 * the requesting tab, and taking it down when its request, document or daemon connection ends.
 */

const PROMPT_KEYS = ['tabId', 'requestId', 'documentId', 'origin', 'purpose', 'browserLabel', 'agentName', 'unlock', 'account', 'expiresAt'];
const VAULT_CARD_SCRIPT = 'vault/vault-card.js';

function validPrompt(params) {
  const shortText = (value) => typeof value === 'string' && value.length <= 120;
  return !Object.keys(params).some((key) => !PROMPT_KEYS.includes(key)) && Number.isInteger(params.tabId)
    && typeof params.requestId === 'string' && /^req_[a-f0-9]{1,64}$/.test(params.requestId)
    && typeof params.documentId === 'string' && !!params.documentId && typeof params.origin === 'string'
    && ['list', 'fill'].includes(params.purpose) && shortText(params.browserLabel) && shortText(params.agentName)
    && typeof params.unlock === 'boolean' && (params.account === undefined || shortText(params.account))
    && Number.isSafeInteger(params.expiresAt);
}

/** Runs in the page's isolated world, where vault/vault-card.js defined the card. */
function showApprovalCard(config) {
  return globalThis.__bcVaultCard?.show(config) === true;
}

function hideApprovalCard(requestId) {
  return globalThis.__bcVaultCard?.hide(requestId) === true;
}

/**
 * Draws the approval card on the requesting tab's current document (specs/006 D4). The card is
 * recorded before it is drawn, so the agent's input to the tab is refused from that moment on.
 */
export async function promptAction(params) {
  if (!validPrompt(params)) return safeFailure('INVALID_ARGUMENT');
  if (params.expiresAt <= Date.now()) return safeFailure('VAULT_PERMISSION_DENIED');
  const { tab, frame, origin } = await getMainDocument(params.tabId);
  if (isPrivateVaultTab(tab.id) || isPrivateVaultUrl(tab.url)) return safeFailure('VAULT_CONTEXT_PROTECTED');
  if (frame.documentId !== params.documentId) return safeFailure('VAULT_DOCUMENT_CHANGED');
  if (origin !== params.origin) return safeFailure('VAULT_ORIGIN_MISMATCH');
  // A card still recorded on this tab belongs to a request that ended: this one replaces it.
  const token = crypto.randomUUID();
  recordCard(params.tabId, { requestId: params.requestId, documentId: params.documentId, origin, token, expiresAt: params.expiresAt });
  const target = { tabId: params.tabId, documentIds: [params.documentId] };
  let shown = false;
  try {
    await executeVaultScript({ target, world: 'ISOLATED', files: [VAULT_CARD_SCRIPT] });
    const results = await executeVaultScript({
      target,
      world: 'ISOLATED',
      func: showApprovalCard,
      args: [{
        requestId: params.requestId, token, origin, purpose: params.purpose, browserLabel: params.browserLabel,
        agentName: params.agentName, unlock: params.unlock, expiresAt: params.expiresAt,
        ...(params.account !== undefined ? { account: params.account } : {}),
        lang: chrome.i18n?.getUILanguage?.() || 'en',
      }],
    });
    shown = results?.[0]?.result === true;
  } finally {
    if (!shown) dropCard(params.tabId, params.requestId);
  }
  if (!shown) return safeFailure('VAULT_TARGET_UNSAFE');
  await chrome.tabs.update(params.tabId, { active: true }).catch(() => {});
  if (Number.isInteger(tab.windowId)) await chrome.windows?.update(tab.windowId, { focused: true }).catch(() => {});
  return { success: true, shown: true };
}

/** Takes a card down once its request ended without the card's own decision. */
export async function promptCloseAction(params) {
  if (!Number.isInteger(params.tabId) || typeof params.requestId !== 'string'
    || Object.keys(params).some((key) => key !== 'tabId' && key !== 'requestId')) return safeFailure('INVALID_ARGUMENT');
  const card = dropCard(params.tabId, params.requestId);
  if (!card) return { success: true, closed: false };
  await executeVaultScript({
    target: { tabId: params.tabId, documentIds: [card.documentId] }, world: 'ISOLATED', func: hideApprovalCard, args: [params.requestId],
  }, undefined, 2_000).catch(() => {});
  return { success: true, closed: true };
}

/**
 * The card on a tab whose document went away (navigation, close) or whose daemon connection ended:
 * forgotten, and taken down when the document is still there. Returns the request it was for.
 */
export async function closeApprovalCard(tabId, { keepDocumentId, removeFromPage = true } = {}) {
  const card = cardOnTab(tabId);
  if (!card || (keepDocumentId !== undefined && card.documentId === keepDocumentId)) return null;
  dropCard(tabId, card.requestId);
  if (removeFromPage) {
    await executeVaultScript({
      target: { tabId, documentIds: [card.documentId] }, world: 'ISOLATED', func: hideApprovalCard, args: [card.requestId],
    }, undefined, 2_000).catch(() => {});
  }
  return card.requestId;
}

/** Every card ends with the daemon connection that asked for it. */
export async function closeAllApprovalCards() {
  await Promise.allSettled(dropAllCards().map(({ tabId, card }) => executeVaultScript({
    target: { tabId, documentIds: [card.documentId] }, world: 'ISOLATED', func: hideApprovalCard, args: [card.requestId],
  }, undefined, 2_000)));
}

/**
 * On a new daemon connection: a card a restarted worker restored answers a connection that is gone.
 * No request is left to decide, so it would only block the agent's input to that tab until it expires.
 */
export async function closeStaleApprovalCards() {
  await cardsReady;
  await closeAllApprovalCards();
}
