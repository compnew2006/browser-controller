import { wedgedError } from './page-exec.js';
import { wedgedTabs } from './state.js';

/**
 * Private credential-vault browser actions and in-memory document protection.
 * Passwords pass through this module only for the duration of one fill call.
 */

const VAULT_PAGE = 'vault/vault.html';
const VAULT_STATE_KEY = 'bcVaultRuntimeState';
const VAULT_MAY_PROTECT_KEY = 'bcVaultMayHaveSensitiveContext';
const INSPECTION_TTL_MS = 60_000;
const VAULT_PAGE_EXEC_TIMEOUT_MS = 8_000;
const VAULT_PAGE_WRITE_WINDOW_MS = 7_000;
const inspections = new Map();
const protectedDocuments = new Map();
const privateVaultTabs = new Set();
const unknownProtectedTabs = new Set();
const pendingRemovals = [];
let protectionSequence = 0;
let protectionStateTrusted = false;
let unrecoverableProtectionState = false;

export function isPrivateVaultUrl(raw) {
  try {
    const url = new URL(raw);
    return url.origin === new URL(chrome.runtime.getURL('')).origin && url.pathname === '/vault/vault.html';
  } catch {
    return false;
  }
}

function safeFailure(code) {
  const messages = {
    VAULT_TARGET_UNSAFE: 'The page does not have one verified editable password field.',
    VAULT_ORIGIN_UNSUPPORTED: 'This page is not a supported vault target: fills work only on HTTPS sites and on loopback HTTP.',
    VAULT_PAGE_UNRESPONSIVE: 'The page did not respond before the vault action timed out.',
    VAULT_ORIGIN_MISMATCH: 'The page origin changed before the fill.',
    VAULT_DOCUMENT_CHANGED: 'The page changed before the fill.',
    VAULT_PERMISSION_DENIED: 'The private browser action is no longer valid.',
    VAULT_CONTEXT_PROTECTED: 'This page is protected by the credential vault.',
    INVALID_ARGUMENT: 'The private browser action is invalid.',
    VAULT_OUTCOME_UNKNOWN: 'The fill result is uncertain. Inspect the page before another explicit attempt.',
    VAULT_RECOVERY_REQUIRED: 'The browser protection state could not be saved. The page was left untouched.',
  };
  return { success: false, code, error: messages[code] || 'The private browser action could not be completed safely.' };
}

function canonicalOrigin(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('VAULT_ORIGIN_UNSUPPORTED'); }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('VAULT_ORIGIN_UNSUPPORTED');
  }
  if (url.username || url.password) throw new Error('VAULT_ORIGIN_UNSUPPORTED');
  return url.origin;
}

async function getMainDocument(tabId) {
  const [tab, frame] = await Promise.all([
    chrome.tabs.get(tabId),
    chrome.webNavigation.getFrame({ tabId, frameId: 0 }),
  ]);
  if (!tab || typeof tab.url !== 'string' || !frame || typeof frame.documentId !== 'string' || !frame.documentId) {
    throw new Error('VAULT_DOCUMENT_CHANGED');
  }
  return { tab, frame, origin: canonicalOrigin(tab.url) };
}

async function executeVaultScript(request, signal, timeoutMs = VAULT_PAGE_EXEC_TIMEOUT_MS) {
  const tabId = request.target.tabId;
  if (signal?.aborted) throw new Error('VAULT_PERMISSION_DENIED');
  const execution = chrome.scripting.executeScript(request);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else if (signal?.aborted) reject(new Error('VAULT_PERMISSION_DENIED'));
      else resolve(value);
    };
    const timer = setTimeout(() => {
      wedgedTabs.set(tabId, Date.now());
      finish(wedgedError(tabId, timeoutMs));
    }, timeoutMs);
    const onAbort = () => finish(new Error('VAULT_PERMISSION_DENIED'));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    Promise.resolve(execution).then((value) => finish(null, value), (error) => finish(error));
  });
}

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

/** Runs in one document's isolated world and retains only the element identity. */
export function inspectPasswordField(nonce, deadline) {
  // Chrome serializes only this function when using chrome.scripting. Keep all
  // page-side helpers nested so no extension module scope is required.
  const collect = (root, fields = []) => {
    for (const field of root.querySelectorAll?.('input[type="password"]') ?? []) if (!fields.includes(field)) fields.push(field);
    for (const element of root.querySelectorAll?.('*') ?? []) if (element.shadowRoot) collect(element.shadowRoot, fields);
    return fields;
  };
  const visible = (field) => {
    if (!(field instanceof HTMLInputElement) || field.type.toLowerCase() !== 'password'
      || field.disabled || field.readOnly || !field.isConnected || field.ownerDocument !== document) return false;
    const autocomplete = String(field.autocomplete || field.getAttribute('autocomplete') || '').trim().toLowerCase().split(/\s+/);
    if (autocomplete.includes('new-password')) return false;
    const fieldContext = [
      field.name || field.getAttribute('name'), field.id || field.getAttribute('id'),
      field.placeholder || field.getAttribute('placeholder'), field.getAttribute('aria-label'),
      ...(field.labels ? [...field.labels].map((label) => label.textContent || '') : []),
      field.form?.name, field.form?.id, field.form?.getAttribute?.('autocomplete'),
    ].filter(Boolean).join(' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/[_-]+/g, ' ');
    const submitIntent = [...(field.form?.querySelectorAll?.('button, input[type="submit"], input[type="button"]') ?? [])]
      .map((control) => control.innerText || control.textContent || control.value || control.getAttribute?.('aria-label') || '')
      .join(' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/[_-]+/g, ' ');
    const passwordChange = /\b(?:new|confirm(?:ation)?|repeat|reset|register|signup|sign\s+up|create|change|update)\s+(?:your\s+)?password\b|\bpassword\s+(?:reset|confirmation|confirm|again)\b/;
    const accountCreation = /\b(?:register|sign\s+up|create\s+(?:an?\s+)?account|reset\s+password|change\s+password|update\s+password)\b/;
    if (passwordChange.test(fieldContext) || accountCreation.test(submitIntent)) return false;
    const style = getComputedStyle(field);
    const rect = field.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0
      && rect.width > 0 && rect.height > 0 && field.getClientRects().length > 0;
  };
  const candidates = collect(document).filter(visible);
  if (Date.now() > deadline) return { suitable: false, candidateCount: 0, documentOrigin: location.origin };
  if (candidates.length !== 1) return { suitable: false, candidateCount: candidates.length, documentOrigin: location.origin };
  globalThis.__bcVaultInspection = { nonce, field: candidates[0] };
  return { suitable: true, candidateCount: 1, documentOrigin: location.origin };
}

function clearPasswordInspection(nonce) {
  if (globalThis.__bcVaultInspection?.nonce === nonce) delete globalThis.__bcVaultInspection;
  return true;
}

/** Runs once in the same isolated document and never submits the surrounding form. */
export function fillInspectedPassword(nonce, password, expectedOrigin, deadline) {
  if (location.origin !== expectedOrigin) return { success: false, code: 'VAULT_ORIGIN_MISMATCH' };
  if (Date.now() > deadline) return { success: false, code: 'VAULT_PERMISSION_DENIED' };
  const collect = (root, fields = []) => {
    for (const field of root.querySelectorAll?.('input[type="password"]') ?? []) if (!fields.includes(field)) fields.push(field);
    for (const element of root.querySelectorAll?.('*') ?? []) if (element.shadowRoot) collect(element.shadowRoot, fields);
    return fields;
  };
  const visible = (field) => {
    if (!(field instanceof HTMLInputElement) || field.type.toLowerCase() !== 'password'
      || field.disabled || field.readOnly || !field.isConnected || field.ownerDocument !== document) return false;
    const autocomplete = String(field.autocomplete || field.getAttribute('autocomplete') || '').trim().toLowerCase().split(/\s+/);
    if (autocomplete.includes('new-password')) return false;
    const context = [
      field.name || field.getAttribute('name'), field.id || field.getAttribute('id'),
      field.placeholder || field.getAttribute('placeholder'), field.getAttribute('aria-label'),
      ...(field.labels ? [...field.labels].map((label) => label.textContent || '') : []),
      field.form?.name, field.form?.id, field.form?.getAttribute?.('autocomplete'),
      field.form?.innerText, field.form?.textContent,
    ].filter(Boolean).join(' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/[_-]+/g, ' ');
    if (/\b(?:new|confirm(?:ation)?|repeat|reset|register|signup|sign\s+up|create|change|update)\s+(?:your\s+)?password\b|\bpassword\s+(?:reset|confirmation|confirm|again)\b/.test(context)) return false;
    const style = getComputedStyle(field);
    const rect = field.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0
      && rect.width > 0 && rect.height > 0 && field.getClientRects().length > 0;
  };
  const saved = globalThis.__bcVaultInspection;
  if (!saved || saved.nonce !== nonce || !saved.field || !saved.field.isConnected
    || saved.field.ownerDocument !== document || !visible(saved.field)) {
    return { success: false, code: 'VAULT_DOCUMENT_CHANGED' };
  }
  const candidates = collect(document).filter(visible);
  if (candidates.length !== 1 || candidates[0] !== saved.field) return { success: false, code: 'VAULT_TARGET_UNSAFE' };
  if (Date.now() > deadline || location.origin !== expectedOrigin) return { success: false, code: 'VAULT_PERMISSION_DENIED' };
  const field = saved.field;
  delete globalThis.__bcVaultInspection;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setter) return { success: false, code: 'VAULT_TARGET_UNSAFE' };
  setter.call(field, password);
  field.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  field.dispatchEvent(new Event('change', { bubbles: true }));
  return { success: field.value === password, retained: field.value === password, filled_fields: 1 };
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
    privateVaultTabs.clear();
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
    for (const tab of tabs) if (tab.id != null && isPrivateVaultUrl(tab.url)) privateVaultTabs.add(tab.id);
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

export function isPrivateVaultTab(tabId) {
  return privateVaultTabs.has(tabId);
}

export function isPrivateVaultSender(sender) {
  return !!sender && sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL(VAULT_PAGE);
}

export async function openPrivateVault(_requestId) {
  const url = chrome.runtime.getURL(VAULT_PAGE);
  const matches = await chrome.tabs.query({ url });
  const existing = matches.find((tab) => Number.isInteger(tab.id));
  if (existing) {
    privateVaultTabs.add(existing.id);
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId != null) await chrome.windows.update(existing.windowId, { focused: true }).catch(() => {});
  } else {
    const created = await chrome.tabs.create({ url, active: true });
    if (Number.isInteger(created.id)) privateVaultTabs.add(created.id);
  }
  return { success: true };
}

export function registerPrivateVaultTab(tabId) {
  if (Number.isInteger(tabId)) privateVaultTabs.add(tabId);
}

export function forgetPrivateVaultTab(tabId) {
  return privateVaultTabs.delete(tabId);
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
  if (!Number.isInteger(params.tabId) || Object.keys(params).some((key) => key !== 'tabId')) return safeFailure('INVALID_ARGUMENT');
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
        args: [nonce, deadline],
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
  const targetFrame = totalCandidates === 1 ? inspectedFrames.find((item) => item.suitable) : undefined;
  const suitable = !!targetFrame;
  if (suitable) inspections.set(nonce, {
    tabId: params.tabId,
    origin,
    documentId: frame.documentId,
    targetDocumentId: targetFrame.documentId,
    frameId: targetFrame.frameId,
    expiresAt: Date.now() + INSPECTION_TTL_MS,
  });
  else await clearInspectionsInFrames(params.tabId, frames, nonce);
  return {
    success: true,
    tabId: params.tabId,
    origin,
    documentId: frame.documentId,
    targetDocumentId: targetFrame?.documentId || frame.documentId,
    frameId: targetFrame?.frameId ?? 0,
    nonce,
    suitable,
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
  const allowed = ['tabId', 'origin', 'documentId', 'targetDocumentId', 'frameId', 'nonce', 'password'];
  if (Object.keys(params).some((key) => !allowed.includes(key)) || !Number.isInteger(params.tabId)
    || typeof params.origin !== 'string' || typeof params.documentId !== 'string'
    || typeof params.targetDocumentId !== 'string' || !Number.isInteger(params.frameId)
    || params.frameId < 0 || typeof params.nonce !== 'string' || typeof params.password !== 'string' || !params.password) {
    return safeFailure('INVALID_ARGUMENT');
  }
  pruneInspections();
  const inspected = inspections.get(params.nonce);
  inspections.delete(params.nonce); // one attempt, including a failed or cancelled attempt
  if (!inspected || inspected.tabId !== params.tabId || inspected.origin !== params.origin
    || inspected.documentId !== params.documentId || inspected.targetDocumentId !== params.targetDocumentId
    || inspected.frameId !== params.frameId) return safeFailure('VAULT_PERMISSION_DENIED');
  if (signal?.aborted) return safeFailure('VAULT_PERMISSION_DENIED');
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
      args: [params.nonce, params.password, inspected.origin, deadline],
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
    if (signal?.aborted || outcome?.success !== true || outcome.retained !== true || outcome.filled_fields !== 1) {
      await markRecoveryRequired(protectedDocuments.get(frame.documentId));
      return safeFailure(signal?.aborted ? 'VAULT_OUTCOME_UNKNOWN' : (outcome?.code || 'VAULT_TARGET_UNSAFE'));
    }
    return { success: true, filled_fields: 1 };
  } catch {
    await markRecoveryRequired(protectedDocuments.get(frame.documentId));
    return safeFailure('VAULT_OUTCOME_UNKNOWN');
  }
}

export async function handleVaultAction(action, params, signal) {
  try {
    if (action === 'inspect') return await inspectAction(params, signal);
    if (action === 'fill') return await fillAction(params, signal);
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
