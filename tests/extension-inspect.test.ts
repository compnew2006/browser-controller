import { beforeEach, describe, expect, it } from 'vitest';
import { installFakePage, type FakeDocument } from './helpers/fake-dom.js';

/**
 * browser_inspect_element (3.0), end to end: the real page function runs against the
 * fake DOM; rules and listeners come from a CDP mock whose tree matches the fake page
 * (html > body > button). Output is text: one header line, then the sections.
 */
const sent: string[] = [];
const sentParams: Record<string, any>[] = [];
let COMPUTED: Record<string, string> = {};
let emit: (source: { tabId: number }, method: string, params: unknown) => void = () => {};
let documentRoot: unknown;
let failAttach = false;
let failDocument = false;
let failMatched = false;

const btnNode = (attributes: string[] = ['id', 'go', 'class', 'btn']) => ({ nodeType: 1, nodeName: 'BUTTON', backendNodeId: 3, attributes, children: [] });
const tree = (button: unknown) => ({
  nodeType: 9,
  nodeName: '#document',
  children: [{ nodeType: 1, nodeName: 'HTML', backendNodeId: 1, children: [{ nodeType: 1, nodeName: 'BODY', backendNodeId: 2, children: [button] }] }],
});

(globalThis as any).chrome = {
  tabs: { get: async (id: number) => ({ id, url: 'https://app.test/', windowId: 1 }), query: async () => [], onRemoved: { addListener: () => {} }, onUpdated: { addListener: () => {}, removeListener: () => {} } },
  windows: { get: async () => ({ width: 1280, height: 900 }) },
  storage: { session: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({}), set: async () => {} } },
  scripting: {
    executeScript: async (o: { func: (...a: unknown[]) => unknown; args?: unknown[] }) => [{ result: await o.func(...(o.args ?? [])) }],
  },
  debugger: {
    attach: async () => {
      if (failAttach) throw new Error('Cannot attach to this target: DevTools is open');
    },
    detach: async () => {},
    sendCommand: async ({ tabId }: { tabId: number }, method: string, params: any = {}) => {
      sent.push(method);
      sentParams.push({ method, ...params });
      switch (method) {
        case 'DOM.getDocument':
          if (failDocument) throw new Error('Protocol error: DOM is busy');
          return { root: documentRoot };
        case 'DOM.pushNodesByBackendIdsToFrontend': return { nodeIds: [params.backendNodeIds[0] + 100] };
        case 'CSS.enable':
          emit({ tabId }, 'CSS.styleSheetAdded', { header: { styleSheetId: 's1', sourceURL: 'https://app.test/app.css', startLine: 0 } });
          return {};
        case 'CSS.getMatchedStylesForNode':
          if (failMatched) throw new Error('Could not find node with given id');
          return {
          matchedCSSRules: [{
            matchingSelectors: [0],
            rule: {
              origin: 'regular', styleSheetId: 's1',
              selectorList: { selectors: [{ text: '.btn' }], text: '.btn' },
              style: { range: { startLine: 9 }, cssProperties: [{ name: 'color', value: 'red', range: {} }, { name: 'color', value: 'red' }] },
            },
          }],
          inherited: [{ matchedCSSRules: [] }],
        };
        case 'Debugger.enable':
          // The scripts parsed before the domain was enabled are announced now.
          emit({ tabId }, 'Debugger.scriptParsed', { scriptId: '7', url: 'https://app.test/app.js' });
          return {};
        case 'DOM.resolveNode': return { object: { objectId: `obj-${params.backendNodeId}` } };
        case 'Runtime.callFunctionOn': return { result: { objectId: /defaultView/.test(params.functionDeclaration) ? 'win' : 'doc' } };
        case 'DOMDebugger.getEventListeners': return {
          listeners: params.objectId === 'obj-3' ? [{ type: 'click', useCapture: false, scriptId: '7', lineNumber: 11, columnNumber: 4 }]
            : params.objectId === 'win' ? [{ type: 'resize', useCapture: false, scriptId: 'gone', lineNumber: 0, columnNumber: 0 }] : [],
        };
        default: return {};
      }
    },
    onEvent: { addListener: (fn: typeof emit) => { emit = fn; } },
    onDetach: { addListener: () => {} },
  },
};

/** The fake page has no computed styles of its own: a map of the ones the test sets. */
function useComputedStyles() {
  (globalThis as any).getComputedStyle = () => {
    const names = Object.keys(COMPUTED);
    return Object.assign(Object.create(null), {
      length: names.length,
      getPropertyValue: (n: string) => COMPUTED[n] ?? '',
      [Symbol.iterator]: function* () { yield* names; },
    });
  };
}

const { handleInspectElement } = await import('../extension/handlers/inspect.js');
const { detachCdp } = await import('../extension/lib/cdp-session.js');
const { PAGE_DOM_INSTALL, PAGE_DOM_VERSION } = await import('../extension/lib/page-dom.js');
const { fallbackByTab } = await import('../extension/lib/state.js');

let doc: FakeDocument;
const HEADER = 'button#go.btn "Go" box 96,196 58x38';

function boxed(id: string, attrs: Record<string, string> = {}) {
  const el = doc.el('button', { id, ...attrs }, 'Go');
  Object.defineProperty(el, 'getBoundingClientRect', {
    value: () => ({ x: 96, y: 196, left: 96, top: 196, width: 58, height: 38, right: 154, bottom: 234 }),
  });
  Object.defineProperty(el, 'classList', { value: ['btn'] });
  doc.body.append(el);
  return el;
}

beforeEach(async () => {
  await detachCdp(3);
  sent.length = 0;
  sentParams.length = 0;
  failAttach = false;
  failDocument = false;
  failMatched = false;
  COMPUTED = { display: 'inline-block', color: 'rgb(255, 0, 0)', width: '58px', height: '38px', 'font-size': '16px' };
  fallbackByTab.clear();
  doc = installFakePage('https://app.test/');
  useComputedStyles(); // after installFakePage, which sets its own
  PAGE_DOM_INSTALL(PAGE_DOM_VERSION);
  boxed('go', { class: 'btn' });
  documentRoot = tree(btnNode());
});

describe('browser_inspect_element: styles (page side, no debugger)', () => {
  it('default: the computed styles that differ from the defaults, the debugger is never touched', async () => {
    const res = await handleInspectElement({ tabId: 3, target: '#go' }) as any;
    expect(res).toEqual({ success: true, text: `${HEADER}\ndisplay: inline-block\nwidth: 58px\nheight: 38px\ncolor: rgb(255, 0, 0)\nfont-size: 16px` });
    expect(sent).toEqual([]);
  });

  it('says so when nothing differs from the defaults', async () => {
    COMPUTED = {};
    const res = await handleInspectElement({ tabId: 3, target: '#go' }) as any;
    expect(res.text).toBe(`${HEADER}\n(no computed style differs from the defaults)`);
  });

  it('properties: exactly those, and a name that is not a property is said so', async () => {
    const res = await handleInspectElement({ tabId: 3, target: '#go', properties: ['color', 'nope'] }) as any;
    expect(res.text).toBe(`${HEADER}\ncolor: rgb(255, 0, 0)\nnope: (unknown property)`);
  });

  it('properties ["*"]: all of them, capped at 120 with a note', async () => {
    COMPUTED = Object.fromEntries(Array.from({ length: 130 }, (_, i) => [`prop-${i}`, `v${i}`]));
    const res = await handleInspectElement({ tabId: 3, target: '#go', properties: ['*'] }) as any;
    const lines = res.text.split('\n');
    expect(lines).toHaveLength(1 + 120 + 1);
    expect(lines.at(-1)).toBe('… 10 more properties not shown: name the ones you need in properties');
  });

  it('a selector that matches only hidden elements is still inspected (why is it hidden?)', async () => {
    const hid = doc.el('button', { id: 'hid' }, 'Hidden');
    hid.hidden = true;
    Object.defineProperty(hid, 'classList', { value: [] });
    doc.body.append(hid);
    const res = await handleInspectElement({ tabId: 3, target: '#hid' }) as any;
    expect(res.success).toBe(true);
    expect(res.text.split('\n')[0]).toMatch(/^button#hid "Hidden" box /);
  });
});

describe('browser_inspect_element: rules and listeners (CDP)', () => {
  it('rules and listeners: one section each, the rule with its source line, the listeners with script:line', async () => {
    const res = await handleInspectElement({ tabId: 3, target: '#go', rules: true, listeners: true }) as any;
    expect(res).toEqual({
      success: true,
      text: [
        HEADER,
        'rules:',
        '.btn  https://app.test/app.css:10',
        '  color: red',
        'listeners:',
        'click  https://app.test/app.js:12',
        'resize  unknown script:1 (on window)',
      ].join('\n'),
    });
  });

  it('every CDP domain it turned on is released afterwards, and pauses are skipped while it looks', async () => {
    await handleInspectElement({ tabId: 3, target: '#go', rules: true, listeners: true });
    expect(sent).toEqual(expect.arrayContaining(['CSS.disable', 'DOM.disable', 'Runtime.releaseObjectGroup', 'Debugger.disable']));
    expect(sent.indexOf('CSS.disable')).toBeGreaterThan(sent.indexOf('CSS.getMatchedStylesForNode'));
    expect(sentParams).toContainEqual({ method: 'Debugger.setSkipAllPauses', skip: true });
    expect(sentParams).toContainEqual({ method: 'Debugger.setSkipAllPauses', skip: false });
  });

  it('listeners alone: no rules, no styles', async () => {
    const res = await handleInspectElement({ tabId: 3, target: '#go', listeners: true }) as any;
    expect(res.text).toBe(`${HEADER}\nlisteners:\nclick  https://app.test/app.js:12\nresize  unknown script:1 (on window)`);
    expect(sent).not.toContain('CSS.enable');
  });

  it('a debugger that cannot attach fails with DEBUGGER_UNAVAILABLE, the styles are not returned as if complete', async () => {
    failAttach = true;
    await expect(handleInspectElement({ tabId: 3, target: '#go', rules: true })).rejects.toThrow(/^DEBUGGER_UNAVAILABLE: Cannot attach/);
  });

  it('a CDP error once attached is INSPECT_FAILED with the CDP message, not a missing debugger', async () => {
    failDocument = true;
    await expect(handleInspectElement({ tabId: 3, target: '#go', rules: true })).rejects.toThrow(/^INSPECT_FAILED: Protocol error: DOM is busy/);
  });

  it('the node is gone from the CDP tree once attached: NOT_FOUND, said so', async () => {
    failMatched = true;
    await expect(handleInspectElement({ tabId: 3, target: '#go', rules: true })).rejects.toThrow(/^NOT_FOUND: the element changed/);
  });

  it('the DOM moved between the page read and the CDP read: says so', async () => {
    documentRoot = tree(btnNode(['id', 'other']));
    documentRoot = { nodeType: 9, nodeName: '#document', children: [] };
    await expect(handleInspectElement({ tabId: 3, target: '#go', rules: true })).rejects.toThrow(/^NOT_FOUND: the element changed/);
  });
});

describe('browser_inspect_element: arguments', () => {
  it('target is required', async () => {
    await expect(handleInspectElement({ tabId: 3 } as any)).rejects.toThrow(/^INVALID_ARGUMENT: target is required/);
  });

  it('ref, selector and include (removed in 3.0) are refused, not answered with another element', async () => {
    await expect(handleInspectElement({ tabId: 3, target: '#go', ref: 'e4' } as any)).rejects.toThrow(/^INVALID_ARGUMENT: ref is not/);
    await expect(handleInspectElement({ tabId: 3, target: '#go', selector: '#go' } as any)).rejects.toThrow(/^INVALID_ARGUMENT: selector is not/);
    await expect(handleInspectElement({ tabId: 3, target: '#go', include: ['styles'] } as any)).rejects.toThrow(/^INVALID_ARGUMENT: include is not/);
  });

  it('a target that matches nothing, and a stale ref, say what went wrong', async () => {
    await expect(handleInspectElement({ tabId: 3, target: '#nope' })).rejects.toThrow(/^NOT_FOUND: /);
    await expect(handleInspectElement({ tabId: 3, target: 'e9' })).rejects.toThrow(/^REF_NOT_FOUND: ref e9 /);
  });

  it('a ref issued here whose element left is REF_GONE, worded from the page (issued), not from a fallback', async () => {
    const save = doc.el('button', { id: 'save' }, 'Save');
    doc.body.append(save);
    const ref = (globalThis as any).__bcDom.refFor(save) as string;
    save.isConnected = false;
    doc.body.childNodes.splice(doc.body.childNodes.indexOf(save), 1);
    await expect(handleInspectElement({ tabId: 3, target: ref })).rejects.toThrow(new RegExp(`^REF_GONE: ref ${ref} is no longer on the page`));
  });

  it('an element re-found by its snapshot descriptor: the reply says it was re-found, on its own line at the end', async () => {
    fallbackByTab.set(3, new Map([['e1', { robustSelector: 'button#go', text: 'Go', role: 'button', tag: 'BUTTON', nth: 0 }]]));
    const res = await handleInspectElement({ tabId: 3, target: 'e1' }) as any;
    expect(res.success).toBe(true);
    expect(res.text.split('\n').at(-1)).toBe('note: e1 was re-found after the page changed');
    expect(res.text.split('\n')[0]).toBe(HEADER);
  });
});
