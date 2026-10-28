import { beforeEach, describe, expect, it } from 'vitest';
import vm from 'node:vm';

type Frame = { frameId: number; documentId: string; url: string };
const frames: Frame[] = [];
const injected: Array<Record<string, any>> = [];
const candidatesByDocument = new Map<string, number>();
const identifiersByDocument = new Map<string, number>();
const identifierFieldDocuments = new Set<string>();
let showCardResult = true;
let savedCards: unknown;
let savedRuntimeState: any = { protectionSequence: 0, protectedDocuments: [], pendingRemovals: [] };
const localValues: Record<string, unknown> = {};
let rejectSessionWrites = false;

const executeScriptStub = async (request: Record<string, any>) => {
  injected.push(request);
  const documentId = request.target.documentIds[0];
  const frame = frames.find((item) => item.documentId === documentId);
  if (!frame) return [];
  if (request.files) return [{ frameId: frame.frameId, documentId, result: undefined }];
  if (request.func.name === 'inspectPasswordField') {
    const candidateCount = candidatesByDocument.get(documentId) ?? 0;
    return [{ frameId: frame.frameId, documentId, result: {
      candidateCount, suitable: candidateCount === 1, documentOrigin: new URL(frame.url).origin,
      ...(request.args[2] === true ? {
        identifierCount: identifiersByDocument.get(documentId) ?? 0,
        ...(identifierFieldDocuments.has(documentId) ? { identifierField: true } : {}),
      } : {}),
    } }];
  }
  if (request.func.name === 'fillInspectedPassword') {
    const identifier = request.args[4];
    if (typeof identifier !== 'string') return [{ frameId: frame.frameId, documentId, result: { success: true, retained: true, filled_fields: 1 } }];
    return [{ frameId: frame.frameId, documentId, result: {
      success: true, retained: true, filled_fields: request.args[1] === null ? 1 : 2, identifier_filled: true,
    } }];
  }
  if (request.func.name === 'showApprovalCard') return [{ frameId: frame.frameId, documentId, result: showCardResult }];
  return [{ frameId: frame.frameId, documentId, result: true }];
};

(globalThis as any).chrome = {
  runtime: { id: 'fixture-extension', getURL: (path: string) => `chrome-extension://fixture-extension/${path}` },
  tabs: {
    get: async () => ({ id: 12, url: 'https://fixture.test/login' }),
    query: async () => [{ id: 12, url: 'https://fixture.test/login' }],
    update: async () => ({}),
  },
  webNavigation: {
    getFrame: async () => frames.find((frame) => frame.frameId === 0),
    getAllFrames: async () => frames.map((frame) => ({ ...frame })),
  },
  scripting: { executeScript: executeScriptStub },
  storage: {
    session: {
      get: async (key?: string) => key === 'bcVaultApprovalCards'
        ? (savedCards === undefined ? {} : { bcVaultApprovalCards: savedCards })
        : savedRuntimeState === undefined ? {} : ({ bcVaultRuntimeState: savedRuntimeState }),
      set: async (value: Record<string, any>) => {
        if (rejectSessionWrites) throw new Error('fixture storage failure');
        if ('bcVaultRuntimeState' in value) savedRuntimeState = value.bcVaultRuntimeState;
        if ('bcVaultApprovalCards' in value) savedCards = value.bcVaultApprovalCards;
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
const cards = await import('../extension/lib/vault-card.js');

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
  /** DOCUMENT_POSITION_PRECEDING (2) when `other` comes first in the document's input order. */
  compareDocumentPosition(other: FixtureInput) {
    const order = (this.ownerDocument as any).inputs as FixtureInput[];
    return order.indexOf(other) < order.indexOf(this) ? 2 : 4;
  }
}

function textInput(doc: FixtureDocument, attributes: Record<string, string> = {}, type = 'text') {
  const field = new FixtureInput(doc, attributes);
  field.type = type;
  return field;
}

class FixtureRoot {
  /** Every input in document order; the password fields alone are `fields`. */
  inputs: FixtureInput[] = [];
  constructor(public fields: FixtureInput[] = [], public elements: any[] = [], public controls: any[] = []) {}
  querySelectorAll(selector: string) {
    if (selector === 'input[type="password"]') return this.fields;
    if (selector === 'input') return this.inputs;
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
    delete (globalThis as any).__bcVaultInspections;
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
    expect((globalThis as any).__bcVaultInspections.get('nonce-shadow').field).toBe(field);
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

describe('username field with the password (specs/006 FR-012)', () => {
  beforeEach(() => {
    delete (globalThis as any).__bcVaultInspections;
  });

  function loginPage(...before: Array<(doc: FixtureDocument) => FixtureInput>) {
    const doc = installPage([]);
    const inputs = before.map((make) => make(doc));
    const password = new FixtureInput(doc, { autocomplete: 'current-password' });
    (doc as any).fields = [password];
    doc.inputs = [...inputs, password];
    return { doc, inputs, password };
  }

  it('keeps the username field before the password and writes it first', () => {
    const { inputs: [username], password } = loginPage((doc) => textInput(doc, { autocomplete: 'username' }));
    expect(vault.inspectPasswordField('nonce-pair', Date.now() + 5_000, true)).toMatchObject({ suitable: true, candidateCount: 1, identifierField: true });
    const written: string[] = [];
    username!.dispatchEvent = () => { written.push('username'); return true; };
    password.dispatchEvent = () => { written.push('password'); return true; };
    expect(vault.fillInspectedPassword('nonce-pair', 'fixture-only-secret', 'https://fixture.test', Date.now() + 5_000, 'owner@fixture.test'))
      .toEqual({ success: true, retained: true, filled_fields: 2, identifier_filled: true });
    expect(username!.value).toBe('owner@fixture.test');
    expect(password.value).toBe('fixture-only-secret');
    expect(written.indexOf('username')).toBeLessThan(written.indexOf('password'));
  });

  it('picks the identifier-like field over a search box, and fills the password alone without one', () => {
    const { inputs: [email, search] } = loginPage(
      (doc) => textInput(doc, { name: 'email' }, 'email'),
      (doc) => textInput(doc, { name: 'search', placeholder: 'Search' }),
    );
    expect(vault.inspectPasswordField('nonce-pick', Date.now() + 5_000, true)).toMatchObject({ identifierField: true });
    vault.fillInspectedPassword('nonce-pick', 'fixture-only-secret', 'https://fixture.test', Date.now() + 5_000, 'owner@fixture.test');
    expect(email!.value).toBe('owner@fixture.test');
    expect(search!.value).toBe('');

    const lone = loginPage((doc) => textInput(doc, { name: 'coupon' }), (doc) => textInput(doc, { name: 'search' }));
    expect(vault.inspectPasswordField('nonce-none', Date.now() + 5_000, true)).toMatchObject({ suitable: true, identifierField: false });
    expect(vault.fillInspectedPassword('nonce-none', 'fixture-only-secret', 'https://fixture.test', Date.now() + 5_000, 'owner@fixture.test'))
      .toEqual({ success: true, retained: true, filled_fields: 1, identifier_filled: false });
    expect(lone.inputs.map((input) => input.value)).toEqual(['', '']);
  });

  it('fills the password alone when several fields look like the username (US4 scenario 3)', () => {
    const { inputs, password } = loginPage(
      (doc) => textInput(doc, { name: 'email' }, 'email'),
      (doc) => textInput(doc, { autocomplete: 'username' }),
    );
    expect(vault.inspectPasswordField('nonce-two', Date.now() + 5_000, true)).toMatchObject({ suitable: true, identifierField: false });
    expect(vault.fillInspectedPassword('nonce-two', 'fixture-only-secret', 'https://fixture.test', Date.now() + 5_000, 'owner@fixture.test'))
      .toEqual({ success: true, retained: true, filled_fields: 1, identifier_filled: false });
    expect(inputs.map((input) => input.value)).toEqual(['', '']);
    expect(password.value).toBe('fixture-only-secret');
  });

  it('takes the only text field of a form, but never a form-less box or a field that names something else', () => {
    const inForm = (attributes: Record<string, string>) => {
      const page = loginPage((doc) => textInput(doc, attributes));
      const form = { querySelectorAll: (selector: string) => (selector === 'input' ? page.doc.inputs : []) };
      for (const input of page.doc.inputs) input.form = form;
      return page;
    };
    inForm({ name: 'handle' });
    expect(vault.inspectPasswordField('nonce-form', Date.now() + 5_000, true)).toMatchObject({ identifierField: true });
    inForm({ name: 'zip' });
    expect(vault.inspectPasswordField('nonce-zip', Date.now() + 5_000, true)).toMatchObject({ identifierField: false });
    // No <form>: a header box before the password is not taken for the username.
    loginPage((doc) => textInput(doc, { name: 'q' }));
    expect(vault.inspectPasswordField('nonce-formless', Date.now() + 5_000, true)).toMatchObject({ identifierField: false });
  });

  it('keeps one inspection per call, so a second call on the tab does not break the first one’s fill', () => {
    const { password } = loginPage();
    vault.inspectPasswordField('nonce-first', Date.now() + 5_000, true);
    vault.inspectPasswordField('nonce-second', Date.now() + 5_000, true);
    expect(vault.fillInspectedPassword('nonce-first', 'fixture-only-secret', 'https://fixture.test', Date.now() + 5_000))
      .toMatchObject({ success: true, filled_fields: 1 });
    expect(password.value).toBe('fixture-only-secret');
    // Each inspection is used once.
    expect(vault.fillInspectedPassword('nonce-first', 'fixture-only-secret', 'https://fixture.test', Date.now() + 5_000))
      .toEqual({ success: false, code: 'VAULT_DOCUMENT_CHANGED' });
  });

  it('writes no password when the page swapped its password field on the username input', () => {
    const { doc, inputs: [username], password } = loginPage((doc) => textInput(doc, { autocomplete: 'username' }));
    vault.inspectPasswordField('nonce-swap', Date.now() + 5_000, true);
    const replacement = new FixtureInput(doc, { autocomplete: 'current-password' });
    username!.dispatchEvent = () => { (doc as any).fields = [replacement]; return true; };
    expect(vault.fillInspectedPassword('nonce-swap', 'fixture-only-secret', 'https://fixture.test', Date.now() + 5_000, 'owner@fixture.test'))
      .toEqual({ success: false, code: 'VAULT_DOCUMENT_CHANGED' });
    expect(password.value).toBe('');
    expect(replacement.value).toBe('');
  });

  it('does not keep a username field when the caller did not ask for one', () => {
    loginPage((doc) => textInput(doc, { autocomplete: 'username' }));
    expect(vault.inspectPasswordField('nonce-plain', Date.now() + 5_000)).toEqual({
      suitable: true, candidateCount: 1, documentOrigin: 'https://fixture.test',
    });
    expect((globalThis as any).__bcVaultInspections.get('nonce-plain').identifier).toBeUndefined();
  });

  it('fills a lone username field on a first sign-in step, and refuses once a password field appeared', () => {
    const doc = installPage([]);
    (globalThis as any).location.pathname = '/signin';
    const username = textInput(doc, { autocomplete: 'username' });
    doc.inputs = [username];
    expect(vault.inspectPasswordField('nonce-step', Date.now() + 5_000, true)).toEqual({
      suitable: false, candidateCount: 0, identifierCount: 1, documentOrigin: 'https://fixture.test',
    });
    expect(vault.fillInspectedPassword('nonce-step', null as unknown as string, 'https://fixture.test', Date.now() + 5_000, 'owner@fixture.test'))
      .toEqual({ success: true, retained: true, filled_fields: 1, identifier_filled: true });
    expect(username.value).toBe('owner@fixture.test');

    username.value = '';
    vault.inspectPasswordField('nonce-moved', Date.now() + 5_000, true);
    (doc as any).fields = [new FixtureInput(doc, { autocomplete: 'current-password' })];
    expect(vault.fillInspectedPassword('nonce-moved', null as unknown as string, 'https://fixture.test', Date.now() + 5_000, 'owner@fixture.test'))
      .toEqual({ success: false, code: 'VAULT_DOCUMENT_CHANGED' });
    expect(username.value).toBe('');
  });

  it('keeps no lone field without a sign-in signal', () => {
    const doc = installPage([]);
    (globalThis as any).location.pathname = '/newsletter';
    doc.inputs = [textInput(doc, { name: 'email' }, 'email')];
    expect(vault.inspectPasswordField('nonce-newsletter', Date.now() + 5_000, true)).toMatchObject({ suitable: false, identifierCount: 0 });
    expect((globalThis as any).__bcVaultInspections?.get('nonce-newsletter')).toBeUndefined();
  });
});

describe('vault actions with a username', () => {
  beforeEach(async () => {
    frames.splice(0, frames.length, { frameId: 0, documentId: 'top-document', url: 'https://fixture.test/login' });
    candidatesByDocument.clear();
    identifiersByDocument.clear();
    identifierFieldDocuments.clear();
    injected.length = 0;
    savedRuntimeState = { protectionSequence: 0, protectedDocuments: [], pendingRemovals: [] };
    rejectSessionWrites = false;
    await vault.restoreVaultRuntimeState();
  });

  const fillParams = (inspected: any, extra: Record<string, unknown>) => ({
    tabId: 12, origin: 'https://fixture.test', documentId: 'top-document',
    targetDocumentId: inspected.targetDocumentId, frameId: inspected.frameId, nonce: inspected.nonce, ...extra,
  });

  it('fills the username with the password where the inspection kept that field', async () => {
    candidatesByDocument.set('top-document', 1);
    identifierFieldDocuments.add('top-document');
    const inspected = await vault.handleVaultAction('inspect', { tabId: 12, withIdentifier: true }) as any;
    expect(inspected).toMatchObject({ success: true, suitable: true, identifierField: true });
    expect(inspected.mode).toBeUndefined();
    const fill = await vault.handleVaultAction('fill', fillParams(inspected, { password: 'fixture-only-secret', identifier: 'owner@fixture.test' }));
    expect(fill).toEqual({ success: true, filled_fields: 2, identifier_filled: true });
  });

  it('refuses a username the inspection did not keep a field for', async () => {
    candidatesByDocument.set('top-document', 1);
    const inspected = await vault.handleVaultAction('inspect', { tabId: 12, withIdentifier: true }) as any;
    expect(inspected.identifierField).toBeUndefined();
    const fill = await vault.handleVaultAction('fill', fillParams(inspected, { password: 'fixture-only-secret', identifier: 'owner@fixture.test' }));
    expect(fill).toMatchObject({ success: false, code: 'INVALID_ARGUMENT' });
  });

  it('fills only the username on a first sign-in step, and never protects the document for it', async () => {
    identifiersByDocument.set('top-document', 1);
    const inspected = await vault.handleVaultAction('inspect', { tabId: 12, withIdentifier: true }) as any;
    expect(inspected).toMatchObject({ success: true, suitable: true, mode: 'identifier' });
    expect(await vault.handleVaultAction('fill', fillParams(inspected, { password: 'fixture-only-secret', identifier: 'owner@fixture.test' })))
      .toMatchObject({ success: false, code: 'INVALID_ARGUMENT' });

    const again = await vault.handleVaultAction('inspect', { tabId: 12, withIdentifier: true }) as any;
    const fill = await vault.handleVaultAction('fill', fillParams(again, { identifier: 'owner@fixture.test' }));
    expect(fill).toEqual({ success: true, filled_fields: 1, identifier_filled: true });
    const fillInjection = injected.find((item) => item.func?.name === 'fillInspectedPassword');
    expect(fillInjection.args[1]).toBeNull();
    expect((await vault.getVaultProtectionSnapshot()).documents).toEqual([]);
  });

  it('refuses a username-only page unless the caller asked for the username', async () => {
    identifiersByDocument.set('top-document', 1);
    const inspected = await vault.handleVaultAction('inspect', { tabId: 12 }) as any;
    expect(inspected).toMatchObject({ success: true, suitable: false, reasonCode: 'VAULT_TARGET_UNSAFE' });
    expect(await vault.handleVaultAction('inspect', { tabId: 12, withIdentifier: false }))
      .toMatchObject({ success: false, code: 'INVALID_ARGUMENT' });
  });
});

describe('vault approval card actions (specs/006 D4–D6)', () => {
  const promptParams = (extra: Record<string, unknown> = {}) => ({
    tabId: 12, requestId: 'req_0a1b', documentId: 'top-document', origin: 'https://fixture.test', purpose: 'fill',
    browserLabel: 'Work', agentName: 'Fixture agent', unlock: false, account: 'Personal', expiresAt: Date.now() + 60_000, ...extra,
  });
  const sender = (extra: Record<string, unknown> = {}) => ({
    id: 'fixture-extension', tab: { id: 12 }, frameId: 0, documentId: 'top-document', origin: 'https://fixture.test', ...extra,
  });

  beforeEach(async () => {
    frames.splice(0, frames.length, { frameId: 0, documentId: 'top-document', url: 'https://fixture.test/login' });
    injected.length = 0;
    showCardResult = true;
    savedCards = undefined;
    cards.dropAllCards();
    await vault.restoreVaultRuntimeState();
  });

  it.each([
    ['a malformed request id', { requestId: 'request-1' }, 'INVALID_ARGUMENT'],
    ['an unknown key', { extra: true }, 'INVALID_ARGUMENT'],
    ['an overlong agent name', { agentName: 'a'.repeat(121) }, 'INVALID_ARGUMENT'],
    ['an expired request', { expiresAt: Date.now() - 1 }, 'VAULT_PERMISSION_DENIED'],
    ['another document', { documentId: 'old-document' }, 'VAULT_DOCUMENT_CHANGED'],
    ['another origin', { origin: 'https://other.test' }, 'VAULT_ORIGIN_MISMATCH'],
  ])('refuses %s and draws nothing', async (_name, extra, code) => {
    expect(await vault.handleVaultAction('prompt', promptParams(extra))).toMatchObject({ success: false, code });
    expect(injected).toEqual([]);
    expect(cards.cardOnTab(12)).toBeNull();
  });

  it('records the card before drawing it on the requesting document, and keeps it across a worker restart', async () => {
    expect(await vault.handleVaultAction('prompt', promptParams())).toEqual({ success: true, shown: true });
    expect(injected.map((item) => item.files ?? item.func.name)).toEqual([['vault/vault-card.js'], 'showApprovalCard']);
    expect(injected.every((item) => item.world === 'ISOLATED' && item.target.documentIds[0] === 'top-document')).toBe(true);
    const card = cards.cardOnTab(12)!;
    expect(card).toMatchObject({ requestId: 'req_0a1b', documentId: 'top-document', origin: 'https://fixture.test' });
    expect(injected[1]!.args[0]).toMatchObject({ requestId: 'req_0a1b', token: card.token, agentName: 'Fixture agent', lang: 'en' });
    expect(savedCards).toEqual([expect.objectContaining({ tabId: 12, requestId: 'req_0a1b', token: card.token })]);
    expect(cards.cardInputGate(12, 'Input.dispatchMouseEvent', { type: 'mousePressed' })?.message).toMatch(/^VAULT_APPROVAL_PENDING:/);
    expect(cards.cardInputGate(13, 'Input.dispatchMouseEvent', { type: 'mousePressed' })).toBeNull();
  });

  it('forgets a card the page did not show', async () => {
    showCardResult = false;
    expect(await vault.handleVaultAction('prompt', promptParams())).toMatchObject({ success: false, code: 'VAULT_TARGET_UNSAFE' });
    expect(cards.cardOnTab(12)).toBeNull();
  });

  it('takes a decision only from the card’s own content script, and keeps the card until the daemon has it', async () => {
    await vault.handleVaultAction('prompt', promptParams());
    const { token } = cards.cardOnTab(12)!;
    const message = (extra: Record<string, unknown> = {}) => ({ requestId: 'req_0a1b', token, decision: 'allow', always: false, ...extra });
    expect(cards.takeCardDecision(message(), sender({ id: 'other-extension' }))).toBeNull();
    expect(cards.takeCardDecision(message(), sender({ tab: { id: 13 } }))).toBeNull();
    expect(cards.takeCardDecision(message(), sender({ frameId: 7 }))).toBeNull();
    expect(cards.takeCardDecision(message(), sender({ documentId: 'old-document' }))).toBeNull();
    expect(cards.takeCardDecision(message(), sender({ origin: 'https://other.test' }))).toBeNull();
    expect(cards.takeCardDecision(message({ token: 'guessed' }), sender())).toBeNull();
    expect(cards.takeCardDecision(message({ requestId: 'req_ffff' }), sender())).toBeNull();
    expect(cards.takeCardDecision(message({ decision: 'deny', always: true }), sender())).toBeNull();
    expect(cards.takeCardDecision(message({ decision: 'approve' }), sender())).toBeNull();
    expect(cards.takeCardDecision(message({ always: true }), sender())).toEqual({ tabId: 12, requestId: 'req_0a1b', decision: 'allow', always: true });
    expect(cards.cardOnTab(12)).not.toBeNull();
    expect(cards.dropCard(12, 'req_ffff')).toBeNull();
    expect(cards.dropCard(12, 'req_0a1b')).toMatchObject({ requestId: 'req_0a1b' });
    expect(cards.takeCardDecision(message(), sender())).toBeNull();
  });

  it('takes the card down for its own request only', async () => {
    await vault.handleVaultAction('prompt', promptParams());
    injected.length = 0;
    expect(await vault.handleVaultAction('promptClose', { tabId: 12, requestId: 'req_0a1b', extra: 1 })).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(await vault.handleVaultAction('promptClose', { tabId: 12, requestId: 'req_ffff' })).toEqual({ success: true, closed: false });
    expect(cards.cardOnTab(12)).not.toBeNull();
    expect(await vault.handleVaultAction('promptClose', { tabId: 12, requestId: 'req_0a1b' })).toEqual({ success: true, closed: true });
    expect(injected.map((item) => [item.func.name, item.args[0], item.target.documentIds[0]])).toEqual([['hideApprovalCard', 'req_0a1b', 'top-document']]);
    expect(cards.cardOnTab(12)).toBeNull();
  });

  it('ends a card with its document, keeps it for the same document, and ends every card with the connection', async () => {
    await vault.handleVaultAction('prompt', promptParams());
    expect(await vault.closeApprovalCard(12, { keepDocumentId: 'top-document', removeFromPage: false })).toBeNull();
    expect(cards.cardOnTab(12)).not.toBeNull();
    injected.length = 0;
    expect(await vault.closeApprovalCard(12, { keepDocumentId: 'next-document', removeFromPage: false })).toBe('req_0a1b');
    expect(injected).toEqual([]);
    expect(cards.cardOnTab(12)).toBeNull();

    await vault.handleVaultAction('prompt', promptParams());
    injected.length = 0;
    await vault.closeAllApprovalCards();
    expect(cards.cardOnTab(12)).toBeNull();
    expect(injected.map((item) => item.func.name)).toEqual(['hideApprovalCard']);
    expect(savedCards).toEqual([]);
  });
});
