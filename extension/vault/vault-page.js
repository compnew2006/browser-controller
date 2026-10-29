const $ = (selector) => document.querySelector(selector);
const notice = $('#notice');
const requestsEl = $('#requests');
const accountsEl = $('#accounts');
const accessEl = $('#accessActions');
const backupsEl = $('#backups');
const sitesSection = $('#sitesSection');
const siteGrantsEl = $('#siteGrants');
const allowlistEl = $('#allowlist');
const allowForm = $('#allowForm');
const form = $('#entryForm');
const addButton = $('#addEntry');
let state = null;
let editingHandle = null;
let removingHandle = null;
let busy = false;
let backupsLoaded = false;
const requestCards = new Map();
const requestSignatures = new Map();

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setNotice(message, kind = '') {
  notice.textContent = message;
  notice.dataset.kind = kind;
  notice.hidden = !message;
}

function explain(response) {
  const messages = {
    VAULT_EXTENSION_REQUIRED: 'This Browser Controller daemon is missing vault support. Restart it, then reload this extension.',
    VAULT_PERMISSION_DENIED: 'This request or browser connection is no longer current. Refresh and review the request again.',
    VAULT_ORIGIN_MISMATCH: 'The saved account does not match this exact site origin.',
    VAULT_DOCUMENT_CHANGED: 'The page changed while the request was open. Start a new request from the current page.',
    VAULT_TARGET_UNSAFE: 'The page does not have one verified editable password field.',
    VAULT_CONTEXT_PROTECTED: 'This browser page is protected while a credential may be present.',
    VAULT_RECOVERY_REQUIRED: 'Review the vault recovery options before continuing.',
    VAULT_KEY_MISSING: 'The local encryption key is missing. Existing data was preserved.',
    VAULT_STORAGE_INVALID: 'The local vault could not be read or written safely.',
    VAULT_LOCKED: 'Unlock the vault in this page first.',
    VAULT_APPROVAL_PENDING: 'An approval card for this site is open on the page. Decide there, or open the request here.',
    VAULT_BUSY: 'The vault is busy. Try again shortly.',
    VAULT_REQUEST_EXPIRED: 'This request expired. Ask the agent to start a new request.',
    VAULT_DECLINED: 'The request was declined.',
    VAULT_OUTCOME_UNKNOWN: 'The fill result is uncertain. Inspect the page before another explicit attempt.',
    INVALID_ARGUMENT: 'Check the form fields and try again. A site address is a host such as example.com, or a full https:// address.',
    NOT_CONNECTED: 'The daemon connection is unavailable. Reconnect the Browser Controller and refresh.',
  };
  return messages[response?.code] || 'The vault could not complete that action safely.';
}

function rpc(payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'vaultUiRequest', payload }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ success: false, code: 'NOT_CONNECTED' });
        return;
      }
      resolve(response && typeof response === 'object' ? response : { success: false, code: 'VAULT_STORAGE_INVALID' });
    });
  });
}

function setBusy(value) {
  busy = value;
  document.querySelectorAll('button').forEach((button) => { button.disabled = value; });
}

/** `successMessage` is a string, or a function of the daemon's reply when the outcome decides the wording. */
async function invoke(payload, successMessage) {
  if (busy) return null;
  setBusy(true);
  setNotice('Working…');
  let response;
  try {
    response = await rpc(payload);
    if (response.success === true) setNotice(typeof successMessage === 'function' ? successMessage(response) : successMessage, 'success');
    else setNotice(explain(response), 'error');
  } catch {
    response = { success: false, code: 'VAULT_STORAGE_INVALID' };
    setNotice(explain(response), 'error');
  } finally {
    setBusy(false);
  }
  await refreshState({ keepNotice: true });
  return response;
}

async function refreshState(options = {}) {
  const response = await rpc({ operation: 'getState' });
  if (response.success !== true) {
    state = null;
    $('#vaultState').textContent = 'Unavailable';
    $('#profileLine').textContent = 'The private vault connection is unavailable.';
    requestsEl.replaceChildren(element('p', 'empty', explain(response)));
    accountsEl.replaceChildren(element('p', 'empty', 'Vault data is unavailable.'));
    if (!options.keepNotice) setNotice(explain(response), 'error');
    return;
  }
  state = response;
  if (notice.dataset.kind === 'error') setNotice('');
  renderState();
}

function renderState() {
  const status = state?.status || 'unavailable';
  const stateEl = $('#vaultState');
  stateEl.textContent = status === 'ready' ? 'Unlocked' : status === 'empty' ? 'Not set up' : status === 'locked' ? 'Locked' : 'Recovery needed';
  stateEl.dataset.state = status;
  $('#profileLine').textContent = state?.browserLabel ? `Browser profile: ${state.browserLabel}` : 'Browser profile is not available.';
  $('#requestCount').textContent = String(state?.requests?.length || 0);
  renderRequests(Array.isArray(state?.requests) ? state.requests : []);
  renderAccounts(Array.isArray(state?.entries) ? state.entries : []);
  renderSites();
  renderAccess();
}

function renderRequests(requests) {
  if (!requests.length) {
    for (const card of requestCards.values()) card.remove();
    requestCards.clear();
    requestSignatures.clear();
    requestsEl.replaceChildren();
    requestsEl.append(element('p', 'empty', 'No pending requests.'));
    return;
  }
  requestsEl.querySelector('.empty')?.remove();
  const wanted = new Set();
  let position = 0;
  for (const request of requests) {
    wanted.add(request.requestId);
    const signature = request.purpose === 'save' ? 'save'
      : JSON.stringify([request.purpose, request.state, state?.status, request.handle, request.account?.label, request.account?.identifier, request.onCard === true]);
    let card = requestCards.get(request.requestId);
    if (!card || requestSignatures.get(request.requestId) !== signature) {
      card?.remove();
      card = renderRequest(request);
      requestCards.set(request.requestId, card);
      requestSignatures.set(request.requestId, signature);
    }
    const status = card.querySelector('.pill');
    if (status) status.textContent = request.state || 'pending';
    const current = requestsEl.children[position];
    if (current !== card) requestsEl.insertBefore(card, current || null);
    position += 1;
  }
  for (const [requestId, card] of requestCards) {
    if (wanted.has(requestId)) continue;
    card.remove();
    requestCards.delete(requestId);
    requestSignatures.delete(requestId);
  }
}

function requestTitle(request) {
  if (request.purpose === 'save') return 'Save a sign-in';
  if (request.purpose === 'fill') return 'Fill a saved sign-in';
  if (request.purpose === 'unlock') return 'Unlock the local vault';
  return 'Approve account access';
}

function renderRequest(request) {
  const card = element('article', 'card request');
  const head = element('div', 'card-head');
  const title = element('div', 'card-title');
  title.append(element('h3', '', requestTitle(request)));
  title.append(element('p', 'subtle', `${request.origin || 'Vault access'} · ${request.sessionLabel || 'Connected session'}`));
  head.append(title, element('span', 'pill pending', request.state || 'pending'));
  card.append(head);
  const meta = element('div', 'meta');
  if (request.browserLabel) meta.append(element('span', '', `Profile: ${request.browserLabel}`));
  if (request.tabId !== undefined) meta.append(element('span', '', `Tab ${request.tabId}`));
  if (request.expiresAt) meta.append(element('span', '', `Expires ${new Date(request.expiresAt).toLocaleTimeString()}`));
  card.append(meta);
  if (request.onCard) card.append(element('p', 'subtle', 'Also shown as an approval card on that tab. A choice here closes the card.'));

  if (request.purpose === 'save') card.append(renderSaveRequest(request));
  else if (request.purpose === 'unlock') {
    card.append(element('p', 'subtle', 'This changes access for Browser Controller on this device. It is not a master-password encryption claim.'));
    card.append(actionRow(
      actionButton('Unlock vault', 'primary', () => invoke({ operation: 'unlock', requestId: request.requestId }, 'Vault unlocked. The request is still waiting for your next choice.')),
      declineButton(request),
    ));
  } else if (request.purpose === 'fill' && request.handle) {
    const account = request.account;
    card.append(element('p', 'subtle', account ? `Account: ${account.label} · ${account.identifier}` : 'Unlock the vault to review this saved account.'));
    const actions = actionRow();
    if (state?.status === 'ready' && account) {
      actions.append(actionButton('Allow this site and fill', 'primary', () => invoke({
        operation: 'approve', requestId: request.requestId, credentialId: request.handle, purpose: 'fill',
      }, 'The site was allowed until the vault locks, and the fill request was handled.')));
    } else if (state?.status !== 'ready') {
      actions.append(actionButton('Unlock vault', 'primary', () => invoke({ operation: 'unlock' }, 'Vault unlocked. Review the request before approving it.')));
    }
    actions.append(declineButton(request));
    card.append(actions);
  } else {
    card.append(renderApprovalRequest(request));
  }
  return card;
}

function actionButton(label, variant, onClick) {
  const button = element('button', `button${variant ? ` ${variant}` : ''}`, label);
  button.type = 'button';
  button.addEventListener('click', onClick);
  return button;
}

function actionRow(...buttons) {
  const row = element('div', 'request-actions');
  row.append(...buttons);
  return row;
}

function declineButton(request) {
  return actionButton('Decline', '', () => invoke({ operation: 'decline', requestId: request.requestId }, 'Request declined.'));
}

function field(label, type, options = {}) {
  const wrapper = element('label');
  wrapper.append(element('span', '', label));
  const input = document.createElement('input');
  input.type = type;
  input.name = options.name || '';
  input.required = options.required !== false;
  input.maxLength = options.maxLength || 4096;
  input.autocomplete = options.autocomplete || 'off';
  if (options.value !== undefined) input.value = options.value;
  if (options.placeholder) input.placeholder = options.placeholder;
  wrapper.append(input);
  return { wrapper, input };
}

function checkbox(label) {
  const wrapper = element('label', 'check');
  const input = document.createElement('input');
  input.type = 'checkbox';
  wrapper.append(input, element('span', '', label));
  return { wrapper, input };
}

function renderSaveRequest(request) {
  const saveForm = element('form', 'request-form');
  const label = field('Account name', 'text', { name: 'label', maxLength: 120, placeholder: 'Personal account' });
  const identifier = field('Username or email', 'text', { name: 'identifier', maxLength: 320, autocomplete: 'username' });
  const password = field('Password', 'password', { name: 'password', maxLength: 4096, autocomplete: 'new-password' });
  const allow = checkbox('Allow agents to use sign-ins on this site until the vault locks');
  const actions = element('div', 'button-row');
  const save = actionButton('Save account', 'primary', null);
  const fill = actionButton('Save, allow this site, and fill', '', null);
  save.type = 'submit';
  fill.type = 'button';
  actions.append(save, fill, declineButton(request));
  saveForm.append(label.wrapper, identifier.wrapper, password.wrapper, allow.wrapper, actions);
  const submit = (saveAndFill) => async (event) => {
    event?.preventDefault();
    if (!saveForm.reportValidity()) return;
    if (saveAndFill && !allow.input.checked) {
      setNotice('Check the site access box before saving and filling.', 'error');
      allow.input.focus();
      return;
    }
    const payload = {
      operation: 'save', requestId: request.requestId, origin: request.origin,
      label: label.input.value, identifier: identifier.input.value, password: password.input.value,
      allowSession: allow.input.checked, saveAndFill,
    };
    password.input.value = '';
    save.disabled = true;
    fill.disabled = true;
    const result = await invoke(payload, saveAndFill
      ? 'The account was saved, the site was allowed until the vault locks, and one fill was attempted.'
      : allow.input.checked ? 'The account was saved, and the site was allowed until the vault locks.' : 'The account was saved.');
    payload.password = '';
    if (result?.success === true) saveForm.reset();
  };
  saveForm.addEventListener('submit', submit(false));
  fill.addEventListener('click', submit(true));
  return saveForm;
}

function renderApprovalRequest(request) {
  const container = element('div');
  if (state?.status !== 'ready') {
    container.append(element('p', 'subtle', 'Unlock the vault before reviewing saved account metadata.'));
    container.append(actionRow(
      actionButton('Unlock vault', 'primary', () => invoke({ operation: 'unlock' }, 'Vault unlocked. Review the request before approving it.')),
      declineButton(request),
    ));
    return container;
  }
  container.append(element('p', 'subtle', 'Lets every agent in this browser profile list and fill the sign-ins saved for this exact site until the vault locks.'));
  container.append(actionRow(
    actionButton('Allow this site', 'primary', () => invoke({
      operation: 'approve', requestId: request.requestId, purpose: 'list',
    }, 'The site was allowed until the vault locks.')),
    declineButton(request),
  ));
  return container;
}

function captureAccountFocus() {
  const active = document.activeElement;
  const focusedRow = active?.closest?.('.account-row');
  if (!accountsEl.contains(active) || !focusedRow || !active.dataset?.accountAction) return null;
  return {
    id: focusedRow.dataset.accountId,
    action: active.dataset.accountAction,
    index: [...accountsEl.querySelectorAll('.account-row')].indexOf(focusedRow),
  };
}

function restoreAccountFocus(focusedAccount, ready) {
  if (!focusedAccount) return;
  const rows = [...accountsEl.querySelectorAll('.account-row')];
  if (!rows.length) {
    if (ready && !addButton.hidden) addButton.focus({ preventScroll: true });
    return;
  }
  const row = rows.find((candidate) => candidate.dataset.accountId === focusedAccount.id)
    ?? rows[Math.min(Math.max(focusedAccount.index, 0), rows.length - 1)];
  const buttons = [...row.querySelectorAll('button[data-account-action]')];
  const fallbackActions = {
    remove: ['confirm-remove'],
    'confirm-remove': ['remove'],
    'cancel-removal': ['remove'],
  };
  const actionsToTry = [focusedAccount.action, ...(fallbackActions[focusedAccount.action] || [])];
  const target = actionsToTry
    .map((action) => buttons.find((button) => button.dataset.accountAction === action))
    .find(Boolean) || buttons[0];
  target?.focus({ preventScroll: true });
}

function renderAccounts(entries) {
  const focusedAccount = captureAccountFocus();
  accountsEl.replaceChildren();
  const ready = state?.status === 'ready';
  addButton.hidden = !ready;
  if (!ready) {
    accountsEl.append(element('p', 'empty', state?.status === 'empty' ? 'Set up the local vault to add an account.' : 'Unlock the vault to view saved accounts.'));
    restoreAccountFocus(focusedAccount, ready);
    return;
  }
  if (!entries.length) accountsEl.append(element('p', 'empty', 'No saved accounts yet.'));
  for (const entry of entries) {
    const row = element('article', 'account-row');
    row.dataset.accountId = entry.id;
    const copy = element('div', 'account-copy');
    copy.append(element('strong', '', entry.label || entry.identifier));
    copy.append(element('span', '', `${entry.identifier} · ${entry.origin}`));
    const actions = element('div', 'account-actions');
    const accountAction = (action, label, className, callback) => {
      const button = actionButton(label, className, callback);
      button.dataset.accountAction = action;
      return button;
    };
    actions.append(accountAction('replace-password', 'Replace password', '', () => editEntry(entry)));
    if (removingHandle === entry.id) {
      copy.append(element('span', 'subtle', 'Remove this saved sign-in? This cannot be undone.'));
      actions.append(accountAction('cancel-removal', 'Cancel removal', '', () => {
        removingHandle = null;
        renderAccounts(entries);
      }));
      actions.append(accountAction('confirm-remove', 'Confirm remove', 'danger', async () => {
        removingHandle = null;
        await invoke({ operation: 'remove', handle: entry.id }, 'Account removed.');
      }));
    } else {
      actions.append(accountAction('remove', 'Remove', 'danger', () => {
        removingHandle = entry.id;
        renderAccounts(entries);
      }));
    }
    row.append(copy, actions);
    accountsEl.append(row);
  }
  restoreAccountFocus(focusedAccount, ready);
}

/** What a Revoke did: the daemon also removes a revoked site from the always-allowed list. */
function revokedSiteMessage(origin, response) {
  return response.unlisted === true
    ? `${origin} is no longer allowed and was removed from the always-allowed list.`
    : `${origin} is no longer allowed.`;
}

/** What a Remove did: it also revokes the site's approval, however that approval was given. */
function removedSiteMessage(origin, response) {
  const revoked = Number(response.revoked) > 0;
  if (response.status === 'removed') {
    return revoked
      ? `${origin} was removed from the always-allowed list, and its approval was revoked.`
      : `${origin} was removed from the always-allowed list.`;
  }
  return revoked
    ? `${origin} was not on the always-allowed list. Its approval was revoked.`
    : `${origin} was not on the always-allowed list.`;
}

const SITE_GRANT_SOURCES = {
  card: 'Allowed on the page’s approval card',
  page: 'Allowed on this page',
  allowlist: 'Allowed from the always-allowed list',
};

function siteRow(origin, detail, button) {
  const row = element('div', 'grant-row');
  const details = element('div', 'account-copy');
  details.append(element('strong', '', origin), element('span', '', detail));
  row.append(details, button);
  return row;
}

/** Approved sites and the always-allowed list: both exist only while the vault is unlocked. */
function renderSites() {
  const ready = state?.status === 'ready';
  sitesSection.hidden = !ready;
  if (!ready) return;
  const grants = Array.isArray(state?.grants) ? state.grants.filter((grant) => grant.purpose === 'site') : [];
  siteGrantsEl.replaceChildren();
  if (!grants.length) siteGrantsEl.append(element('p', 'empty', 'No site is allowed right now.'));
  for (const grant of grants) {
    siteGrantsEl.append(siteRow(grant.origin, `${SITE_GRANT_SOURCES[grant.via] || 'Allowed'} · every agent session`,
      actionButton('Revoke', 'danger', () => invoke({ operation: 'revoke', grantId: grant.grantId }, (response) => revokedSiteMessage(grant.origin, response)))));
  }
  const allowlist = Array.isArray(state?.allowlist) ? state.allowlist : [];
  allowlistEl.replaceChildren();
  if (!allowlist.length) allowlistEl.append(element('p', 'empty', 'No site is always allowed.'));
  for (const entry of allowlist) {
    const added = Number.isFinite(entry.addedAt) ? `Added ${new Date(entry.addedAt).toLocaleDateString()}` : 'Always allowed';
    allowlistEl.append(siteRow(entry.origin, added,
      actionButton('Remove', 'danger', () => invoke({ operation: 'allowlistRemove', origin: entry.origin },
        (response) => removedSiteMessage(entry.origin, response)))));
  }
}

allowForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy || !allowForm.reportValidity()) return;
  const input = allowForm.elements.namedItem('site');
  const result = await invoke({ operation: 'allowlistAdd', origin: input.value.trim() }, 'The site is always allowed.');
  if (result?.success !== true) return;
  setNotice(result.status === 'unchanged' ? `${result.origin} was already always allowed.` : `${result.origin} is always allowed.`, 'success');
  allowForm.reset();
});

function renderAccess() {
  accessEl.replaceChildren();
  const ready = state?.status === 'ready';
  if (ready) {
    accessEl.append(actionButton('Lock vault', '', () => invoke({ operation: 'lock' }, 'Vault locked. Every site approval and session grant was revoked.')));
    accessEl.append(actionButton('Create protected recovery snapshot', '', async () => {
      const result = await invoke({ operation: 'backup' }, 'Protected local recovery snapshot created. Anyone with a copy can recover the accounts.');
      if (result?.success) await loadBackups();
    }));
  } else {
    const actionLabel = state?.status === 'empty' ? 'Set up local vault' : 'Unlock vault';
    accessEl.append(actionButton(actionLabel, 'primary', () => invoke({ operation: 'unlock' }, 'Vault unlocked. This is local app access, not a master-password encryption claim.')));
  }
  if (state?.status !== 'empty') {
    const toggle = actionButton(backupsLoaded ? 'Hide recovery snapshots' : 'Show recovery snapshots', '', async () => {
      if (!backupsLoaded) await loadBackups();
      else {
        backupsLoaded = false;
        backupsEl.replaceChildren();
      }
      toggle.textContent = backupsLoaded ? 'Hide recovery snapshots' : 'Show recovery snapshots';
    });
    accessEl.append(toggle);
  }
  if (!ready) accessEl.append(element('span', 'muted', 'Unlock changes access for Browser Controller on this device. It does not ask for a master password.'));

  if (ready && state?.grants?.length) {
    // Site approvals are listed under Site access; these are one session's own grants.
    for (const grant of state.grants.filter((item) => item.purpose !== 'site')) {
      const row = element('div', 'grant-row');
      const details = element('div', 'account-copy');
      details.append(element('strong', '', `${grant.oneShot ? 'One fill' : grant.purpose === 'fill' ? 'Session fill' : 'Session list'} · ${grant.origin}`));
      details.append(element('span', '', `${grant.sessionLabel || 'Connected session'}${grant.handle ? ` · account ${grant.handle.slice(0, 13)}` : ''}`));
      row.append(details, actionButton('Revoke', 'danger', () => invoke({ operation: 'revoke', grantId: grant.grantId }, 'Session grant revoked.')));
      accessEl.append(row);
    }
  }
}

async function loadBackups() {
  const response = await rpc({ operation: 'listBackups' });
  if (response.success !== true) {
    backupsEl.replaceChildren(element('p', 'muted', explain(response)));
    return;
  }
  backupsLoaded = true;
  backupsEl.replaceChildren();
  backupsEl.append(element('p', 'muted', 'These protected local recovery snapshots contain both encrypted account data and the decryption key. Anyone with a copy can recover the accounts. Keep the vault folder private.'));
  const backups = Array.isArray(response.backups) ? response.backups : [];
  if (!backups.length) {
    backupsEl.append(element('p', 'muted', 'No protected recovery snapshots yet.'));
    return;
  }
  for (const backup of backups) {
    const row = element('div', 'backup-row');
    const details = element('div', 'account-copy');
    details.append(element('strong', '', new Date(backup.createdAt).toLocaleString()));
    details.append(element('span', '', backup.id));
    row.append(details, actionButton('Restore', '', async () => {
      if (!window.confirm('Restore this encrypted snapshot? The current vault state is preserved in the vault’s restore journal.')) return;
      const result = await invoke({ operation: 'restore', backupId: backup.id }, 'Backup restored. Review the account list before continuing.');
      if (result?.success) await loadBackups();
    }));
    backupsEl.append(row);
  }
}

function entryField(name) {
  return form.elements.namedItem(name);
}

function showEntryForm(entry) {
  editingHandle = entry?.id || null;
  form.reset();
  form.hidden = false;
  $('#entryTitle').textContent = entry ? 'Replace saved password' : 'Add an account';
  const origin = entryField('origin');
  const label = entryField('label');
  const identifier = entryField('identifier');
  const password = entryField('password');
  origin.value = entry?.origin || '';
  origin.readOnly = !!entry;
  label.value = entry?.label || '';
  identifier.value = entry?.identifier || '';
  password.value = '';
  password.autocomplete = 'new-password';
  form.querySelector('button[type="submit"]').textContent = entry ? 'Replace password' : 'Save account';
  origin.focus();
}

function editEntry(entry) {
  showEntryForm(entry);
  form.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

$('#entryForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy || !form.reportValidity()) return;
  const origin = entryField('origin');
  const label = entryField('label');
  const identifier = entryField('identifier');
  const password = entryField('password');
  const payload = {
    operation: 'save',
    ...(editingHandle ? { handle: editingHandle } : {}),
    origin: origin.value.trim(), label: label.value.trim(), identifier: identifier.value.trim(),
    password: password.value, allowSession: false, saveAndFill: false,
  };
  password.value = '';
  const result = await invoke(payload, editingHandle ? 'Password replaced. The previous password was not shown.' : 'Account saved.');
  payload.password = '';
  if (result?.success) {
    form.reset();
    form.hidden = true;
    editingHandle = null;
  }
});

addButton.addEventListener('click', () => showEntryForm(null));
$('#cancelEdit').addEventListener('click', () => {
  form.reset();
  form.hidden = true;
  editingHandle = null;
});

void refreshState();
window.setInterval(() => {
  if (document.visibilityState === 'visible' && !busy) void refreshState({ keepNotice: true });
}, 5_000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void refreshState({ keepNotice: true });
});
