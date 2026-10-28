import {
  canonicalOrigin, clearPrivateVaultTabs, executeVaultScript, getMainDocument, isPrivateVaultTab, isPrivateVaultUrl,
  openPrivateVault, registerPrivateVaultTab, safeFailure, VAULT_PAGE_EXEC_TIMEOUT_MS,
} from './vault-exec.js';
import { clearPasswordInspection, fillInspectedPassword, inspectPasswordField } from './vault-page-scripts.js';
import { promptAction, promptCloseAction } from './vault-prompt.js';

export {
  forgetPrivateVaultTab, isPrivateVaultSender, isPrivateVaultTab, isPrivateVaultUrl, openPrivateVault, registerPrivateVaultTab,
} from './vault-exec.js';
export { fillInspectedPassword, inspectPasswordField } from './vault-page-scripts.js';
export { closeAllApprovalCards, closeApprovalCard, closeStaleApprovalCards } from './vault-prompt.js';

/**
 * Private credential-vault browser actions and in-memory document protection.
 * Passwords pass through this module only for the duration of one fill call.
 */

const VAULT_STATE_KEY = 'bcVaultRuntimeState';
const VAULT_MAY_PROTECT_KEY = 'bcVaultMayHaveSensitiveContext';
const INSPECTION_TTL_MS = 60_000;
const VAULT_PAGE_WRITE_WINDOW_MS = 7_000;
const inspections = new Map();
const protectedDocuments = new Map();
const unknownProtectedTabs = new Set();
const pendingRemovals = [];
let protectionSequence = 0;
let protectionStateTrusted = false;
let unrecoverableProtectionState = false;


async function getSameOriginFrames(tabId, expectedOrigin) {
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  if (!Array.isArray(frames) || !frames.length) throw new Error('VAULT_DOCUMENT_CHANGED');
  const ids = new Set();
  const documents = new Set();
  for (const frame of frames) {
    if (!Number.isInteger(frame?.frameId) || typeof frame.documentId !== 'string' || !frame.documentId
      || typeof frame.url !== 'string' || ids.has(frame.frameId) || documents.has(frame.documentId)) {
      throw new Error('VAULT_DOCUMENT_CHANGED');
    }
    ids.add(frame.frameId);
    documents.add(frame.documentId);
    // Third-party widgets (for example, a challenge frame) are not targets and
    // are not inspected. A target can only be selected from a verified frame
    // whose URL has the top document's exact origin.
  }
  const top = frames.find((frame) => frame.frameId === 0);
  if (!top) throw new Error('VAULT_DOCUMENT_CHANGED');
  if (canonicalOrigin(top.url) !== expectedOrigin) throw new Error('VAULT_ORIGIN_MISMATCH');
  return frames.filter((frame) => {
    try { return canonicalOrigin(frame.url) === expectedOrigin; }
    catch { return false; }
  });
}

function sameFrameDocuments(left, right) {
  return left.length === right.length && left.every((frame) =>
    right.some((other) => other.frameId === frame.frameId && other.documentId === frame.documentId && other.url === frame.url));
}

async function clearInspectionsInFrames(tabId, frames, nonce) {
  await Promise.allSettled(frames.map((frame) => executeVaultScript({
    target: { tabId, documentIds: [frame.documentId] },
    world: 'ISOLATED',
    func: clearPasswordInspection,
    args: [nonce],
  }, undefined, 500)));
}

function protectionSnapshot() {
  return {
    documents: [...protectedDocuments.values()].map((document) => ({ ...document })),
    pendingRemovals: pendingRemovals.map((event) => ({ ...event, documentIds: [...event.documentIds] })),
  };
}

async function saveRuntimeState() {
  try {
    const protectedTabIds = [...new Set([
      ...[...protectedDocuments.values()].map((document) => document.tabId),
      ...pendingRemovals.map((event) => event.tabId),
      ...unknownProtectedTabs,
    ])].sort((a, b) => a - b);
    const mayContainSensitiveContext = protectedTabIds.length > 0 || unrecoverableProtectionState;
    // Write the durable marker first. If session storage then fails, a browser
    // restart still knows not to treat the profile as clean.
    if (mayContainSensitiveContext) {
      await chrome.storage.local.set({ [VAULT_MAY_PROTECT_KEY]: { version: 1, tabIds: protectedTabIds } });
    }
    const snapshot = protectionSnapshot();
    await chrome.storage.session.set({
      [VAULT_STATE_KEY]: {
        protectionSequence,
        protectedDocuments: snapshot.documents,
        pendingRemovals: snapshot.pendingRemovals,
      },
    });
    if (!mayContainSensitiveContext) await chrome.storage.local.remove(VAULT_MAY_PROTECT_KEY);
    protectionStateTrusted = !unrecoverableProtectionState && unknownProtectedTabs.size === 0;
    return true;
  } catch {
    protectionStateTrusted = false;
    return false;
  }
}

function pruneInspections() {
  const now = Date.now();
  for (const [nonce, item] of inspections) if (item.expiresAt <= now) inspections.delete(nonce);
}

function bumpProtectionSequence() {
  protectionSequence += 1;
  return protectionSequence;
}

export async function getVaultProtectionSnapshot() {
  const snapshot = protectionSnapshot();
  return {
    type: 'vaultProtectionState',
    sequence: protectionSequence,
    documents: snapshot.documents,
    pendingRemovals: snapshot.pendingRemovals,
    unknownTabIds: [...unknownProtectedTabs],
    protectionUnknown: !protectionStateTrusted,
  };
}

export async function restoreVaultRuntimeState() {
  try {
    const [stored, local] = await Promise.all([
      chrome.storage.session.get(VAULT_STATE_KEY),
      chrome.storage.local.get(VAULT_MAY_PROTECT_KEY),
    ]);
    protectedDocuments.clear();
    pendingRemovals.splice(0);
    unknownProtectedTabs.clear();
    unrecoverableProtectionState = false;
    clearPrivateVaultTabs();
    const state = stored?.[VAULT_STATE_KEY];
    const statePresent = !!state && Number.isSafeInteger(state.protectionSequence) && state.protectionSequence >= 0
      && Array.isArray(state.protectedDocuments) && state.protectedDocuments.every((document) =>
        Number.isInteger(document?.tabId) && typeof document.documentId === 'string' && document.documentId.length > 0
          && typeof document.origin === 'string' && ['active', 'recovery_required'].includes(document.state))
      && Array.isArray(state.pendingRemovals ?? []) && (state.pendingRemovals ?? []).every((event) =>
        Number.isSafeInteger(event?.sequence) && Number.isInteger(event?.tabId) && Array.isArray(event.documentIds)
          && event.documentIds.every((id) => typeof id === 'string'));
    const marker = local?.[VAULT_MAY_PROTECT_KEY];
    const markerShapeValid = marker && typeof marker === 'object' && marker.version === 1 && Array.isArray(marker.tabIds)
      && marker.tabIds.every((tabId) => Number.isInteger(tabId) && tabId >= 0);
    const legacyMarker = marker === true;
    const mayHaveSensitiveContext = legacyMarker || markerShapeValid;
    // Ordinary browser restarts clear storage.session. A profile that never
    // filled a password has no durable marker and remains usable; a profile
    // that may have a live document fails closed until the state is recovered.
    protectionStateTrusted = !mayHaveSensitiveContext || statePresent;
    if (Number.isSafeInteger(state?.protectionSequence) && state.protectionSequence >= 0) protectionSequence = state.protectionSequence;
    if (Array.isArray(state?.protectedDocuments)) {
      for (const document of state.protectedDocuments) {
        if (Number.isInteger(document?.tabId) && typeof document.documentId === 'string'
          && typeof document.origin === 'string' && ['active', 'recovery_required'].includes(document.state)) {
          protectedDocuments.set(document.documentId, { ...document });
        }
      }
    }
    if (Array.isArray(state?.pendingRemovals)) {
      for (const event of state.pendingRemovals) {
        if (Number.isSafeInteger(event?.sequence) && Number.isInteger(event?.tabId) && Array.isArray(event.documentIds)
          && event.documentIds.every((id) => typeof id === 'string')) {
          pendingRemovals.push({ sequence: event.sequence, tabId: event.tabId, documentIds: [...event.documentIds] });
        }
      }
    }
    if (mayHaveSensitiveContext && !statePresent) {
      unrecoverableProtectionState = legacyMarker || !markerShapeValid;
      if (markerShapeValid) {
        const existingTabs = new Set((await chrome.tabs.query({})).map((tab) => tab?.id).filter(Number.isInteger));
        for (const tabId of marker.tabIds) if (existingTabs.has(tabId)) unknownProtectedTabs.add(tabId);
        // Tab IDs from closed contexts are verified discarded. The remaining
        // IDs stay blocked until an explicit tab close is observed.
        if (unknownProtectedTabs.size === 0) protectionStateTrusted = true;
      }
    }
    if (!mayHaveSensitiveContext || (statePresent && protectedDocuments.size === 0 && pendingRemovals.length === 0)
      || (!unrecoverableProtectionState && unknownProtectedTabs.size === 0 && protectedDocuments.size === 0 && pendingRemovals.length === 0)) {
      if (!(await saveRuntimeState())) protectionStateTrusted = false;
    }
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) if (tab.id != null && isPrivateVaultUrl(tab.url)) registerPrivateVaultTab(tab.id);
  } catch {
    protectionStateTrusted = false;
  }
}

export function acknowledgeVaultProtection(sequence) {
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > protectionSequence) return;
  // Acknowledgments confirm delivery only; they never clear protection.
}

export async function acknowledgeVaultRemoval(sequence) {
  if (!Number.isSafeInteger(sequence)) return;
  const remaining = pendingRemovals.filter((event) => event.sequence !== sequence);
  if (remaining.length === pendingRemovals.length) return;
  pendingRemovals.splice(0, pendingRemovals.length, ...remaining);
  await saveRuntimeState();
}

export async function removeProtectedTab(tabId) {
  const removed = [...protectedDocuments.values()].filter((document) => document.tabId === tabId);
  const documentIds = removed.map((document) => document.documentId);
  const unknownContextRemoved = unknownProtectedTabs.delete(tabId);
  for (const documentId of documentIds) protectedDocuments.delete(documentId);
  if (documentIds.length) {
    const sequence = bumpProtectionSequence();
    pendingRemovals.push({ sequence, tabId, documentIds });
    if (!(await saveRuntimeState())) {
      for (const document of removed) protectedDocuments.set(document.documentId, document);
      pendingRemovals.splice(pendingRemovals.findIndex((event) => event.sequence === sequence), 1);
      return { sequence, tabId, documentIds: [], unknownContextRemoved };
    }
    return { sequence, tabId, documentIds, unknownContextRemoved };
  }
  if (unknownContextRemoved) {
    const sequence = bumpProtectionSequence();
    if (!(await saveRuntimeState())) return { sequence, tabId, documentIds: [], unknownContextRemoved: true };
    return { sequence, tabId, documentIds: [], unknownContextRemoved: true };
  }
  return { sequence: protectionSequence, tabId, documentIds, unknownContextRemoved: false };
}

export async function markDocumentCurrent(tabId, documentId) {
  let changed = false;
  for (const document of protectedDocuments.values()) {
    if (document.tabId !== tabId) continue;
    const current = document.documentId === documentId;
    if (document.current !== current) {
      document.current = current;
      changed = true;
    }
  }
  if (changed) {
    bumpProtectionSequence();
    await saveRuntimeState();
  }
}

async function inspectAction(params, signal) {
  if (!Number.isInteger(params.tabId) || Object.keys(params).some((key) => key !== 'tabId' && key !== 'withIdentifier')
    || (params.withIdentifier !== undefined && params.withIdentifier !== true)) return safeFailure('INVALID_ARGUMENT');
  const withIdentifier = params.withIdentifier === true;
  pruneInspections();
  const { tab, frame, origin } = await getMainDocument(params.tabId);
  if (signal?.aborted) return safeFailure('VAULT_PERMISSION_DENIED');
  if (isPrivateVaultTab(tab.id) || isPrivateVaultUrl(tab.url)) return safeFailure('VAULT_CONTEXT_PROTECTED');
  const frames = await getSameOriginFrames(params.tabId, origin);
  if (signal?.aborted) return safeFailure('VAULT_PERMISSION_DENIED');
  if (!frames.some((item) => item.frameId === 0 && item.documentId === frame.documentId)) return safeFailure('VAULT_DOCUMENT_CHANGED');
  const nonce = crypto.randomUUID();
  const deadline = Date.now() + VAULT_PAGE_WRITE_WINDOW_MS;
  let inspectedFrames;
  try {
    inspectedFrames = await Promise.all(frames.map(async (item) => {
      const results = await executeVaultScript({
        target: { tabId: params.tabId, documentIds: [item.documentId] },
        world: 'ISOLATED',
        func: inspectPasswordField,
        args: withIdentifier ? [nonce, deadline, true] : [nonce, deadline],
      }, signal, Math.max(1, deadline - Date.now()));
      if (signal?.aborted) throw new Error('VAULT_PERMISSION_DENIED');
      const result = results?.find((entry) => entry.documentId === item.documentId && entry.frameId === item.frameId)?.result;
      if (!result || result.documentOrigin !== origin || !Number.isInteger(result.candidateCount)) throw new Error('VAULT_DOCUMENT_CHANGED');
      return { frameId: item.frameId, documentId: item.documentId, ...result };
    }));
  } catch (error) {
    await clearInspectionsInFrames(params.tabId, frames, nonce);
    throw error;
  }
  const fresh = await getMainDocument(params.tabId);
  if (signal?.aborted) {
    await clearInspectionsInFrames(params.tabId, frames, nonce);
    return safeFailure('VAULT_PERMISSION_DENIED');
  }
  const freshFrames = await getSameOriginFrames(params.tabId, origin);
  if (signal?.aborted) {
    await clearInspectionsInFrames(params.tabId, freshFrames, nonce);
    return safeFailure('VAULT_PERMISSION_DENIED');
  }
  if (fresh.frame.documentId !== frame.documentId || fresh.origin !== origin || !sameFrameDocuments(frames, freshFrames)) {
    await clearInspectionsInFrames(params.tabId, freshFrames, nonce);
    return safeFailure('VAULT_DOCUMENT_CHANGED');
  }
  const totalCandidates = inspectedFrames.reduce((sum, item) => sum + item.candidateCount, 0);
  let targetFrame = totalCandidates === 1 ? inspectedFrames.find((item) => item.suitable) : undefined;
  let identifierMode = false;
  if (withIdentifier && totalCandidates === 0
    && inspectedFrames.reduce((sum, item) => sum + (Number.isInteger(item.identifierCount) ? item.identifierCount : 0), 0) === 1) {
    // No password field anywhere and one username field: a first sign-in step (specs/006 FR-012).
    targetFrame = inspectedFrames.find((item) => item.identifierCount === 1);
    identifierMode = !!targetFrame;
  }
  const suitable = !!targetFrame;
  const identifierField = suitable && !identifierMode && targetFrame.identifierField === true;
  if (suitable) {
    inspections.set(nonce, {
      tabId: params.tabId,
      origin,
      documentId: frame.documentId,
      targetDocumentId: targetFrame.documentId,
      frameId: targetFrame.frameId,
      mode: identifierMode ? 'identifier' : 'password',
      identifierField,
      expiresAt: Date.now() + INSPECTION_TTL_MS,
    });
    // A username-only page in another frame kept a field of its own: only the target keeps one.
    if (withIdentifier) await clearInspectionsInFrames(params.tabId, frames.filter((item) => item.documentId !== targetFrame.documentId), nonce);
  } else await clearInspectionsInFrames(params.tabId, frames, nonce);
  return {
    success: true,
    tabId: params.tabId,
    origin,
    documentId: frame.documentId,
    targetDocumentId: targetFrame?.documentId || frame.documentId,
    frameId: targetFrame?.frameId ?? 0,
    nonce,
    suitable,
    ...(identifierMode ? { mode: 'identifier' } : {}),
    ...(identifierField ? { identifierField: true } : {}),
    ...(!suitable ? { reasonCode: 'VAULT_TARGET_UNSAFE' } : {}),
  };
}

/** A fill that cannot be proven safe leaves the document marked until recovery. */
async function markRecoveryRequired(protectedDocument) {
  if (protectedDocument) protectedDocument.state = 'recovery_required';
  bumpProtectionSequence();
  await saveRuntimeState();
}

async function fillAction(params, signal) {
  const allowed = ['tabId', 'origin', 'documentId', 'targetDocumentId', 'frameId', 'nonce', 'password', 'identifier'];
  if (Object.keys(params).some((key) => !allowed.includes(key)) || !Number.isInteger(params.tabId)
    || typeof params.origin !== 'string' || typeof params.documentId !== 'string'
    || typeof params.targetDocumentId !== 'string' || !Number.isInteger(params.frameId)
    || params.frameId < 0 || typeof params.nonce !== 'string'
    || (params.password !== undefined && (typeof params.password !== 'string' || !params.password))
    || (params.identifier !== undefined && (typeof params.identifier !== 'string' || !params.identifier))
    || (params.password === undefined && params.identifier === undefined)) {
    return safeFailure('INVALID_ARGUMENT');
  }
  pruneInspections();
  const inspected = inspections.get(params.nonce);
  inspections.delete(params.nonce); // one attempt, including a failed or cancelled attempt
  if (!inspected || inspected.tabId !== params.tabId || inspected.origin !== params.origin
    || inspected.documentId !== params.documentId || inspected.targetDocumentId !== params.targetDocumentId
    || inspected.frameId !== params.frameId) return safeFailure('VAULT_PERMISSION_DENIED');
  // The fill must match what the inspection found: the username alone on a first sign-in step, else a
  // password, with a username only where the inspection kept that field.
  const identifierOnly = inspected.mode === 'identifier';
  if (identifierOnly ? (params.password !== undefined || params.identifier === undefined)
    : (params.password === undefined || (params.identifier !== undefined && !inspected.identifierField))) {
    return safeFailure('INVALID_ARGUMENT');
  }
  if (signal?.aborted) return safeFailure('VAULT_PERMISSION_DENIED');
  if (identifierOnly) return fillIdentifierOnly(params, inspected, signal);
  if (!protectionStateTrusted) return safeFailure('VAULT_RECOVERY_REQUIRED');

  const { tab, frame, origin } = await getMainDocument(params.tabId);
  if (signal?.aborted) return safeFailure('VAULT_PERMISSION_DENIED');
  if (frame.documentId !== inspected.documentId) return safeFailure('VAULT_DOCUMENT_CHANGED');
  if (origin !== inspected.origin || origin !== params.origin) return safeFailure('VAULT_ORIGIN_MISMATCH');
  if (isPrivateVaultTab(tab.id) || isPrivateVaultUrl(tab.url)) return safeFailure('VAULT_CONTEXT_PROTECTED');
  const frames = await getSameOriginFrames(params.tabId, origin);
  if (signal?.aborted) return safeFailure('VAULT_PERMISSION_DENIED');
  if (!frames.some((item) => item.frameId === inspected.frameId && item.documentId === inspected.targetDocumentId)) return safeFailure('VAULT_DOCUMENT_CHANGED');

  // Protection is monotonic across worker/daemon reconnects. The secret itself
  // never enters storage; only tab/document/origin metadata does.
  protectedDocuments.set(frame.documentId, {
    tabId: params.tabId,
    documentId: frame.documentId,
    origin,
    state: 'active',
    current: true,
  });
  bumpProtectionSequence();
  if (!(await saveRuntimeState())) return safeFailure('VAULT_RECOVERY_REQUIRED');
  if (signal?.aborted) return safeFailure('VAULT_PERMISSION_DENIED');
  try {
    const beforeFill = await getMainDocument(params.tabId);
    if (signal?.aborted) throw new Error('VAULT_PERMISSION_DENIED');
    const beforeFrames = await getSameOriginFrames(params.tabId, origin);
    if (signal?.aborted) throw new Error('VAULT_PERMISSION_DENIED');
    if (beforeFill.frame.documentId !== inspected.documentId || beforeFill.origin !== origin
      || !sameFrameDocuments(frames, beforeFrames)
      || !beforeFrames.some((item) => item.frameId === inspected.frameId && item.documentId === inspected.targetDocumentId)) {
      return safeFailure('VAULT_DOCUMENT_CHANGED');
    }
    if (signal?.aborted) throw new Error('VAULT_PERMISSION_DENIED');
    const deadline = Date.now() + VAULT_PAGE_WRITE_WINDOW_MS;
    const result = await executeVaultScript({
      target: { tabId: params.tabId, documentIds: [inspected.targetDocumentId] },
      world: 'ISOLATED',
      func: fillInspectedPassword,
      args: params.identifier === undefined
        ? [params.nonce, params.password, inspected.origin, deadline]
        : [params.nonce, params.password, inspected.origin, deadline, params.identifier],
    }, signal, VAULT_PAGE_EXEC_TIMEOUT_MS);
    const fresh = await getMainDocument(params.tabId);
    if (signal?.aborted) throw new Error('VAULT_PERMISSION_DENIED');
    const freshFrames = await getSameOriginFrames(params.tabId, inspected.origin);
    if (signal?.aborted) throw new Error('VAULT_PERMISSION_DENIED');
    if (fresh.frame.documentId !== inspected.documentId || fresh.origin !== inspected.origin
      || !freshFrames.some((item) => item.frameId === inspected.frameId && item.documentId === inspected.targetDocumentId)) {
      await markRecoveryRequired(protectedDocuments.get(frame.documentId));
      return safeFailure('VAULT_DOCUMENT_CHANGED');
    }
    const outcome = result?.[0]?.result;
    const identifierFilled = params.identifier !== undefined && outcome?.identifier_filled === true;
    if (signal?.aborted || outcome?.success !== true || outcome.retained !== true || outcome.filled_fields !== (identifierFilled ? 2 : 1)) {
      await markRecoveryRequired(protectedDocuments.get(frame.documentId));
      return safeFailure(signal?.aborted ? 'VAULT_OUTCOME_UNKNOWN' : (outcome?.code || 'VAULT_TARGET_UNSAFE'));
    }
    return {
      success: true, filled_fields: identifierFilled ? 2 : 1,
      ...(params.identifier !== undefined ? { identifier_filled: identifierFilled } : {}),
    };
  } catch {
    await markRecoveryRequired(protectedDocuments.get(frame.documentId));
    return safeFailure('VAULT_OUTCOME_UNKNOWN');
  }
}

/**
 * A first sign-in step: only the username is written, so no secret reaches the page and the document
 * is not protected. The same document checks as a password fill run before the write.
 */
async function fillIdentifierOnly(params, inspected, signal) {
  const { tab, frame, origin } = await getMainDocument(params.tabId);
  if (signal?.aborted) return safeFailure('VAULT_PERMISSION_DENIED');
  if (frame.documentId !== inspected.documentId) return safeFailure('VAULT_DOCUMENT_CHANGED');
  if (origin !== inspected.origin || origin !== params.origin) return safeFailure('VAULT_ORIGIN_MISMATCH');
  if (isPrivateVaultTab(tab.id) || isPrivateVaultUrl(tab.url)) return safeFailure('VAULT_CONTEXT_PROTECTED');
  const frames = await getSameOriginFrames(params.tabId, origin);
  if (signal?.aborted) return safeFailure('VAULT_PERMISSION_DENIED');
  if (!frames.some((item) => item.frameId === inspected.frameId && item.documentId === inspected.targetDocumentId)) return safeFailure('VAULT_DOCUMENT_CHANGED');
  const result = await executeVaultScript({
    target: { tabId: params.tabId, documentIds: [inspected.targetDocumentId] },
    world: 'ISOLATED',
    func: fillInspectedPassword,
    args: [params.nonce, null, inspected.origin, Date.now() + VAULT_PAGE_WRITE_WINDOW_MS, params.identifier],
  }, signal, VAULT_PAGE_EXEC_TIMEOUT_MS);
  if (signal?.aborted) return safeFailure('VAULT_OUTCOME_UNKNOWN');
  const outcome = result?.[0]?.result;
  if (outcome?.success !== true || outcome.retained !== true || outcome.filled_fields !== 1 || outcome.identifier_filled !== true) {
    return safeFailure(outcome?.code || 'VAULT_TARGET_UNSAFE');
  }
  return { success: true, filled_fields: 1, identifier_filled: true };
}

export async function handleVaultAction(action, params, signal) {
  try {
    if (action === 'inspect') return await inspectAction(params, signal);
    if (action === 'fill') return await fillAction(params, signal);
    if (action === 'prompt') return await promptAction(params);
    if (action === 'promptClose') return await promptCloseAction(params);
    if (action === 'openUi') {
      if (Object.keys(params).some((key) => key !== 'requestId') || typeof params.requestId !== 'string') return safeFailure('INVALID_ARGUMENT');
      return await openPrivateVault(params.requestId);
    }
    return safeFailure('INVALID_ARGUMENT');
  } catch (error) {
    // The checks above throw their own code; a page that never answers throws TAB_WEDGED.
    const thrown = error?.code === 'TAB_WEDGED' ? 'VAULT_PAGE_UNRESPONSIVE' : error?.message;
    return safeFailure(/^(VAULT_[A-Z0-9_]+|INVALID_ARGUMENT)$/.test(thrown) ? thrown
      : action === 'openUi' ? 'VAULT_PERMISSION_DENIED' : 'VAULT_DOCUMENT_CHANGED');
  }
}
