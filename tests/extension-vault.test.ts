import { beforeEach, describe, expect, it } from 'vitest';
import vm from 'node:vm';

type Frame = { frameId: number; documentId: string; url: string };
const frames: Frame[] = [];
const injected: Array<Record<string, any>> = [];
const candidatesByDocument = new Map<string, number>();
let savedRuntimeState: any = { protectionSequence: 0, protectedDocuments: [], pendingRemovals: [] };
const localValues: Record<string, unknown> = {};
let rejectSessionWrites = false;

const executeScriptStub = async (request: Record<string, any>) => {
  injected.push(request);
  const documentId = request.target.documentIds[0];
  const frame = frames.find((item) => item.documentId === documentId);
  if (!frame) return [];
  if (request.func.name === 'inspectPasswordField') {
    const candidateCount = candidatesByDocument.get(documentId) ?? 0;
    return [{ frameId: frame.frameId, documentId, result: {
      candidateCount, suitable: candidateCount === 1, documentOrigin: new URL(frame.url).origin,
    } }];
  }
  if (request.func.name === 'fillInspectedPassword') {
    return [{ frameId: frame.frameId, documentId, result: { success: true, retained: true, filled_fields: 1 } }];
  }
  return [{ frameId: frame.frameId, documentId, result: true }];
};

(globalThis as any).chrome = {
  runtime: { id: 'fixture-extension', getURL: (path: string) => `chrome-extension://fixture-extension/${path}` },
  tabs: {
    get: async () => ({ id: 12, url: 'https://fixture.test/login' }),
    query: async () => [{ id: 12, url: 'https://fixture.test/login' }],
  },
  webNavigation: {
    getFrame: async () => frames.find((frame) => frame.frameId === 0),
    getAllFrames: async () => frames.map((frame) => ({ ...frame })),
  },
  scripting: { executeScript: executeScriptStub },
  storage: {
    session: {
      get: async () => savedRuntimeState === undefined ? {} : ({ bcVaultRuntimeState: savedRuntimeState }),
      set: async (value: Record<string, any>) => {
        if (rejectSessionWrites) throw new Error('fixture storage failure');
        savedRuntimeState = value.bcVaultRuntimeState;
      },
    },
    local: {
      get: async () => ({ ...localValues }),
      set: async (value: Record<string, unknown>) => { Object.assign(localValues, value); },
      remove: async (key: string) => { delete localValues[key]; },
    },
  },
};

const vault = await import('../extension/lib/vault-actions.js');

class FixtureInput {
  type = 'password';
  disabled = false;
  readOnly = false;
  isConnected = true;
  labels: Array<{ textContent: string }> = [];
  form: any = null;
  shadowRoot: FixtureRoot | null = null;
  private currentValue = '';

  constructor(public ownerDocument: FixtureDocument, private attributes: Record<string, string> = {}) {}
  get autocomplete() { return this.attributes.autocomplete ?? ''; }
  get name() { return this.attributes.name ?? ''; }
  get id() { return this.attributes.id ?? ''; }
  get placeholder() { return this.attributes.placeholder ?? ''; }
  get value() { return this.currentValue; }
  set value(value: string) { this.currentValue = value; }
  getAttribute(name: string) { return this.attributes[name] ?? null; }
  getBoundingClientRect() { return { width: 140, height: 24 }; }
  getClientRects() { return [{}]; }
  dispatchEvent() { return true; }
}

class FixtureRoot {
  constructor(public fields: FixtureInput[] = [], public elements: any[] = [], public controls: any[] = []) {}
  querySelectorAll(selector: string) {
    if (selector === 'input[type="password"]') return this.fields;
    if (selector === '*') return this.elements;
    if (selector.startsWith('button')) return this.controls;
    return [];
  }
}

class FixtureDocument extends FixtureRoot {
  constructor(fields: FixtureInput[] = [], elements: any[] = []) { super(fields, elements); }
}

function installPage(fields: FixtureInput[], elements: any[] = []) {
  const doc = new FixtureDocument(fields, elements);
  for (const field of fields) field.ownerDocument = doc;
  (globalThis as any).document = doc;
  (globalThis as any).location = { origin: 'https://fixture.test' };
  (globalThis as any).HTMLInputElement = FixtureInput;
  (globalThis as any).getComputedStyle = () => ({ display: 'block', visibility: 'visible', opacity: '1' });
  (globalThis as any).Event = class { constructor(public type: string) {} };
  return doc;
}

describe('extension vault inspection and one-shot fill', () => {
  const defaultTabsGet = (globalThis as any).chrome.tabs.get;

  beforeEach(async () => {
    (globalThis as any).chrome.tabs.get = defaultTabsGet;
    frames.splice(0, frames.length,
      { frameId: 0, documentId: 'top-document', url: 'https://fixture.test/login' },
      { frameId: 7, documentId: 'same-origin-frame', url: 'https://fixture.test/frame' });
    candidatesByDocument.clear();
    candidatesByDocument.set('same-origin-frame', 1);
    injected.length = 0;
    savedRuntimeState = { protectionSequence: 0, protectedDocuments: [], pendingRemovals: [] };
    delete localValues.bcVaultMayHaveSensitiveContext;
    rejectSessionWrites = false;
    await vault.restoreVaultRuntimeState();
  });

  it('reports an unsupported page origin as unsupported, not as a missing password field', async () => {
    (globalThis as any).chrome.tabs.get = async () => ({ id: 12, url: 'http://example.test/login' });
    const result = await vault.handleVaultAction('inspect', { tabId: 12 });
    expect(result).toMatchObject({ success: false, code: 'VAULT_ORIGIN_UNSUPPORTED' });
  });

  it('keeps the code a vault check threw instead of flattening it to VAULT_TARGET_UNSAFE', async () => {
    frames[1] = { frameId: 7, documentId: '', url: 'https://fixture.test/frame' };
    const result = await vault.handleVaultAction('inspect', { tabId: 12 });
    expect(result).toMatchObject({ success: false, code: 'VAULT_DOCUMENT_CHANGED' });
  });

  it('reports a tab that cannot be read as a changed document', async () => {
    (globalThis as any).chrome.tabs.get = async () => { throw new Error('No tab with id: 12.'); };
    const result = await vault.handleVaultAction('inspect', { tabId: 12 });
    expect(result).toMatchObject({ success: false, code: 'VAULT_DOCUMENT_CHANGED' });
  });

  it('reports a page that never answered as unresponsive', async () => {
    const wedged = Object.assign(new Error('TAB_WEDGED: tab 12 did not respond'), { code: 'TAB_WEDGED' });
    (globalThis as any).chrome.scripting.executeScript = async (request: Record<string, any>) => {
      injected.push(request);
      throw wedged;
    };
    try {
      const result = await vault.handleVaultAction('inspect', { tabId: 12 });
      expect(result).toMatchObject({ success: false, code: 'VAULT_PAGE_UNRESPONSIVE' });
    } finally {
      (globalThis as any).chrome.scripting.executeScript = executeScriptStub;
    }
  });

  it('inspects across same-origin frames and fills only the inspected document ID', async () => {
    const inspected = await vault.handleVaultAction('inspect', { tabId: 12 });
    expect(inspected).toMatchObject({
      success: true, suitable: true, documentId: 'top-document',
      targetDocumentId: 'same-origin-frame', frameId: 7,
    });
    expect(injected.filter((item) => item.func.name === 'inspectPasswordField').map((item) => item.target))
      .toEqual([{ tabId: 12, documentIds: ['top-document'] }, { tabId: 12, documentIds: ['same-origin-frame'] }]);

    const fill = await vault.handleVaultAction('fill', {
      tabId: 12,
      origin: 'https://fixture.test',
      documentId: 'top-document',
      targetDocumentId: 'same-origin-frame',
      frameId: 7,
      nonce: (inspected as any).nonce,
      password: 'fixture-only-secret',
    });
    expect(fill).toEqual({ success: true, filled_fields: 1 });
    const fillInjection = injected.find((item) => item.func.name === 'fillInspectedPassword');
    expect(fillInjection.target).toEqual({ tabId: 12, documentIds: ['same-origin-frame'] });
    expect(fillInjection.args[2]).toBe('https://fixture.test');
  });

  it('ignores an unrelated cross-origin child while inspecting the main document', async () => {
    frames[1]!.url = 'https://other.test/frame';
    candidatesByDocument.set('top-document', 1);
    const result = await vault.handleVaultAction('inspect', { tabId: 12 }) as any;
    expect(result).toMatchObject({ success: true, suitable: true, frameId: 0, targetDocumentId: 'top-document' });
    expect(injected.filter((item) => item.func.name === 'inspectPasswordField').map((item) => item.target.documentIds[0])).toEqual(['top-document']);
  });

  it('does not inspect or select a password field inside a cross-origin frame', async () => {
    frames[1]!.url = 'https://other.test/frame';
    candidatesByDocument.set('same-origin-frame', 0);
    candidatesByDocument.set('cross-origin-frame', 1);
    frames[1]!.documentId = 'cross-origin-frame';
    const result = await vault.handleVaultAction('inspect', { tabId: 12 }) as any;
    expect(result).toMatchObject({ success: true, suitable: false, frameId: 0 });
    expect(injected.filter((item) => item.func.name === 'inspectPasswordField').map((item) => item.target.documentIds[0])).toEqual(['top-document']);
  });

  it('consumes an inspection when its target frame document changes', async () => {
    const inspected = await vault.handleVaultAction('inspect', { tabId: 12 }) as any;
    frames[1] = { frameId: 7, documentId: 'replacement-frame', url: 'https://fixture.test/frame' };
    const result = await vault.handleVaultAction('fill', {
      tabId: 12, origin: 'https://fixture.test', documentId: 'top-document',
      targetDocumentId: 'same-origin-frame', frameId: 7, nonce: inspected.nonce, password: 'fixture-only-secret',
    }) as any;
    expect(result).toMatchObject({ success: false, code: 'VAULT_DOCUMENT_CHANGED' });
    expect(injected.some((item) => item.func.name === 'fillInspectedPassword')).toBe(false);
    const replay = await vault.handleVaultAction('fill', {
      tabId: 12, origin: 'https://fixture.test', documentId: 'top-document',
      targetDocumentId: 'same-origin-frame', frameId: 7, nonce: inspected.nonce, password: 'fixture-only-secret',
    }) as any;
    expect(replay).toMatchObject({ success: false, code: 'VAULT_PERMISSION_DENIED' });
  });
});

describe('isolated password field classifier', () => {
  beforeEach(async () => {
    frames.splice(0, frames.length,
      { frameId: 0, documentId: 'top-document', url: 'https://fixture.test/login' },
      { frameId: 7, documentId: 'same-origin-frame', url: 'https://fixture.test/frame' });
    candidatesByDocument.clear();
    candidatesByDocument.set('same-origin-frame', 1);
    injected.length = 0;
    delete (globalThis as any).__bcVaultInspection;
    savedRuntimeState = { protectionSequence: 0, protectedDocuments: [], pendingRemovals: [] };
    delete localValues.bcVaultMayHaveSensitiveContext;
    rejectSessionWrites = false;
    await vault.restoreVaultRuntimeState();
  });

  it('finds one field inside an open shadow root', () => {
    const doc = installPage([]);
    const field = new FixtureInput(doc, { autocomplete: 'section-login current-password' });
    const shadow = new FixtureRoot([field]);
    const host = { shadowRoot: shadow };
    (doc as any).elements = [host];
    expect(vault.inspectPasswordField('nonce-shadow')).toMatchObject({ suitable: true, candidateCount: 1 });
    expect((globalThis as any).__bcVaultInspection.field).toBe(field);
  });

  it.each([
    ['tokenized autocomplete', { autocomplete: 'section-login new-password' }, []],
    ['new-password label', { autocomplete: 'off' }, [{ textContent: 'New password' }]],
    ['new-password name', { name: 'new_password' }, []],
    ['reset field name', { name: 'reset_password' }, []],
    ['register form context', { autocomplete: 'off' }, []],
  ])('rejects a single password field marked as %s', (_name, attributes, labels) => {
    const doc = installPage([]);
    const field = new FixtureInput(doc, attributes as Record<string, string>);
    field.labels = labels as Array<{ textContent: string }>;
    if (_name === 'register form context') field.form = { querySelectorAll: () => [{ innerText: 'Create account' }] };
    (doc as any).fields = [field];
    expect(vault.inspectPasswordField(`nonce-${_name}`)).toMatchObject({ suitable: false, candidateCount: 0 });
  });

  it('keeps a current-password login eligible when the form only has password-reset help text', () => {
    const doc = installPage([]);
    const field = new FixtureInput(doc, { autocomplete: 'section-login current-password' });
    field.form = {
      innerText: 'Sign in. Forgot password? Reset your password or change your password.',
      querySelectorAll: () => [{ innerText: 'Sign in' }],
    };
    (doc as any).fields = [field];
    expect(vault.inspectPasswordField('nonce-login-help')).toMatchObject({ suitable: true, candidateCount: 1 });
  });

  it('keeps an ordinary single current-password login field eligible', () => {
    const doc = installPage([]);
    const field = new FixtureInput(doc, { autocomplete: 'section-login current-password', name: 'password' });
    (doc as any).fields = [field];
    expect(vault.inspectPasswordField('nonce-current')).toMatchObject({ suitable: true, candidateCount: 1 });
  });

  it('executes serialized inspection and fill functions without extension module scope', () => {
    const doc = installPage([]);
    const field = new FixtureInput(doc, { autocomplete: 'section-login current-password' });
    (doc as any).fields = [field];
    const context = vm.createContext({
      document: doc,
      location: { origin: 'https://fixture.test' },
      HTMLInputElement: FixtureInput,
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
      Event: class { constructor(public type: string) {} },
    });
    const inspect = vm.runInContext(`(${vault.inspectPasswordField.toString()})`, context) as (nonce: string, deadline: number) => unknown;
    const fill = vm.runInContext(`(${vault.fillInspectedPassword.toString()})`, context) as (nonce: string, value: string, origin: string, deadline: number) => unknown;
    expect(inspect('serialized-nonce', Date.now() + 5_000)).toMatchObject({ suitable: true, candidateCount: 1 });
    expect(fill('serialized-nonce', 'fixture-only-secret', 'https://fixture.test', Date.now() + 5_000)).toMatchObject({
      success: true, retained: true, filled_fields: 1,
    });
    expect(field.value).toBe('fixture-only-secret');
  });

  it('refuses a delayed serialized fill after its page-side write deadline', () => {
    const doc = installPage([]);
    const field = new FixtureInput(doc, { autocomplete: 'current-password' });
    (doc as any).fields = [field];
    const context = vm.createContext({
      document: doc,
      location: { origin: 'https://fixture.test' },
      HTMLInputElement: FixtureInput,
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
      Event: class { constructor(public type: string) {} },
    });
    const inspect = vm.runInContext(`(${vault.inspectPasswordField.toString()})`, context) as (nonce: string, deadline: number) => unknown;
    const fill = vm.runInContext(`(${vault.fillInspectedPassword.toString()})`, context) as (nonce: string, value: string, origin: string, deadline: number) => unknown;
    inspect('late-nonce', Date.now() + 5_000);
    expect(fill('late-nonce', 'fixture-only-secret', 'https://fixture.test', Date.now() - 1)).toMatchObject({
      success: false, code: 'VAULT_PERMISSION_DENIED',
    });
    expect(field.value).toBe('');
  });

  it('keeps a never-used profile clean after session storage starts empty on browser restart', async () => {
    savedRuntimeState = undefined;
    const snapshot = await vault.restoreVaultRuntimeState();
    expect(snapshot).toBeUndefined();
    expect(await vault.getVaultProtectionSnapshot()).toMatchObject({ protectionUnknown: false, documents: [], unknownTabIds: [] });
  });

  it('fails closed after session state loss until a previously protected tab is closed', async () => {
    savedRuntimeState = undefined;
    localValues.bcVaultMayHaveSensitiveContext = { version: 1, tabIds: [12] };
    await vault.restoreVaultRuntimeState();
    expect(await vault.getVaultProtectionSnapshot()).toMatchObject({ protectionUnknown: true, unknownTabIds: [12] });
    expect(await vault.removeProtectedTab(12)).toMatchObject({ tabId: 12, documentIds: [], unknownContextRemoved: true });
    expect(await vault.getVaultProtectionSnapshot()).toMatchObject({ protectionUnknown: false, unknownTabIds: [] });
  });

  it('does not inject when protection state cannot be persisted before fill', async () => {
    const inspected = await vault.handleVaultAction('inspect', { tabId: 12 }) as any;
    rejectSessionWrites = true;
    const result = await vault.handleVaultAction('fill', {
      tabId: 12, origin: 'https://fixture.test', documentId: 'top-document',
      targetDocumentId: 'same-origin-frame', frameId: 7, nonce: inspected.nonce, password: 'fixture-only-secret',
    }) as any;
    expect(result).toMatchObject({ success: false, code: 'VAULT_RECOVERY_REQUIRED' });
    expect(injected.some((item) => item.func.name === 'fillInspectedPassword')).toBe(false);
  });
});
