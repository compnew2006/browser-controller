import { beforeEach, describe, expect, it } from 'vitest';
import { installFakePage, installFakeFrame, FakeElement, type FakeDocument } from './helpers/fake-dom.js';

// chrome mock: executeScript runs the page function in-process against the fake page.
(globalThis as any).chrome = {
  tabs: { get: async (id: number) => ({ id, url: 'https://example.test/page', windowId: 1 }), query: async () => [], onRemoved: { addListener: () => {} } },
  scripting: { executeScript: async (o: { func: (...a: any[]) => unknown; args?: unknown[] }) => [{ result: await o.func(...(o.args ?? [])) }] },
  storage: { session: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({}), set: async () => {} } },
  debugger: { attach: async () => { throw new Error('no debugger in tests'); }, detach: async () => {}, sendCommand: async () => ({}), onDetach: { addListener: () => {} } },
};

const { PAGE_DOM_INSTALL, PAGE_DOM_VERSION } = await import('../extension/lib/page-dom.js');
const { PAGE_ACT_V2 } = await import('../extension/lib/observation-action.js');
const { safeExec } = await import('../extension/lib/page-exec.js');
const { handleFillForm } = await import('../extension/handlers/interaction-advanced.js');
const { fallbackByTab } = await import('../extension/lib/state.js');

let doc: FakeDocument;

beforeEach(() => {
  doc = installFakePage();
  fallbackByTab.clear();
  PAGE_DOM_INSTALL(PAGE_DOM_VERSION);
});

describe('async page functions: a throw is a failure, not a bare null', () => {
  it('PAGE_ACT_V2 that throws inside its async body reports SCRIPT_ERROR through safeExec', async () => {
    (globalThis as any).__browserControllerV2Runtime = { helpers: {}, inferAllowedActions: () => [] };
    (globalThis as any).__browserControllerObservationV2 = {
      document: doc,
      documentId: 'd1',
      lastUrl: 'https://example.test/page',
      routeEpoch: 0,
      revision: 0,
      snapshots: { get: () => { throw new Error('snapshot store offline'); } },
    };
    const config = {
      documentId: 'd1',
      routeEpoch: 0,
      snapshotId: 's1',
      sessionId: 'sess',
      ttlMs: 60_000,
      cursor: false,
      params: { action: 'click', ref: 'e1' },
    };
    await expect(safeExec(1, PAGE_ACT_V2 as any, [config])).rejects.toThrow('SCRIPT_ERROR: snapshot store offline');
  });

  it('PAGE_ACT_V2 returns its own failures (no throw) when the runtime is missing', async () => {
    delete (globalThis as any).__browserControllerV2Runtime;
    const res = await PAGE_ACT_V2({ params: { action: 'click' } } as any);
    expect(res).toMatchObject({ success: false, error: 'RUNTIME_NOT_INSTALLED' });
  });
});

describe('browser_fill_form: fields inside a same-origin iframe use their own realm', () => {
  // The top window's value setter refuses an element from another document, as a real
  // cross-realm brand check does. A correct fill never calls it.
  function topSetterRefuses(): () => void {
    const proto = (globalThis as any).HTMLInputElement.prototype;
    Object.defineProperty(proto, 'value', {
      configurable: true,
      get() { return ''; },
      set() { throw new TypeError('Illegal invocation'); },
    });
    return () => { delete proto.value; };
  }

  /** An element whose own realm's value setter records what it was given. */
  function frameInput(inner: FakeDocument, id: string, written: string[]): FakeElement {
    const realmProto = Object.create(FakeElement.prototype);
    Object.defineProperty(realmProto, 'value', {
      configurable: true,
      get() { return this.__value ?? ''; },
      set(v: string) { written.push(String(v)); this.__value = v; },
    });
    const field = inner.el('input', { id });
    delete (field as any).value;
    Object.setPrototypeOf(field, realmProto);
    inner.body.append(field);
    return field;
  }

  it('the value is written through the iframe element\'s own setter, not the top window\'s', async () => {
    const frame = doc.el('iframe', { src: '/embed' });
    doc.body.append(frame);
    const inner = installFakeFrame(frame);
    const written: string[] = [];
    frameInput(inner, 'inner-name', written);
    const restore = topSetterRefuses();
    try {
      const res = await handleFillForm({ tabId: 1, fields: [{ selector: '#inner-name', value: 'Dana' }] });
      expect(res).toMatchObject({ success: true, fields: [{ success: true, value: 'Dana' }] });
      expect(written).toContain('Dana');
    } finally {
      restore();
    }
  });

  it('a contenteditable field in an iframe is edited with the iframe document\'s execCommand', async () => {
    const frame = doc.el('iframe', { src: '/editor' });
    doc.body.append(frame);
    const inner = installFakeFrame(frame);
    const editor = inner.el('div', { id: 'editor' });
    editor.isContentEditable = true;
    inner.body.append(editor);
    const calls: Array<{ doc: string; cmd: string; value: unknown }> = [];
    (inner as any).execCommand = (cmd: string, _ui: boolean, value: unknown) => { calls.push({ doc: 'frame', cmd, value }); return true; };
    (doc as any).execCommand = (cmd: string, _ui: boolean, value: unknown) => { calls.push({ doc: 'top', cmd, value }); return true; };

    const res = await handleFillForm({ tabId: 1, fields: [{ selector: '#editor', value: 'Hello', clear: false }] });
    expect(res).toMatchObject({ success: true });
    expect(calls).toEqual([{ doc: 'frame', cmd: 'insertText', value: 'Hello' }]);
  });
});
