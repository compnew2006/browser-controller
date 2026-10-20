import { beforeEach, describe, expect, it } from 'vitest';

const sent: string[] = [];
let pageResult: unknown;
let pathResult: unknown;
let documentRoot: unknown;
let emit: (source: { tabId: number }, method: string, params: unknown) => void = () => {};
const el = (nodeName: string, backendNodeId: number, children: object[] = [], attributes: string[] = []) => ({ nodeType: 1, nodeName, backendNodeId, children, attributes });

(globalThis as any).chrome = {
  tabs: { get: async (id: number) => ({ id, url: 'https://app.test/', windowId: 1 }), onRemoved: { addListener: () => {} } },
  windows: { get: async () => ({ width: 1280, height: 900 }) },
  storage: { session: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({}), set: async () => {} } },
  scripting: {
    executeScript: async ({ func }: { func: { name: string } }) => [{ result: func.name === 'pathOfTarget' ? pathResult : pageResult }],
  },
  debugger: {
    attach: async () => {},
    detach: async () => {},
    sendCommand: async ({ tabId }: { tabId: number }, method: string, params: any) => {
      sent.push(method);
      switch (method) {
        case 'DOM.getDocument': return { root: documentRoot };
        case 'DOM.pushNodesByBackendIdsToFrontend': return { nodeIds: [params.backendNodeIds[0] + 100] };
        case 'CSS.enable':
          emit({ tabId }, 'CSS.styleSheetAdded', { header: { styleSheetId: 's1', sourceURL: 'https://app.test/app.css', startLine: 0 } });
          return {};
        case 'CSS.getMatchedStylesForNode': return {
          matchedCSSRules: [{
            matchingSelectors: [0],
            rule: { origin: 'regular', styleSheetId: 's1', selectorList: { selectors: [{ text: '.btn' }], text: '.btn' },
              style: { range: { startLine: 9 }, cssProperties: [{ name: 'color', value: 'red', range: {} }, { name: 'color', value: 'red' }] } },
          }],
          inherited: [{ matchedCSSRules: [] }],
        };
        case 'DOM.resolveNode': return { object: { objectId: `obj-${params.backendNodeId}` } };
        case 'Runtime.callFunctionOn': return { result: { objectId: /defaultView/.test(params.functionDeclaration) ? 'win' : 'doc' } };
        case 'DOMDebugger.getEventListeners': return {
          listeners: params.objectId === 'obj-3' ? [{ type: 'click', useCapture: false, lineNumber: 4, columnNumber: 0, handler: { description: 'go()' } }]
            : params.objectId === 'win' ? [{ type: 'resize', useCapture: false }] : [],
        };
        default: return { result: { value: 1 } };
      }
    },
    onEvent: { addListener: (fn: typeof emit) => { emit = fn; } },
    onDetach: { addListener: () => {} },
  },
};

const { handleInspectElement } = await import('../extension/handlers/inspect.js');
const { detachCdp } = await import('../extension/lib/cdp-session.js');

const PAGE = { element: { tag: 'button', classes: ['btn'], box: { x: 1, y: 2, width: 30, height: 20 } }, styles: { color: 'rgb(255, 0, 0)' } };

describe('browser_inspect_element', () => {
  beforeEach(async () => {
    await detachCdp(3);
    sent.length = 0;
    pageResult = PAGE;
    pathResult = { path: [0, 1, 0], tag: 'BUTTON' };
    documentRoot = { nodeType: 9, children: [el('HTML', 1, [el('HEAD', 9), el('BODY', 2, [el('BUTTON', 3, [], ['class', 'btn'])], ['class', 'page'])])] };
  });

  it('styles only: answered from the page, the debugger is never touched', async () => {
    const res = await handleInspectElement({ tabId: 3, selector: '.btn', include: ['styles'] }) as any;
    expect(res).toEqual({ success: true, ...PAGE });
    expect(sent).toEqual([]);
  });

  it('rules and listeners come from CDP and every domain is released afterwards', async () => {
    const res = await handleInspectElement({ tabId: 3, selector: '.btn' }) as any;
    expect(res.rules).toEqual([{ selector: '.btn', source: 'https://app.test/app.css:10', style: 'color: red' }]);
    expect(res.listeners).toEqual([{ type: 'click', handler: 'go()', line: 5, column: 1 }]);
    expect(res.delegated).toEqual([{ on: 'window', types: ['resize'] }]);
    expect(res.styles).toEqual(PAGE.styles);
    expect(sent).toEqual(expect.arrayContaining(['CSS.disable', 'DOM.disable', 'Runtime.releaseObjectGroup']));
    expect(sent.indexOf('CSS.disable')).toBeGreaterThan(sent.indexOf('CSS.getMatchedStylesForNode'));
  });

  it('only what include asks for', async () => {
    const res = await handleInspectElement({ tabId: 3, ref: 'e4', include: ['listeners'] }) as any;
    expect(res.rules).toBeUndefined();
    expect(res.styles).toBeUndefined();
    expect(res.listeners).toHaveLength(1);
    expect(sent).not.toContain('CSS.enable');
  });

  it('says what went wrong instead of returning empty data', async () => {
    pageResult = { error: 'INVALID_SELECTOR' };
    expect(await handleInspectElement({ tabId: 3, selector: 'p[' })).toEqual({ success: false, error: 'Invalid CSS selector: p[' });
    pageResult = { error: 'REF_GONE' };
    expect((await handleInspectElement({ tabId: 3, ref: 'e9' }) as any).error).toMatch(/ref e9 is gone/);
    pageResult = PAGE;
    pathResult = { path: [0, 1, 5], tag: 'BUTTON' }; // the DOM changed between the two reads
    expect((await handleInspectElement({ tabId: 3, selector: '.btn' }) as any).error).toMatch(/changed while it was being inspected/);
    await expect(handleInspectElement({ tabId: 3 })).rejects.toThrow(/ref or selector is required/);
  });
});
