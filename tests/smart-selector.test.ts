import { describe, it, expect } from 'vitest';
import { PAGE_FALLBACK_INSTALL } from '../extension/utils/smart-selector.js';

/**
 * Smart-selector descriptors (browser_snapshot refs). The descriptor is made by the
 * page runtime installed from PAGE_FALLBACK_INSTALL's source, so these tests run that
 * installed generateFallback itself against tiny element-shaped fakes. The document
 * walk that the nth count reads is faked as a list of nodes.
 */

interface FakeEl {
  tagName: string;
  id?: string;
  attrs?: Record<string, string>;
  parent?: FakeEl;
}

function fakeEl(opts: FakeEl): any {
  const attrs = opts.attrs ?? {};
  return {
    tagName: opts.tagName,
    id: opts.id ?? '',
    innerText: '',
    parentElement: opts.parent ? fakeEl(opts.parent) : null,
    getAttribute: (name: string) => (Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null),
    getBoundingClientRect: () => ({ width: 10, height: 10 }),
  };
}

/** A document whose tree walk yields `nodes` in order, every node visible and laid out. */
function withPage<T>(nodes: unknown[], run: () => T): T {
  const g = globalThis as any;
  const saved = { document: g.document, NodeFilter: g.NodeFilter, getComputedStyle: g.getComputedStyle };
  g.document = {
    body: {},
    createTreeWalker: () => {
      let i = 0;
      return { nextNode: () => (i < nodes.length ? nodes[i++] : null) };
    },
  };
  g.NodeFilter = { SHOW_ELEMENT: 1 };
  g.getComputedStyle = () => ({ display: 'block', visibility: 'visible', opacity: '1' });
  try {
    return run();
  } finally {
    g.document = saved.document;
    g.NodeFilter = saved.NodeFilter;
    g.getComputedStyle = saved.getComputedStyle;
  }
}

/** The installed page runtime's descriptor maker (the install is idempotent). */
function generateFallback(el: unknown, pass: object = {}): any {
  PAGE_FALLBACK_INSTALL();
  return ((globalThis as any).__browserControllerFallbackRuntime.generateFallback as (e: unknown, p: object) => any)(el, pass);
}

describe('generateFallback: the robust selector a ref is re-found by', () => {
  it('a stable test attribute on the element is the selector', () => {
    expect(generateFallback(fakeEl({ tagName: 'BUTTON', attrs: { 'data-testid': 'cta' } })).robustSelector).toBe('button[data-testid=cta]');
  });

  it('a stable id is the selector', () => {
    expect(generateFallback(fakeEl({ tagName: 'INPUT', id: 'email-field' })).robustSelector).toBe('#email-field');
  });

  it('a React-generated id is skipped, and the path climbs to a stable ancestor id', () => {
    const el = fakeEl({ tagName: 'BUTTON', id: ':r5:', attrs: { class: 'btn' }, parent: { tagName: 'NAV', id: 'main-nav' } });
    expect(generateFallback(el).robustSelector).toBe('#main-nav > button.btn');
  });

  it('a hashed id is not a selector: the stable class alone stands', () => {
    expect(generateFallback(fakeEl({ tagName: 'BUTTON', id: 'button-1a2b3c4d', attrs: { class: 'x' } })).robustSelector).toBe('button.x');
  });

  it('a semantic landmark anchors the path when no id is stable', () => {
    const el = fakeEl({ tagName: 'A', attrs: { class: 'link' }, parent: { tagName: 'HEADER' } });
    expect(generateFallback(el).robustSelector).toBe('header > a.link');
  });

  it('generated classes are dropped and stable ones kept, anchored by a landmark role', () => {
    const el = fakeEl({
      tagName: 'BUTTON',
      attrs: { class: 'css-1a2b3c btn primary' },
      parent: { tagName: 'DIV', attrs: { role: 'main' } },
    });
    expect(generateFallback(el).robustSelector).toBe('div[role=main] > button.btn.primary');
  });

  it('an element with nothing stable around it has no robust selector', () => {
    const el = fakeEl({ tagName: 'DIV', parent: { tagName: 'DIV', parent: { tagName: 'DIV' } } });
    expect(generateFallback(el).robustSelector).toBeNull();
  });
});

describe('generateFallback: nth counts the same-named visible elements before the ref', () => {
  it('a repeated name gets its own ordinal, and a longer name (Liked) is not counted as "Like"', () => {
    const like1 = fakeEl({ tagName: 'BUTTON', attrs: { 'aria-label': 'Like' } });
    const liked = fakeEl({ tagName: 'BUTTON', attrs: { 'aria-label': 'Liked' } });
    const like2 = fakeEl({ tagName: 'BUTTON', attrs: { 'aria-label': 'Like' } });
    withPage([like1, liked, like2], () => {
      const pass = {};
      expect(generateFallback(like1, pass)).toMatchObject({ text: 'Like', nth: 0, tag: 'BUTTON' });
      expect(generateFallback(like2, pass)).toMatchObject({ text: 'Like', nth: 1 });
    });
  });

  it('a name followed by a symbol still counts as the same name ("Login »")', () => {
    const chevron = fakeEl({ tagName: 'A', attrs: { 'aria-label': 'Login »' } });
    const login = fakeEl({ tagName: 'A', attrs: { 'aria-label': 'Login' } });
    withPage([chevron, login], () => {
      expect(generateFallback(login)).toMatchObject({ text: 'Login', nth: 1 });
    });
  });
});

describe('PAGE_FALLBACK_INSTALL injection contract', () => {
  it('contains no eval — MV3 extension CSP forbids it in every isolated world', () => {
    // Regression for the production bug: the runtime used to be rebuilt
    // page-side via eval('(' + src + ')'), which throws under MV3's extension
    // CSP (script-src 'self', no unsafe-eval) and silently killed the whole
    // fallback feature — snapshot capture AND stale-ref recovery.
    expect(PAGE_FALLBACK_INSTALL.toString()).not.toMatch(/\beval\s*\(/);
  });

  it('installs generateFallback with no dependency on extension-scope functions, and install is idempotent', () => {
    const target = fakeEl({ tagName: 'BUTTON', attrs: { 'aria-label': 'Like' } });
    withPage([target], () => {
      PAGE_FALLBACK_INSTALL();
      const rt = (globalThis as any).__browserControllerFallbackRuntime;
      expect(rt.generateFallback(target, {})).toMatchObject({ text: 'Like', nth: 0, tag: 'BUTTON' });
      // Idempotent: a second install is a no-op.
      expect(PAGE_FALLBACK_INSTALL()).toBe(false);
    });
  });
});
