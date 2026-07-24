import { describe, it, expect } from 'vitest';
import {
  isStableId,
  isGeneratedClass,
  buildRobustSelectorFromPath,
  pickNthMatch,
  computeNewFingerprints,
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

// --- nth recovery (Feature 2, borrowed from BrowserOS) ---------------------

describe('pickNthMatch', () => {
  it('picks the first match by default (nth omitted)', () => {
    expect(pickNthMatch(['a', 'b', 'c'])).toBe('a');
  });

  it('picks the nth match (0-based)', () => {
    expect(pickNthMatch(['a', 'b', 'c'], 0)).toBe('a');
    expect(pickNthMatch(['a', 'b', 'c'], 1)).toBe('b');
    expect(pickNthMatch(['a', 'b', 'c'], 2)).toBe('c');
  });

  it('falls back to the first match when nth exceeds the list (DOM shrank)', () => {
    // 3 "Like" buttons at snapshot, only 2 remain after re-render; nth=2 → best effort = first
    expect(pickNthMatch(['x', 'y'], 2)).toBe('x');
  });

  it('returns null for empty/null input', () => {
    expect(pickNthMatch([], 0)).toBeNull();
    expect(pickNthMatch(null as any, 0)).toBeNull();
    expect(pickNthMatch(undefined as any, 0)).toBeNull();
  });

  it('treats negative/invalid nth as 0', () => {
    expect(pickNthMatch(['a', 'b'], -1 as any)).toBe('a');
    expect(pickNthMatch(['a', 'b'], NaN as any)).toBe('a');
  });

  it('resolves the RIGHT sibling among duplicates (the whole point)', () => {
    // 3 buttons all named "Like"; the agent snapshotted the SECOND one (nth=1)
    const buttons = [
      { id: 1, name: 'Like' },
      { id: 2, name: 'Like' },
      { id: 3, name: 'Like' },
    ];
    expect(pickNthMatch(buttons, 1)).toEqual({ id: 2, name: 'Like' });
    expect(pickNthMatch(buttons, 2)).toEqual({ id: 3, name: 'Like' });
  });
});

// --- isNew fingerprinting (Feature 1, borrowed from Page-Agent *[index]) ---

describe('computeNewFingerprints', () => {
  it('marks elements whose role|name was NOT in the previous snapshot', () => {
    const prev = ['button|Submit', 'link|Home', 'textbox|Email'];
    const curr = ['button|Submit', 'link|Home', 'button|Cancel', 'textbox|Email'];
    const isNew = computeNewFingerprints(prev, curr);
    expect(isNew.has('button|Cancel')).toBe(true);
    expect(isNew.has('button|Submit')).toBe(false);
    expect(isNew.has('link|Home')).toBe(false);
    expect(isNew.size).toBe(1);
  });

  it('first snapshot (empty previous) marks everything as new', () => {
    const curr = ['button|Submit', 'link|Home'];
    const isNew = computeNewFingerprints([], curr);
    expect(isNew.size).toBe(2);
    expect(isNew.has('button|Submit')).toBe(true);
  });

  it('no changes → nothing new', () => {
    const prev = ['button|Submit', 'link|Home'];
    const curr = ['button|Submit', 'link|Home'];
    expect(computeNewFingerprints(prev, curr).size).toBe(0);
  });

  it('handles null/undefined inputs safely', () => {
    expect(computeNewFingerprints(null, ['a']).size).toBe(1);
    expect(computeNewFingerprints(['a'], null).size).toBe(0);
    expect(computeNewFingerprints(null, null).size).toBe(0);
  });

  it('deduplicates repeated fingerprints in current', () => {
    // two buttons named "Like" both new → one fingerprint entry
    const isNew = computeNewFingerprints([], ['button|Like', 'button|Like']);
    expect(isNew.size).toBe(1);
    expect(isNew.has('button|Like')).toBe(true);
  });
});
