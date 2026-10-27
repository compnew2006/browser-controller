import { beforeEach, describe, expect, it } from 'vitest';
import { installFakePage, type FakeDocument, type FakeElement } from './helpers/fake-dom.js';

// F7-5: the safety classifier fingerprints the target; click, type and fill compare the fingerprint
// of the element they resolve at dispatch time, before any trusted input. Page functions run in this
// process against the fake page; the debugger records every CDP command.

const cdp: Array<{ method: string; params: Record<string, any> }> = [];

(globalThis as any).chrome = {
  tabs: { get: async (id: number) => ({ id, url: 'https://example.test/page', windowId: 1 }), query: async () => [], onRemoved: { addListener: () => {} } },
  scripting: {
    // Chrome runs a page function from its source text: a module-level name it uses is a ReferenceError there.
    executeScript: async (o: { func: (...a: any[]) => unknown; args?: unknown[] }) => {
      const pageFn = new Function(`return (${o.func.toString()});`)() as (...a: any[]) => unknown;
      return [{ result: await pageFn(...(o.args ?? [])) }];
    },
  },
  storage: { session: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({ agentCursor: false }), set: async () => {} } },
  debugger: {
    attach: async () => {},
    detach: async () => {},
    sendCommand: async (_t: unknown, method: string, params: Record<string, any> = {}) => {
      cdp.push({ method, params });
      // A press focuses the element under the point; inserted text goes to whatever has focus.
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') {
        const hit = ((doc as any).elementsFromPoint?.(params.x, params.y) ?? [])[0];
        if (hit && typeof hit.focus === 'function') hit.focus();
      }
      if (method === 'Input.insertText') {
        const el = doc.activeElement as FakeElement | null;
        if (el) el.value = `${el.value ?? ''}${params.text}`;
      }
      return {};
    },
    onEvent: { addListener: () => {} },
    onDetach: { addListener: () => {} },
  },
};

const { PAGE_DOM_INSTALL, PAGE_DOM_VERSION } = await import('../extension/lib/page-dom.js');
const { handleClick, handleType } = await import('../extension/handlers/interaction.js');
const { handleFill } = await import('../extension/handlers/interaction-advanced.js');
const { handleClassifyAction } = await import('../extension/handlers/action-safety.js');
const { detachCdp } = await import('../extension/lib/cdp-session.js');
const { fallbackByTab } = await import('../extension/lib/state.js');

let doc: FakeDocument;
const D = () => (globalThis as any).__bcDom;
const inputs = () => cdp.filter((c) => c.method.startsWith('Input.'));
const CHANGED = /^SAFETY_TARGET_CHANGED: the target changed after the safety check; no input was sent\./;
const STALE = 'e999:button:submit';

function stackAt(...topmostFirst: FakeElement[]) {
  (doc as any).elementsFromPoint = () => topmostFirst;
}
/** The fingerprint the classifier reports for a click on `target`. */
async function classified(action: string, params: Record<string, unknown>): Promise<string[]> {
  const res = await handleClassifyAction({ tabId: 1, action, ...params });
  return res.fingerprints;
}

beforeEach(async () => {
  cdp.length = 0;
  await detachCdp(1);
  doc = installFakePage();
  (globalThis as any).innerWidth = 1000;
  (globalThis as any).innerHeight = 700;
  fallbackByTab.clear();
  PAGE_DOM_INSTALL(PAGE_DOM_VERSION);
});

describe('browser_click: dispatch-time fingerprint', () => {
  it('a fingerprint that no longer matches throws SAFETY_TARGET_CHANGED and sends no input', async () => {
    const btn = doc.el('button', { id: 'go' }, 'Go');
    doc.body.append(btn);
    stackAt(btn);
    await expect(handleClick({ tabId: 1, target: '#go', expectFingerprints: [STALE] })).rejects.toThrow(CHANGED);
    expect(inputs()).toEqual([]);
    expect(btn.events).not.toContain('click');
  });

  it('a swapped-in element (new ref) is refused', async () => {
    const first = doc.el('button', { id: 'go' }, 'Go');
    doc.body.append(first);
    const expectFingerprints = await classified('browser_click', { target: '#go' });
    // The page replaces the benign button by a submit button the same selector now finds.
    first.setAttribute('id', 'old');
    const swapped = doc.el('button', { id: 'go', type: 'submit' }, 'Go');
    doc.body.append(swapped);
    stackAt(swapped);
    await expect(handleClick({ tabId: 1, target: '#go', expectFingerprints })).rejects.toThrow(CHANGED);
    expect(inputs()).toEqual([]);
    expect(swapped.events).not.toContain('click');
  });

  it('a matching fingerprint, taken from the classifier, clicks', async () => {
    const btn = doc.el('button', { id: 'go' }, 'Go');
    doc.body.append(btn);
    stackAt(btn);
    const expectFingerprints = await classified('browser_click', { target: '#go' });
    expect(expectFingerprints).toHaveLength(1);
    const res = await handleClick({ tabId: 1, target: '#go', expectFingerprints });
    expect(res).toMatchObject({ success: true });
    expect(inputs().filter((c) => c.params.type === 'mousePressed')).toHaveLength(1);
  });

  it('without expectFingerprints the behaviour is unchanged', async () => {
    const btn = doc.el('button', { id: 'go' }, 'Go');
    doc.body.append(btn);
    stackAt(btn);
    expect(await handleClick({ tabId: 1, target: '#go' })).toMatchObject({ success: true });
    expect(inputs().filter((c) => c.params.type === 'mousePressed')).toHaveLength(1);
  });

  it('an empty list has nothing to compare and does not fail', async () => {
    const btn = doc.el('button', { id: 'go' }, 'Go');
    doc.body.append(btn);
    stackAt(btn);
    expect(await handleClick({ tabId: 1, target: '#go', expectFingerprints: [] })).toMatchObject({ success: true });
  });

  it('a count that differs from the one element clicked is refused', async () => {
    const btn = doc.el('button', { id: 'go' }, 'Go');
    doc.body.append(btn);
    stackAt(btn);
    const [fp] = await classified('browser_click', { target: '#go' });
    await expect(handleClick({ tabId: 1, target: '#go', expectFingerprints: [fp, fp] })).rejects.toThrow(CHANGED);
    expect(inputs()).toEqual([]);
  });

  it('a point target is classified without a probe (empty list) and clicks', async () => {
    const btn = doc.el('button', { id: 'go' }, 'Go');
    doc.body.append(btn);
    stackAt(btn);
    expect(await handleClick({ tabId: 1, target: '50,50', expectFingerprints: [] })).toMatchObject({ success: true });
  });
});

describe('browser_type: dispatch-time fingerprint', () => {
  it('a target that changed is refused before the focusing click or any text', async () => {
    const field = doc.el('input', { id: 'q', type: 'text' });
    doc.body.append(field);
    stackAt(field);
    await expect(handleType({ tabId: 1, target: '#q', text: 'hello', expectFingerprints: ['e999:input:text'] })).rejects.toThrow(CHANGED);
    expect(inputs()).toEqual([]);
  });

  it('a matching target is typed into', async () => {
    const field = doc.el('input', { id: 'q', type: 'text' });
    doc.body.append(field);
    stackAt(field);
    const expectFingerprints = await classified('browser_type', { target: '#q' });
    await handleType({ tabId: 1, target: '#q', text: 'hello', expectFingerprints });
    expect(cdp.some((c) => c.method === 'Input.insertText')).toBe(true);
  });

  it('with no target and submit, the focused element is compared', async () => {
    const field = doc.el('input', { id: 'q', type: 'text' });
    const other = doc.el('input', { id: 'other', type: 'text' });
    doc.body.append(field, other);
    doc.activeElement = field;
    const expectFingerprints = await classified('browser_type', { submit: true });
    expect(expectFingerprints).toHaveLength(1);
    // The page moves focus before the Enter is sent.
    doc.activeElement = other;
    await expect(handleType({ tabId: 1, submit: true, expectFingerprints })).rejects.toThrow(CHANGED);
    expect(inputs()).toEqual([]);
    doc.activeElement = field;
    await handleType({ tabId: 1, submit: true, expectFingerprints });
    expect(cdp.some((c) => c.method === 'Input.dispatchKeyEvent')).toBe(true);
  });

  it('without expectFingerprints the behaviour is unchanged', async () => {
    const field = doc.el('input', { id: 'q', type: 'text' });
    doc.body.append(field);
    stackAt(field);
    await handleType({ tabId: 1, target: '#q', text: 'hello' });
    expect(cdp.some((c) => c.method === 'Input.insertText')).toBe(true);
  });
});

describe('browser_fill: dispatch-time fingerprints', () => {
  function twoFields() {
    const a = doc.el('input', { id: 'a', type: 'text' });
    const b = doc.el('input', { id: 'b', type: 'text' });
    // Two boxes, one above the other; the hit test answers with the box under the point.
    [a, b].forEach((el, i) => {
      const top = 10 + i * 100;
      (el as any).getBoundingClientRect = () => ({ x: 10, y: top, left: 10, top, width: 100, height: 40, right: 110, bottom: top + 40 });
    });
    doc.body.append(a, b);
    (doc as any).elementsFromPoint = (x: number, y: number) => [a, b].filter((el) => {
      const r = (el as any).getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    });
    return { a, b, fields: [{ target: '#a', value: 'one' }, { target: '#b', value: 'two' }] };
  }

  it('when the second field no longer matches, nothing is typed into either', async () => {
    const { a, b, fields } = twoFields();
    const [fpA] = await classified('browser_fill', { fields: [{ target: '#a' }] });
    await expect(handleFill({ tabId: 1, fields, expectFingerprints: [fpA, 'e999:input:text'] })).rejects.toThrow(CHANGED);
    expect(inputs()).toEqual([]);
    expect(a.value ?? '').toBe('');
    expect(b.value ?? '').toBe('');
  });

  it('a count that differs from the fields resolved is refused', async () => {
    const { fields } = twoFields();
    const [fpA] = await classified('browser_fill', { fields: [{ target: '#a' }] });
    await expect(handleFill({ tabId: 1, fields, expectFingerprints: [fpA] })).rejects.toThrow(CHANGED);
    expect(inputs()).toEqual([]);
  });

  it('matching fingerprints, in the classifier order, fill', async () => {
    const { fields } = twoFields();
    const expectFingerprints = await classified('browser_fill', { fields: fields.map((f) => ({ target: f.target })) });
    expect(expectFingerprints).toHaveLength(2);
    const res = await handleFill({ tabId: 1, fields, expectFingerprints });
    expect(res.text ?? res.error).toMatch(/filled 2 fields|FILL_FAILED/);
    expect(cdp.filter((c) => c.method === 'Input.insertText')).toHaveLength(2);
  });

  it('without expectFingerprints the behaviour is unchanged', async () => {
    const { fields } = twoFields();
    await handleFill({ tabId: 1, fields });
    expect(cdp.filter((c) => c.method === 'Input.insertText')).toHaveLength(2);
  });
});

describe('fingerprint formula', () => {
  it('is the classifier\'s: ref:tag:type, from one shared helper', async () => {
    const btn = doc.el('button', { id: 'go', type: 'Submit' }, 'Go');
    const plain = doc.el('div', { id: 'plain' }, 'x');
    doc.body.append(btn, plain);
    expect(D().safetyFingerprint(btn)).toBe(`${D().refFor(btn)}:button:submit`);
    expect(D().safetyFingerprint(plain)).toBe(`${D().refFor(plain)}:div:`);
    expect(await classified('browser_click', { target: '#go' })).toEqual([D().safetyFingerprint(btn)]);
  });
});
