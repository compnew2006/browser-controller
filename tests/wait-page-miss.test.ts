import { beforeEach, describe, expect, it } from 'vitest';
import { installFakePage } from './helpers/fake-dom.js';

// The page side of browser_wait reports why a target is not visible, so a TIMEOUT can say it.
const { PAGE_DOM_INSTALL, PAGE_DOM_VERSION } = await import('../extension/lib/page-dom.js');
const { waitPage } = await import('../extension/lib/wait-page.js');
const run = (...a: unknown[]) => (new Function(`return (${waitPage.toString()});`)() as (...x: unknown[]) => any)(...a);

let doc: ReturnType<typeof installFakePage>;
beforeEach(() => {
  doc = installFakePage();
  (globalThis as any).innerWidth = 1000;
  (globalThis as any).innerHeight = 700;
  PAGE_DOM_INSTALL(PAGE_DOM_VERSION);
});

describe('waitPage miss', () => {
  it('NOT_FOUND when the selector matches nothing', () => {
    expect(run({ kind: 'selector', selector: '#nope' }, null, false, null, null)).toMatchObject({ met: false, miss: 'NOT_FOUND' });
  });

  it('ELEMENT_HIDDEN when it matches only hidden elements', () => {
    doc.body.append(doc.el('div', { id: 'h', style: 'display:none' }, 'x'));
    expect(run({ kind: 'selector', selector: '#h' }, null, false, null, null)).toMatchObject({ met: false, miss: 'ELEMENT_HIDDEN' });
  });

  it('no miss when the target is there', () => {
    doc.body.append(doc.el('div', { id: 'v' }, 'x'));
    expect(run({ kind: 'selector', selector: '#v' }, null, false, null, null)).toMatchObject({ met: true, miss: null });
  });
});
