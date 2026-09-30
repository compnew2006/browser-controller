/**
 * Tiny DOM for exercising the injected page runtime (extension/lib/page-dom.js)
 * in node: elements, text nodes, open shadow roots, a handful of selector
 * forms, visibility via a `hidden` flag / inline display, fixed-size layout.
 * Deliberately small — enough for resolver / find / click_text semantics.
 */
export class FakeText {
  nodeType = 3;
  parentNode: FakeNode | null = null;
  constructor(public nodeValue: string) {}
  get textContent() { return this.nodeValue; }
}

type FakeNode = FakeElement | FakeShadowRoot;

export class FakeShadowRoot {
  nodeType = 11;
  childNodes: Array<FakeElement | FakeText> = [];
  constructor(public host: FakeElement) {}
  get children() { return this.childNodes.filter((c): c is FakeElement => c instanceof FakeElement); }
  append(...nodes: Array<FakeElement | FakeText>) { for (const n of nodes) { n.parentNode = this; if (n instanceof FakeElement) n.parentElement = null; this.childNodes.push(n); } return this; }
  querySelectorAll(sel: string) { return this.children.flatMap((c) => c.selfAndDescendants()).filter((e) => e.matches(sel)); }
  querySelector(sel: string) { return this.querySelectorAll(sel)[0] ?? null; }
  getElementById(id: string) { return this.querySelectorAll(`#${id}`)[0] ?? null; }
  get activeElement() { return null; }
  elementFromPoint() { return null; }
}

export class FakeElement {
  nodeType = 1;
  tagName: string;
  attrs = new Map<string, string>();
  childNodes: Array<FakeElement | FakeText> = [];
  parentElement: FakeElement | null = null;
  parentNode: FakeNode | null = null;
  shadowRoot: FakeShadowRoot | null = null;
  hidden = false;
  value: string | undefined;
  type: string | undefined;
  disabled = false;
  isConnected = true;
  onclick = null;
  isContentEditable = false;
  events: string[] = [];
  ownerDocument: FakeDocument;

  constructor(doc: FakeDocument, tag: string, attrs: Record<string, string> = {}) {
    this.ownerDocument = doc;
    this.tagName = tag.toUpperCase();
    for (const [k, v] of Object.entries(attrs)) this.setAttribute(k, v);
  }

  get children() { return this.childNodes.filter((c): c is FakeElement => c instanceof FakeElement); }
  get childElementCount() { return this.children.length; }
  get id() { return this.attrs.get('id') ?? ''; }
  get className() { return this.attrs.get('class') ?? ''; }
  get textContent(): string { return this.childNodes.map((c) => c.textContent).join(''); }
  get innerText(): string { return this.textContent; }
  get labels() { return []; }
  get multiple() { return false; }

  append(...nodes: Array<FakeElement | FakeText | string>) {
    for (const raw of nodes) {
      const n = typeof raw === 'string' ? new FakeText(raw) : raw;
      n.parentNode = this;
      if (n instanceof FakeElement) n.parentElement = this;
      this.childNodes.push(n);
    }
    return this;
  }
  attachShadow() { this.shadowRoot = new FakeShadowRoot(this); return this.shadowRoot; }
  getAttribute(n: string) { if (n === 'type' && this.type) return this.type; return this.attrs.get(n) ?? null; }
  setAttribute(n: string, v: string) { this.attrs.set(n, v); if (n === 'type') this.type = v; if (n === 'value') this.value = v; }
  removeAttribute(n: string) { this.attrs.delete(n); }
  hasAttribute(n: string) { return this.attrs.has(n); }
  getRootNode(): unknown {
    let cur: FakeElement = this;
    while (cur.parentElement) cur = cur.parentElement;
    if (cur.parentNode instanceof FakeShadowRoot) return cur.parentNode;
    return this.ownerDocument;
  }
  closest() { return null; }
  get isHiddenInTree(): boolean {
    let cur: FakeElement | null = this;
    while (cur) {
      if (cur.hidden || cur.attrs.get('style')?.includes('display:none')) return true;
      const p: FakeNode | null = cur.parentNode;
      cur = cur.parentElement ?? (p instanceof FakeShadowRoot ? p.host : null);
    }
    return false;
  }
  getBoundingClientRect() {
    const w = this.isHiddenInTree ? 0 : 100;
    return { x: 10, y: 10, left: 10, top: 10, width: w, height: w ? 20 : 0, right: 10 + w, bottom: 30 };
  }
  checkVisibility() { return !this.isHiddenInTree; }
  scrollIntoView() {}
  focus() { this.ownerDocument.activeElement = this; }
  dispatchEvent(e: { type: string }) { this.events.push(e.type); return true; }
  selfAndDescendants(): FakeElement[] {
    return [this, ...this.children.flatMap((c) => c.selfAndDescendants())];
  }
  querySelectorAll(sel: string) { return this.children.flatMap((c) => c.selfAndDescendants()).filter((e) => e.matches(sel)); }
  querySelector(sel: string) { return this.querySelectorAll(sel)[0] ?? null; }
  /** Supports: *, tag, #id, .cls, tag.cls, [attr], [attr="v"], tag[attr="v"], comma lists. */
  matches(sel: string): boolean {
    return sel.split(',').some((part) => {
      const s = part.trim();
      if (s === '*') return true;
      const m = s.match(/^([a-zA-Z0-9-]*)((?:[#.][\w-]+)*)((?:\[[^\]]+\])*)$/);
      if (!m) throw new Error(`fake-dom: unsupported selector ${s}`);
      const [, tag, idcls, attrPart] = m;
      if (tag && tag.toUpperCase() !== this.tagName) return false;
      for (const t of idcls.match(/[#.][\w-]+/g) ?? []) {
        if (t[0] === '#' && this.id !== t.slice(1)) return false;
        if (t[0] === '.' && !this.className.split(/\s+/).includes(t.slice(1))) return false;
      }
      for (const a of attrPart.match(/\[[^\]]+\]/g) ?? []) {
        const am = a.match(/^\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]$/);
        if (!am) return false;
        const have = this.getAttribute(am[1]);
        if (have == null) return false;
        if (am[2] !== undefined && have !== am[2]) return false;
      }
      return true;
    });
  }
}

export class FakeDocument {
  nodeType = 9;
  title = 'Fixture';
  activeElement: FakeElement | null = null;
  body: FakeElement;
  defaultView: { getComputedStyle: (el: FakeElement) => Record<string, string>; frameElement: FakeElement | null } = { getComputedStyle: (el: FakeElement) => ({ display: el.attrs.get('style')?.includes('display:contents') ? 'contents' : el.isHiddenInTree ? 'none' : 'block', visibility: 'visible', opacity: '1' }), frameElement: null };
  constructor() { this.body = new FakeElement(this, 'BODY'); }
  el(tag: string, attrs: Record<string, string> = {}, ...kids: Array<FakeElement | string>) {
    return new FakeElement(this, tag, attrs).append(...kids);
  }
  querySelectorAll(sel: string) { return this.body.selfAndDescendants().filter((e) => e.matches(sel)); }
  querySelector(sel: string) { return this.querySelectorAll(sel)[0] ?? null; }
  getElementById(id: string) { return this.querySelector(`#${id}`); }
  elementFromPoint() { return null; }
  createTreeWalker() { throw new Error('fake-dom: tree walkers are not supported'); }
}

/** Give an <iframe> FakeElement its own same-origin document. */
export function installFakeFrame(frame: FakeElement): FakeDocument {
  const inner = new FakeDocument();
  inner.defaultView.frameElement = frame;
  (frame as unknown as { contentDocument: FakeDocument }).contentDocument = inner;
  return inner;
}

/** Install a fresh FakeDocument as the page globals the runtime reads. */
export function installFakePage(url = 'https://example.test/page') {
  const doc = new FakeDocument();
  const g = globalThis as Record<string, unknown>;
  g.document = doc;
  g.location = { href: url, origin: new URL(url).origin };
  g.window = g;
  g.getComputedStyle = doc.defaultView.getComputedStyle;
  g.MouseEvent = class { constructor(public type: string, public init: unknown) {} };
  g.Event = class { constructor(public type: string, public init: unknown) {} };
  g.KeyboardEvent = class { constructor(public type: string, public init: unknown) {} };
  g.HTMLInputElement = class {};
  g.HTMLTextAreaElement = class {};
  g.HTMLSelectElement = class {};
  g.__bcDom = undefined;
  g.__browserControllerLegacyRefRegistry = undefined;
  g.__browserControllerFallbackRuntime = undefined;
  return doc;
}
