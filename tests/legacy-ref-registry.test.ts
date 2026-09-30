import { beforeEach, describe, expect, it } from 'vitest';

class FakeElement {
  nodeType = 1;
  attrs = new Map<string, string>();
  children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  shadowRoot: { children: FakeElement[] } | null = null;
  contentDocument: FakeDocument | null = null;
  value = '';
  checked = undefined;
  disabled = false;
  href = '';
  onclick = null;

  constructor(public tagName: string, public innerText = '') {}

  append(child: FakeElement) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  getAttribute(name: string) {
    return this.attrs.get(name) ?? null;
  }

  setAttribute(name: string, value: string) {
    this.attrs.set(name, value);
  }

  removeAttribute(name: string) {
    this.attrs.delete(name);
  }

  getBoundingClientRect() {
    return { x: 0, y: 0, left: 0, top: 0, width: 100, height: 24 };
  }

  querySelector(selector: string): FakeElement | null {
    return walk(this).find((el) => matches(el, selector)) ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    return walk(this).filter((el) => matches(el, selector));
  }
}

class FakeDocument {
  title = 'Fixture';
  body = new FakeElement('BODY');

  querySelector(selector: string) {
    return this.body.querySelector(selector);
  }

  querySelectorAll(selector: string) {
    return this.body.querySelectorAll(selector);
  }

  createTreeWalker(root: FakeElement) {
    const nodes = walk(root).filter((node) => node !== root);
    let i = 0;
    return {
      nextNode: () => nodes[i++] ?? null,
    };
  }
}

function walk(root: FakeElement): FakeElement[] {
  const out = [root];
  for (const child of root.children) out.push(...walk(child));
  if (root.shadowRoot) {
    for (const child of root.shadowRoot.children) out.push(...walk(child));
  }
  if (root.contentDocument) out.push(...walk(root.contentDocument.body));
  return out;
}

function matches(el: FakeElement, selector: string): boolean {
  if (selector === '*') return true;
  if (selector === 'iframe' || selector === 'iframe,frame') return el.tagName === 'IFRAME' || el.tagName === 'FRAME';
  if (selector.startsWith('[data-mcp-ref="')) {
    const ref = selector.slice('[data-mcp-ref="'.length, -2);
    return el.getAttribute('data-mcp-ref') === ref;
  }
  return el.tagName.toLowerCase() === selector.toLowerCase();
}

const tabStore = new Map<number, { id: number; url: string }>();
let fakeDocument = new FakeDocument();

(globalThis as any).chrome = {
  tabs: {
    get: async (id: number) => {
      const tab = tabStore.get(id);
      if (!tab) throw new Error(`No tab ${id}`);
      return tab;
    },
    query: async () => [],
  },
  scripting: {
    executeScript: async (opts: { func: (...args: any[]) => unknown; args?: unknown[] }) => {
      return [{ result: await opts.func(...(opts.args ?? [])) }];
    },
  },
  storage: { session: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({}), set: async () => {} } },
  action: { setBadgeBackgroundColor: () => {}, setBadgeText: () => {} },
  runtime: { sendMessage: async () => {}, onMessage: { addListener: () => {} } },
  alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
  webRequest: { onCompleted: { addListener: () => {} } },
};

(globalThis as any).document = fakeDocument;
(globalThis as any).location = { href: 'https://example.test/page' };
(globalThis as any).NodeFilter = { SHOW_ELEMENT: 1 };
(globalThis as any).getComputedStyle = () => ({ display: 'block', visibility: 'visible', opacity: '1' });

const { handleFind, handleSnapshot } = await import('../extension/handlers/inspection.js');

describe('legacy snapshot refs', () => {
  beforeEach(() => {
    tabStore.clear();
    tabStore.set(9, { id: 9, url: 'https://example.test/page' });
    fakeDocument = new FakeDocument();
    (globalThis as any).document = fakeDocument;
    (globalThis as any).__browserControllerLegacyRefRuntime = undefined;
    (globalThis as any).__browserControllerLegacyRefRegistry = undefined;
  });

  it('snapshot registers refs without stamping data-mcp-ref attributes into the page DOM', async () => {
    const button = fakeDocument.body.append(new FakeElement('BUTTON', 'Save'));

    const result = await handleSnapshot({ tabId: 9, compact: true });

    expect(result.success).toBe(true);
    expect(result.tree.ref).toMatch(/^s[a-z0-9]+-\d+$/);
    expect(button.getAttribute('data-mcp-ref')).toBeNull();
  });

  it('find registers refs without stamping data-mcp-ref attributes into the page DOM', async () => {
    const button = fakeDocument.body.append(new FakeElement('BUTTON', 'Save'));

    const result = await handleFind({ tabId: 9, query: 'save', limit: 1 });

    expect(result.success).toBe(true);
    expect(result.matches[0].ref).toMatch(/^f[a-z0-9]+-\d+$/);
    expect(button.getAttribute('data-mcp-ref')).toBeNull();
  });
});
