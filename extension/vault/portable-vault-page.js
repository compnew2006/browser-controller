const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024;
const MAX_CHUNK_BYTES = 256 * 1024;
const MIN_PASSPHRASE_CODE_POINTS = 12;
const MAX_PASSPHRASE_BYTES = 1024;

function bytesToBase64(bytes) {
  let binary = '';
  const partSize = 32 * 1024;
  for (let offset = 0; offset < bytes.length; offset += partSize) {
    const end = Math.min(offset + partSize, bytes.length);
    for (let index = offset; index < end; index += 1) binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > Math.ceil(MAX_CHUNK_BYTES / 3) * 4) {
    throw new Error('INVALID_TRANSFER');
  }
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytes.length === 0 || bytes.length > MAX_CHUNK_BYTES || bytesToBase64(bytes) !== value) {
    bytes.fill(0);
    throw new Error('INVALID_TRANSFER');
  }
  return bytes;
}

function passphraseError(value) {
  if ([...value].length < MIN_PASSPHRASE_CODE_POINTS) return 'Use a passphrase with at least 12 characters.';
  if (new TextEncoder().encode(value).length > MAX_PASSPHRASE_BYTES) return 'The passphrase must be 1,024 bytes or fewer.';
  return '';
}

function responseMessage(response, operation) {
  if (response?.code === 'VAULT_STORAGE_INVALID') {
    if (operation === 'preview') return 'The file could not be opened. Check the passphrase and make sure the file is complete and supported.';
    if (operation === 'commit') return 'The vault could not be replaced safely. The existing data was preserved; review recovery status before trying again.';
    return 'The vault could not be read safely. Review its status and try again.';
  }
  if (response?.code === 'RESPONSE_TOO_LARGE') {
    return operation === 'commit'
      ? 'This copy is larger than this vault can store. The current vault was preserved.'
      : 'The portable copy is larger than the 10 MiB limit.';
  }
  const messages = {
    INVALID_ARGUMENT: 'Check the selected file and passphrase, then try again.',
    NOT_CONNECTED: 'The private vault connection was lost. Reconnect and try again.',
    VAULT_BUSY: 'Another vault operation is running. Wait a moment and try again.',
    VAULT_LOCKED: 'Unlock the vault before using a portable copy.',
    VAULT_RECOVERY_REQUIRED: 'Resolve the vault recovery state before using a portable copy.',
    VAULT_PERMISSION_DENIED: 'This transfer is no longer available. Start again from the selected file.',
    VAULT_EXTENSION_REQUIRED: 'Restart the Browser Controller daemon, then reload this page.',
  };
  return messages[response?.code] || 'The portable copy could not be completed safely. The current vault was preserved.';
}

/** Owns only the private page's passphrase and encrypted portable-file workflows. */
export function createPortableVaultPage({ rpc, onImported = async () => {}, isExternalBusy = () => false }) {
  const $ = (selector) => document.querySelector(selector);
  const exportForm = $('#portableExportForm');
  const importForm = $('#portableImportForm');
  const exportPassphrase = $('#exportPassphrase');
  const exportPassphraseConfirm = $('#exportPassphraseConfirm');
  const fileInput = $('#portableFile');
  const importPassphrase = $('#importPassphrase');
  const preview = $('#portableReview');
  const previewSummary = $('#portableReviewSummary');
  const confirmReplace = $('#confirmPortableReplace');
  const commitPassphrase = $('#commitPassphrase');
  const commitButton = $('#commitPortable');
  const status = $('#portableStatus');
  const availability = $('#portableAvailability');
  const cancelButton = $('#cancelPortableTransfer');
  const saveLink = $('#savePortableArchive');

  let vaultState = null;
  let transfer = null;
  let transferBusy = false;
  let externalBusy = false;
  let objectUrl = null;
  let objectUrlTimer = null;

  function setStatus(message, kind = '') {
    status.textContent = message;
    status.dataset.kind = kind;
    status.hidden = !message;
  }

  function revokeObjectUrl() {
    if (objectUrlTimer !== null) clearTimeout(objectUrlTimer);
    objectUrlTimer = null;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null;
    saveLink.removeAttribute('href');
    saveLink.hidden = true;
  }

  function canUsePortableCopy() {
    return vaultState?.status === 'ready' || vaultState?.status === 'empty';
  }

  function updateControls() {
    const blocked = transferBusy || externalBusy || isExternalBusy();
    const available = canUsePortableCopy();
    const importReviewActive = transfer?.direction === 'import'
      && ['uploaded', 'previewed', 'committing'].includes(transfer.phase);
    const commitPassphraseReady = !passphraseError(commitPassphrase.value);

    exportPassphrase.disabled = blocked || vaultState?.status !== 'ready';
    exportPassphraseConfirm.disabled = blocked || vaultState?.status !== 'ready';
    exportForm.querySelector('button[type="submit"]').disabled = blocked || vaultState?.status !== 'ready';

    fileInput.disabled = blocked || !available || importReviewActive;
    importPassphrase.disabled = blocked || !available || (importReviewActive && transfer?.phase !== 'uploaded');
    importForm.querySelector('button[type="submit"]').disabled = blocked || !available || importReviewActive && transfer?.phase !== 'uploaded';

    confirmReplace.disabled = blocked || !available || transfer?.phase !== 'previewed';
    commitPassphrase.disabled = blocked || !available || transfer?.phase !== 'previewed';
    commitButton.disabled = blocked || !available || transfer?.phase !== 'previewed' || !confirmReplace.checked || !commitPassphraseReady;
    cancelButton.hidden = !transfer;
    cancelButton.disabled = externalBusy || isExternalBusy() || transfer?.phase === 'committing' || transfer?.cancelled === true;
  }

  function updateVaultState(nextState) {
    vaultState = nextState && typeof nextState === 'object' ? nextState : null;
    if (vaultState?.status === 'ready') {
      availability.textContent = 'Export and import are available. Import replaces saved accounts and always allowed sites.';
    } else if (vaultState?.status === 'empty') {
      availability.textContent = 'Import is available for this empty profile. Create a vault first to export a copy.';
    } else if (vaultState?.status === 'locked') {
      availability.textContent = 'Unlock the vault before using a portable copy.';
    } else if (vaultState?.status === 'incomplete') {
      availability.textContent = 'Resolve vault recovery before using a portable copy.';
    } else {
      availability.textContent = 'The private vault connection is unavailable.';
    }
    updateControls();
  }

  function setExternalBusy(value) {
    externalBusy = value === true;
    updateControls();
  }

  function resetPreview() {
    preview.hidden = true;
    previewSummary.textContent = '';
    confirmReplace.checked = false;
    commitPassphrase.value = '';
    commitPassphrase.setCustomValidity('');
  }

  function setTransferStatus(message, kind = '') {
    setStatus(message, kind);
  }

  function assertCurrent(current) {
    if (current.cancelled || transfer !== current) throw new Error('TRANSFER_CANCELLED');
  }

  async function cancelOnDaemon(current) {
    if (!current.transferId) return;
    try {
      await rpc({ operation: 'portableTransferCancel', transferId: current.transferId });
    } catch {
      // Closing the private page also clears every transfer owned by its connection.
    }
  }

  async function cancelTransfer() {
    const current = transfer;
    if (!current || current.phase === 'committing' || current.cancelled) return;
    current.cancelled = true;
    transfer = null;
    revokeObjectUrl();
    resetPreview();
    fileInput.value = '';
    setTransferStatus('Cancelling transfer…');
    updateControls();
    await cancelOnDaemon(current);
    setTransferStatus('Transfer cancelled. The vault was not changed.', 'success');
    updateControls();
  }

  function ensureVaultCanExport() {
    if (vaultState?.status !== 'ready') {
      setTransferStatus(responseMessage({ code: vaultState?.status === 'incomplete' ? 'VAULT_RECOVERY_REQUIRED' : 'VAULT_LOCKED' }, 'export'), 'error');
      return false;
    }
    return true;
  }

  function ensureVaultCanImport() {
    if (!canUsePortableCopy()) {
      const code = vaultState?.status === 'incomplete' ? 'VAULT_RECOVERY_REQUIRED' : 'VAULT_LOCKED';
      setTransferStatus(responseMessage({ code }, 'preview'), 'error');
      return false;
    }
    return true;
  }

  async function prepareExport(event) {
    event.preventDefault();
    if (transferBusy || !ensureVaultCanExport()) return;
    const password = exportPassphrase.value;
    const passwordError = passphraseError(password);
    if (passwordError) {
      setTransferStatus(passwordError, 'error');
      exportPassphrase.focus();
      return;
    }
    if (password !== exportPassphraseConfirm.value) {
      setTransferStatus('The passphrases do not match.', 'error');
      exportPassphraseConfirm.focus();
      return;
    }

    revokeObjectUrl();
    resetPreview();
    const current = { direction: 'export', phase: 'starting', transferId: null, cancelled: false };
    transfer = current;
    transferBusy = true;
    setTransferStatus('Preparing encrypted portable copy…');
    updateControls();
    let archive;
    try {
      let startPromise;
      try {
        startPromise = rpc({ operation: 'portableExportStart', passphrase: password });
      } finally {
        exportPassphrase.value = '';
        exportPassphraseConfirm.value = '';
      }
      const started = await startPromise;
      if (started?.success !== true) throw Object.assign(new Error('EXPORT_FAILED'), { response: started });
      if (typeof started.transferId !== 'string' || !Number.isSafeInteger(started.byteLength)
        || started.byteLength <= 0 || started.byteLength > MAX_ARCHIVE_BYTES
        || !Number.isSafeInteger(started.chunkBytes) || started.chunkBytes <= 0 || started.chunkBytes > MAX_CHUNK_BYTES) {
        throw new Error('INVALID_TRANSFER');
      }
      current.transferId = started.transferId;
      current.phase = 'exporting';
      assertCurrent(current);
      if (current.cancelled) {
        await cancelOnDaemon(current);
        throw new Error('TRANSFER_CANCELLED');
      }

      archive = new Uint8Array(started.byteLength);
      let offset = 0;
      while (offset < archive.length) {
        assertCurrent(current);
        const result = await rpc({ operation: 'portableExportChunk', transferId: current.transferId, offset });
        assertCurrent(current);
        if (result?.success !== true) throw Object.assign(new Error('EXPORT_FAILED'), { response: result });
        const chunk = base64ToBytes(result.chunkBase64);
        try {
          const nextOffset = offset + chunk.length;
          if (result.offset !== offset || nextOffset > archive.length || result.done !== (nextOffset === archive.length)) {
            throw new Error('INVALID_TRANSFER');
          }
          archive.set(chunk, offset);
          offset = nextOffset;
        } finally {
          chunk.fill(0);
        }
        setTransferStatus(`Preparing encrypted copy… ${Math.floor((offset / archive.length) * 100)}%`);
      }
      assertCurrent(current);
      const blob = new Blob([archive], { type: 'application/json' });
      objectUrl = URL.createObjectURL(blob);
      saveLink.href = objectUrl;
      saveLink.download = `browser-controller-vault-${new Date().toISOString().slice(0, 10)}.json`;
      saveLink.hidden = false;
      setTransferStatus('Your encrypted copy is ready. Select “Save portable copy” to choose where to save it.', 'success');
      current.phase = 'complete';
      transfer = null;
      objectUrlTimer = setTimeout(revokeObjectUrl, 5 * 60 * 1000);
    } catch (error) {
      if (error?.message === 'TRANSFER_CANCELLED') {
        await cancelOnDaemon(current);
      } else {
        await cancelOnDaemon(current);
        setTransferStatus(responseMessage(error?.response, 'export'), 'error');
      }
      if (transfer === current) transfer = null;
    } finally {
      archive?.fill(0);
      transferBusy = false;
      updateControls();
    }
  }

  async function uploadFile(current, file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      const started = await rpc({ operation: 'portableImportStart', byteLength: bytes.length });
      if (started?.success !== true) throw Object.assign(new Error('UPLOAD_FAILED'), { response: started });
      current.transferId = started.transferId;
      current.phase = 'uploading';
      assertCurrent(current);
      if (typeof started.transferId !== 'string' || !Number.isSafeInteger(started.chunkBytes)
        || started.chunkBytes <= 0 || started.chunkBytes > MAX_CHUNK_BYTES) throw new Error('INVALID_TRANSFER');
      let offset = 0;
      while (offset < bytes.length) {
        assertCurrent(current);
        const end = Math.min(offset + started.chunkBytes, bytes.length);
        const chunk = bytes.subarray(offset, end);
        const chunkBase64 = bytesToBase64(chunk);
        const result = await rpc({ operation: 'portableImportChunk', transferId: current.transferId, offset, chunkBase64 });
        assertCurrent(current);
        if (result?.success !== true) throw Object.assign(new Error('UPLOAD_FAILED'), { response: result });
        const nextOffset = end;
        if (result.received !== nextOffset || result.done !== (nextOffset === bytes.length)) throw new Error('INVALID_TRANSFER');
        offset = nextOffset;
        setTransferStatus(`Checking encrypted file… ${Math.floor((offset / bytes.length) * 100)}%`);
      }
      current.phase = 'uploaded';
    } finally {
      bytes.fill(0);
    }
  }

  async function previewImport(event) {
    event.preventDefault();
    if (transferBusy || !ensureVaultCanImport()) return;
    const password = importPassphrase.value;
    const passwordError = passphraseError(password);
    if (passwordError) {
      setTransferStatus(passwordError, 'error');
      importPassphrase.focus();
      return;
    }

    let current = transfer?.direction === 'import' && transfer.phase === 'uploaded' ? transfer : null;
    const file = fileInput.files?.[0];
    if (!current) {
      if (!file) {
        setTransferStatus('Choose a portable copy file first.', 'error');
        fileInput.focus();
        return;
      }
      if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > MAX_ARCHIVE_BYTES) {
        setTransferStatus('Choose a non-empty portable copy file that is 10 MiB or smaller.', 'error');
        fileInput.focus();
        return;
      }
      resetPreview();
      current = { direction: 'import', phase: 'starting', transferId: null, previewToken: null, cancelled: false };
      transfer = current;
    }

    transferBusy = true;
    setTransferStatus(current.phase === 'uploaded' ? 'Checking the file passphrase…' : 'Uploading encrypted file…');
    updateControls();
    try {
      if (current.phase !== 'uploaded') await uploadFile(current, file);
      assertCurrent(current);
      let previewPromise;
      try {
        previewPromise = rpc({ operation: 'portableImportPreview', transferId: current.transferId, passphrase: password });
      } finally {
        importPassphrase.value = '';
      }
      const result = await previewPromise;
      if (result?.success !== true) {
        current.phase = 'uploaded';
        throw Object.assign(new Error('PREVIEW_FAILED'), { response: result });
      }
      assertCurrent(current);
      if (typeof result.previewToken !== 'string' || !Number.isSafeInteger(result.entryCount)
        || !Number.isSafeInteger(result.allowlistCount) || result.entryCount < 0 || result.allowlistCount < 0) {
        throw new Error('INVALID_TRANSFER');
      }
      current.previewToken = result.previewToken;
      current.phase = 'previewed';
      previewSummary.textContent = `This file contains ${result.entryCount} saved account${result.entryCount === 1 ? '' : 's'} and ${result.allowlistCount} always allowed site${result.allowlistCount === 1 ? '' : 's'}. The destination will be replaced after confirmation.`;
      preview.hidden = false;
      setTransferStatus('File checked. Review the counts, confirm replacement, and re-enter the passphrase to continue.', 'success');
    } catch (error) {
      if (error?.message === 'TRANSFER_CANCELLED') {
        await cancelOnDaemon(current);
      } else {
        if (error?.message !== 'PREVIEW_FAILED' && current.phase !== 'uploaded') await cancelOnDaemon(current);
        setTransferStatus(responseMessage(error?.response, current.phase === 'uploaded' ? 'preview' : 'upload'), 'error');
      }
      if (error?.message !== 'PREVIEW_FAILED' && transfer === current && current.phase !== 'uploaded') transfer = null;
    } finally {
      transferBusy = false;
      updateControls();
    }
  }

  async function commitImport() {
    if (transferBusy || transfer?.phase !== 'previewed' || !ensureVaultCanImport()) return;
    if (!confirmReplace.checked) {
      setTransferStatus('Confirm that you want to replace this profile’s vault.', 'error');
      confirmReplace.focus();
      return;
    }
    const password = commitPassphrase.value;
    const passwordError = passphraseError(password);
    if (passwordError) {
      setTransferStatus(passwordError, 'error');
      commitPassphrase.focus();
      return;
    }

    const current = transfer;
    current.phase = 'committing';
    transferBusy = true;
    setTransferStatus('Replacing the vault and creating a local recovery copy…');
    updateControls();
    let commitPromise;
    try {
      try {
        commitPromise = rpc({
          operation: 'portableImportCommit',
          previewToken: current.previewToken,
          passphrase: password,
          confirmReplace: true,
        });
      } finally {
        commitPassphrase.value = '';
      }
      const result = await commitPromise;
      if (result?.success !== true) {
        current.phase = 'previewed';
        throw Object.assign(new Error('COMMIT_FAILED'), { response: result });
      }
      transfer = null;
      fileInput.value = '';
      resetPreview();
      setTransferStatus(`Vault replaced. Imported ${result.entryCount} account${result.entryCount === 1 ? '' : 's'} and ${result.allowlistCount} allowed site${result.allowlistCount === 1 ? '' : 's'}. A local recovery copy was created.`, 'success');
      await onImported();
    } catch (error) {
      if (error?.message === 'COMMIT_FAILED') {
        setTransferStatus(responseMessage(error.response, 'commit'), 'error');
      } else {
        setTransferStatus('The vault could not be replaced safely. Review its status before trying again.', 'error');
      }
    } finally {
      transferBusy = false;
      updateControls();
    }
  }

  exportForm.addEventListener('submit', prepareExport);
  importForm.addEventListener('submit', previewImport);
  commitButton.addEventListener('click', commitImport);
  cancelButton.addEventListener('click', cancelTransfer);
  confirmReplace.addEventListener('change', updateControls);
  commitPassphrase.addEventListener('input', updateControls);
  fileInput.addEventListener('change', () => {
    if (transfer?.direction === 'import' && !transferBusy) void cancelTransfer();
    resetPreview();
    setStatus('');
    updateControls();
  });
  saveLink.addEventListener('click', () => {
    objectUrlTimer = setTimeout(revokeObjectUrl, 1000);
  });
  window.addEventListener('pagehide', () => {
    if (transfer) {
      transfer.cancelled = true;
      void cancelOnDaemon(transfer);
    }
    revokeObjectUrl();
  }, { once: true });

  resetPreview();
  updateVaultState(null);
  return { updateVaultState, setExternalBusy, cancelTransfer };
}
