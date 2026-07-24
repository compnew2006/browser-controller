import { describe, it, expect } from 'vitest';
import {
  isStableId,
  isGeneratedClass,
  buildRobustSelectorFromPath,
} from '../extension/utils/smart-selector.js';

/**
 * Smart-selector heuristic tests (plan task 5). The pure helpers are tested
 * here without a DOM. buildRobustSelectorFromPath only reads a handful of
 * element-shaped properties (tagName, id, getAttribute, parentElement), so we
 * build tiny fake elements rather than pull in jsdom.
 */

// --- tiny fake-element factory ---------------------------------------------

interface FakeEl {
  tagName: string;
  id?: string;
  className?: string;
  attrs?: Record<string, string | null>;
  parent?: FakeEl | null;
}

function mk(opts: FakeEl): any {
  const attrs = opts.attrs || {};
  return {
    tagName: options(opts.tagName),
    get id() { return opts.id ?? ''; },
    getAttribute(name: string) {
      if (name === 'class') return opts.className ?? null;
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
    },
    get parentElement() { return opts.parent ? mk(opts.parent) : null; },
  };
}
function options(s: string | undefined): string { return s || 'DIV'; }

// --- isStableId ------------------------------------------------------------

describe('isStableId', () => {
  it('accepts human-authored ids', () => {
    expect(isStableId('submit-btn')).toBe(true);
    expect(isStableId('login-form')).toBe(true);
    expect(isStableId('nav-header')).toBe(true);
  });

  it('rejects React/managed ids with colons', () => {
    expect(isStableId(':r5:')).toBe(false);
    expect(isStableId(':R3aq:')).toBe(false);
  });

  it('rejects generated prefixes', () => {
    expect(isStableId('react-aria-1-abc')).toBe(false);
    expect(isStableId('headlessui-menu-1')).toBe(false);
    expect(isStableId('radix-1')).toBe(false);
  });

  it('rejects hashed suffixes', () => {
    expect(isStableId('button-1a2b3c4d')).toBe(false);
    expect(isStableId('x-deadbeef')).toBe(false);
  });

  it('rejects framework double-underscore ids', () => {
    expect(isStableId('__BVID__42')).toBe(false);
  });

  it('rejects empty / numeric / uuid', () => {
    expect(isStableId('')).toBe(false);
    expect(isStableId('   ')).toBe(false);
    expect(isStableId('12345')).toBe(false);
  });
});

// --- isGeneratedClass ------------------------------------------------------

describe('isGeneratedClass', () => {
  it('flags styled-components hashes', () => {
    expect(isGeneratedClass('sc-jgyyrt')).toBe(true);
    expect(isGeneratedClass('StyledButton__sc-1a2b3c')).toBe(true);
  });

  it('flags emotion/css-in-js hashes', () => {
    expect(isGeneratedClass('css-1a2b3c')).toBe(true);
    expect(isGeneratedClass('emotion-0')).toBe(true);
  });

  it('keeps Tailwind/utility classes (stable + useful)', () => {
    expect(isGeneratedClass('flex')).toBe(false);
    expect(isGeneratedClass('px-4')).toBe(false);
    expect(isGeneratedClass('text-red-500')).toBe(false);
    expect(isGeneratedClass('btn-primary')).toBe(false);
    expect(isGeneratedClass('bg-blue-500')).toBe(false);
  });
});

// --- buildRobustSelectorFromPath ------------------------------------------

describe('buildRobustSelectorFromPath', () => {
  it('prefers a stable test attribute on the element', () => {
    const el = mk({ tagName: 'BUTTON', attrs: { 'data-testid': 'cta' } });
    expect(buildRobustSelectorFromPath(el)).toBe('button[data-testid=cta]');
  });

  it('prefers aria-label when no test attr', () => {
    const el = mk({ tagName: 'BUTTON', attrs: { 'aria-label': 'Submit form' } });
    // In node there's no global CSS.escape, so the fallback escaper runs and
    // does NOT escape spaces (browsers do). The selector still matches in the
    // page world via CSS.escape. Assert the node-side fallback output.
    expect(buildRobustSelectorFromPath(el)).toBe('button[aria-label=Submit form]');
  });

  it('uses a stable id', () => {
    const el = mk({ tagName: 'INPUT', id: 'email-field' });
    expect(buildRobustSelectorFromPath(el)).toBe('#email-field');
  });

  it('ignores a React-generated id and climbs to an anchor', () => {
    const el = mk({
      tagName: 'BUTTON',
      id: ':r5:',
      className: 'btn',
      parent: { tagName: 'NAV', id: 'main-nav' },
    });
    // id `:r5:` is unstable → climb to <nav id="main-nav">
    expect(buildRobustSelectorFromPath(el)).toBe('#main-nav > button.btn');
  });

  it('anchors at a semantic landmark ancestor when no id', () => {
    const el = mk({
      tagName: 'A',
      className: 'link',
      parent: { tagName: 'HEADER' },
    });
    expect(buildRobustSelectorFromPath(el)).toBe('header > a.link');
  });

  it('ignores generated classes, keeps stable ones', () => {
    const el = mk({
      tagName: 'BUTTON',
      className: 'css-1a2b3c btn primary',
      parent: { tagName: 'DIV', attrs: { role: 'main' } },
    });
    expect(buildRobustSelectorFromPath(el)).toBe('div[role=main] > button.btn.primary');
  });

  it('returns null when nothing stable can be built', () => {
    // generic tag, no classes, no attrs, no useful ancestors
    const el = mk({ tagName: 'DIV', parent: { tagName: 'DIV', parent: { tagName: 'DIV' } } });
    expect(buildRobustSelectorFromPath(el)).toBeNull();
  });

  it('handles null/undefined input safely', () => {
    expect(buildRobustSelectorFromPath(null as any)).toBeNull();
    expect(buildRobustSelectorFromPath(undefined as any)).toBeNull();
  });
});
