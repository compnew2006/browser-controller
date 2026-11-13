import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPortableVaultPage } from '../extension/vault/portable-vault-page.js';

class Control {
  value = '';
  textContent = '';
  hidden = false;
  disabled = false;
  checked = false;
  focused = false;
  href = '';
  download = '';
  files: Array<{ size: number; arrayBuffer(): Promise<ArrayBuffer> }> = [];
  dataset: Record<string, string> = {};
  validityMessage = '';
  submitButton = { disabled: false };
  listeners = new Map<string, (event: { preventDefault(): void }) => unknown>();

  addEventListener(type: string, listener: (event: { preventDefault(): void }) => unknown) { this.listeners.set(type, listener); }
  querySelector(selector: string) { return selector === 'button[type="submit"]' ? this.submitButton : null; }
  removeAttribute(name: string) { if (name === 'href') this.href = ''; }
  setCustomValidity(value: string) { this.validityMessage = value; }
  focus() { this.focused = true; }
  async fire(type: string) { return this.listeners.get(type)?.({ preventDefault() {} }); }
}

const ids = [
  'portableExportForm', 'portableImportForm', 'exportPassphrase', 'exportPassphraseConfirm', 'portableFile',
  'importPassphrase', 'portableReview', 'portableReviewSummary', 'confirmPortableReplace', 'commitPassphrase',
  'commitPortable', 'portableStatus', 'portableAvailability', 'cancelPortableTransfer', 'savePortableArchive',
];

function setup(rpc: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>, onImported = vi.fn()) {
  const elements = new Map(ids.map((id) => [`#${id}`, new Control()]));
  const listeners = new Map<string, () => unknown>();
  vi.stubGlobal('document', { querySelector: (selector: string) => elements.get(selector) });
  vi.stubGlobal('window', { addEventListener: (type: string, listener: () => unknown) => listeners.set(type, listener) });
  vi.stubGlobal('URL', class {
    static createObjectURL = vi.fn(() => 'blob:portable-vault');
    static revokeObjectURL = vi.fn();
  });
  const page = createPortableVaultPage({ rpc, onImported });
  return {
    page,
    el: (id: string) => elements.get(`#${id}`)!,
    pagehide: () => listeners.get('pagehide')?.(),
    onImported,
  };
}

function archiveFile(bytes = [123, 125]) {
  const data = new Uint8Array(bytes);
  return { size: data.length, arrayBuffer: async () => data.slice().buffer };
}

afterEach(() => vi.unstubAllGlobals());

describe('portable vault private page', () => {
  it('enables only the actions supported by the current vault state', () => {
    const { page, el } = setup(vi.fn());
    expect(el('portableAvailability').textContent).toContain('unavailable');
    expect(el('portableImportForm').submitButton.disabled).toBe(true);

    page.updateVaultState({ status: 'locked' });
    expect(el('portableAvailability').textContent).toContain('Unlock');
    expect(el('portableExportForm').submitButton.disabled).toBe(true);

    page.updateVaultState({ status: 'empty' });
    expect(el('portableAvailability').textContent).toContain('empty profile');
    expect(el('portableFile').disabled).toBe(false);
    expect(el('portableExportForm').submitButton.disabled).toBe(true);

    page.updateVaultState({ status: 'incomplete' });
    expect(el('portableAvailability').textContent).toContain('recovery');
    expect(el('portableFile').disabled).toBe(true);

    page.updateVaultState({ status: 'ready' });
    expect(el('portableAvailability').textContent).toContain('replaces saved accounts');
    expect(el('portableExportForm').submitButton.disabled).toBe(false);
    page.setExternalBusy(true);
    expect(el('portableExportForm').submitButton.disabled).toBe(true);
    page.setExternalBusy(false);
  });

  it('requires matching long passphrases and exports an encrypted archive for a separate save click', async () => {
    const rpc = vi.fn(async (payload: Record<string, unknown>) => payload.operation === 'portableExportStart'
      ? { success: true, transferId: 'export-1', byteLength: 3, chunkBytes: 3 }
      : { success: true, offset: 0, done: true, chunkBase64: btoa('abc') });
    const { page, el, pagehide } = setup(rpc);
    page.updateVaultState({ status: 'ready' });

    el('exportPassphrase').value = 'short';
    el('exportPassphraseConfirm').value = 'short';
    await el('portableExportForm').fire('submit');
    expect(el('portableStatus').textContent).toContain('at least 12 characters');
    expect(el('exportPassphrase').focused).toBe(true);
    expect(rpc).not.toHaveBeenCalled();

    el('exportPassphrase').value = 'correct horse battery';
    el('exportPassphraseConfirm').value = 'different phrase';
    await el('portableExportForm').fire('submit');
    expect(el('portableStatus').textContent).toContain('do not match');
    expect(el('exportPassphraseConfirm').focused).toBe(true);

    el('exportPassphraseConfirm').value = 'correct horse battery';
    await el('portableExportForm').fire('submit');
    expect(rpc.mock.calls.map(([payload]) => payload.operation)).toEqual(['portableExportStart', 'portableExportChunk']);
    expect(el('exportPassphrase').value).toBe('');
    expect(el('exportPassphraseConfirm').value).toBe('');
    expect(el('savePortableArchive').hidden).toBe(false);
    expect(el('savePortableArchive').href).toBe('blob:portable-vault');
    expect(el('savePortableArchive').download).toMatch(/^browser-controller-vault-\d{4}-\d{2}-\d{2}\.json$/u);
    expect(el('portableStatus').textContent).toContain('Select “Save portable copy”');
    el('savePortableArchive').fire('click');
    pagehide();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:portable-vault');
    expect(el('savePortableArchive').hidden).toBe(true);
  });

  it('keeps an uploaded file for passphrase retry, requires confirmation, and supports a later successful commit', async () => {
    let previews = 0;
    let commits = 0;
    const rpc = vi.fn(async (payload: Record<string, unknown>) => {
      if (payload.operation === 'portableImportStart') return { success: true, transferId: 'import-1', chunkBytes: 2 };
      if (payload.operation === 'portableImportChunk') return { success: true, received: 2, done: true };
      if (payload.operation === 'portableImportPreview' && previews++ === 0) return { success: false, code: 'VAULT_STORAGE_INVALID' };
      if (payload.operation === 'portableImportPreview') return { success: true, previewToken: 'preview-1', entryCount: 1, allowlistCount: 2 };
      if (payload.operation === 'portableImportCommit' && commits++ === 0) return { success: false, code: 'RESPONSE_TOO_LARGE' };
      return { success: true, entryCount: 1, allowlistCount: 2 };
    });
    const { page, el, onImported } = setup(rpc);
    page.updateVaultState({ status: 'empty' });
    el('portableFile').files = [archiveFile()];
    el('importPassphrase').value = 'correct horse battery';
    await el('portableImportForm').fire('submit');
    expect(el('importPassphrase').value).toBe('');
    expect(el('portableStatus').textContent).toContain('Check the passphrase');
    expect(rpc.mock.calls.filter(([payload]) => payload.operation === 'portableImportStart')).toHaveLength(1);

    el('importPassphrase').value = 'correct horse battery';
    await el('portableImportForm').fire('submit');
    expect(el('portableReview').hidden).toBe(false);
    expect(el('portableReviewSummary').textContent).toContain('1 saved account and 2 always allowed sites');
    expect(el('commitPortable').disabled).toBe(true);
    expect(rpc.mock.calls.filter(([payload]) => payload.operation === 'portableImportStart')).toHaveLength(1);

    el('confirmPortableReplace').checked = true;
    await el('confirmPortableReplace').fire('change');
    el('commitPassphrase').value = 'correct horse battery';
    await el('commitPassphrase').fire('input');
    expect(el('commitPortable').disabled).toBe(false);
    await el('commitPortable').fire('click');
    expect(el('commitPassphrase').value).toBe('');
    expect(el('portableStatus').textContent).toContain('larger than this vault can store');
    expect(el('portableReview').hidden).toBe(false);

    el('commitPassphrase').value = 'correct horse battery';
    await el('commitPassphrase').fire('input');
    await el('commitPortable').fire('click');
    expect(rpc.mock.calls.filter(([payload]) => payload.operation === 'portableImportCommit')).toHaveLength(2);
    expect(onImported).toHaveBeenCalledOnce();
    expect(el('portableFile').value).toBe('');
    expect(el('portableReview').hidden).toBe(true);
    expect(el('portableStatus').textContent).toContain('A local recovery copy was created');
  });

  it('rejects oversized files and cancels an active upload through the private channel', async () => {
    let finishChunk!: (result: Record<string, unknown>) => void;
    const rpc = vi.fn((payload: Record<string, unknown>) => {
      if (payload.operation === 'portableImportStart') return Promise.resolve({ success: true, transferId: 'cancel-me', chunkBytes: 2 });
      if (payload.operation === 'portableImportChunk') return new Promise<Record<string, unknown>>((resolve) => { finishChunk = resolve; });
      return Promise.resolve({ success: true });
    });
    const { page, el } = setup(rpc);
    page.updateVaultState({ status: 'ready' });
    el('portableFile').files = [{ size: 10 * 1024 * 1024 + 1, arrayBuffer: async () => new ArrayBuffer(0) }];
    el('importPassphrase').value = 'correct horse battery';
    await el('portableImportForm').fire('submit');
    expect(el('portableStatus').textContent).toContain('10 MiB or smaller');
    expect(rpc).not.toHaveBeenCalled();

    el('portableFile').files = [archiveFile()];
    const pendingUpload = el('portableImportForm').fire('submit');
    await vi.waitFor(() => expect(finishChunk).toBeTypeOf('function'));
    await el('cancelPortableTransfer').fire('click');
    expect(rpc.mock.calls.some(([payload]) => payload.operation === 'portableTransferCancel' && payload.transferId === 'cancel-me')).toBe(true);
    finishChunk({ success: true, received: 2, done: true });
    await pendingUpload;
    expect(el('portableStatus').textContent).toContain('Transfer cancelled');
    expect(el('portableReview').hidden).toBe(true);
  });
});
