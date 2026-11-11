import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// WP2b lock shield (G2): the frame must not steal hit tests, focus or hover from
// the page, while the user's pointer/keyboard/wheel input is still cancelled and
// the agent's own input still passes. The injected functions run here against a
// small fake document, through a chrome.scripting mock that calls them directly.

interface FakeListener {
  type: string;
  fn: (event: FakeInputEvent) => void;
  capture: boolean;
  passive: boolean;
}

interface FakeInputEvent {
  type: string;
  isTrusted: boolean;
  clientX: number;
  clientY: number;
  __bcAgentInputPermitId?: string;
  defaultPrevented: boolean;
  propagationStopped: boolean;
  preventDefault: () => void;
  stopImmediatePropagation: () => void;
}

class FakeNode {
  id = '';
  className = '';
  style: { cssText: string; pointerEvents?: string } = { cssText: '' };
  listeners: FakeListener[] = [];
  children: FakeNode[] = [];
  removed = false;
  constructor(public tagName: string) {}
  appendChild(node: FakeNode) { this.children.push(node); return node; }
  querySelector(selector: string) { return this.children.find((node) => selector === `.${node.className}`) ?? null; }
  addEventListener(type: string, fn: (event: FakeInputEvent) => void, options: { capture?: boolean; passive?: boolean } = {}) {
    this.listeners.push({ type, fn, capture: !!options.capture, passive: !!options.passive });
  }
  removeEventListener(type: string, fn: (event: FakeInputEvent) => void, options: { capture?: boolean } = {}) {
    this.listeners = this.listeners.filter((l) => !(l.type === type && l.fn === fn && l.capture === !!options.capture));
  }
  remove() { this.removed = true; }
}

class FakeDocument extends FakeNode {
  nodes = new Map<string, FakeNode>();
  documentElement = {
    appendChild: (node: FakeNode) => {
      this.nodes.set(node.id, node);
      return node;
    },
  };
  constructor() { super('#document'); }
  getElementById(id: string) { return this.nodes.get(id) ?? null; }
  createElement(tag: string) { return new FakeNode(tag); }
}

/** Input the page would see: user input is trusted, the agent's synthetic input is not. */
function inputEvent(type: string, isTrusted: boolean, clientX = 0, clientY = 0): FakeInputEvent {
  const event: FakeInputEvent = {
    type,
    isTrusted,
    clientX,
    clientY,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() { event.defaultPrevented = true; },
    stopImmediatePropagation() { event.propagationStopped = true; },
  };
  return event;
}

/** Run an injected page function the way chrome.scripting would, in this node process. */
let movementLockEnabled = false;
const runInPage = async (opts: { func: (...args: unknown[]) => unknown; args?: unknown[] }) => [{ result: opts.func(...(opts.args ?? [])) }];

(globalThis as unknown as { chrome: unknown }).chrome = {
  scripting: { executeScript: runInPage },
  storage: { local: { get: async () => ({ agentMouseMovementLock: movementLockEnabled }) } },
};

const overlay = await import('../extension/lib/overlay.js');

let document: FakeDocument;
const shield = () => document.nodes.get('__bc-lock-shield') as FakeNode;
const documentListeners = (type: string) => document.listeners.filter((l) => l.type === type);

describe('lock shield (WP2b, G2)', () => {
  beforeEach(() => {
    movementLockEnabled = false;
    document = new FakeDocument();
    (globalThis as unknown as { document: unknown }).document = document;
    (globalThis as unknown as { window: unknown }).window = globalThis;
    (globalThis as unknown as { top: unknown }).top = globalThis;
    (globalThis as unknown as { __bcAgentInputUntil: number }).__bcAgentInputUntil = 0;
    (globalThis as unknown as { __bcAgentInputPermit: unknown }).__bcAgentInputPermit = null;
  });
  afterEach(async () => {
    await overlay.hideLockShield(7);
    delete (globalThis as unknown as { document?: unknown }).document;
    delete (globalThis as unknown as { window?: unknown }).window;
    delete (globalThis as unknown as { top?: unknown }).top;
    delete (globalThis as unknown as { __bcAgentInputPermit?: unknown }).__bcAgentInputPermit;
  });

  it('the frame never takes hit tests: pointer-events is none, and the frame has no listeners of its own', async () => {
    await overlay.showLockShield(7);

    expect(shield().style.cssText).toContain('pointer-events:none');
    expect(shield().style.cssText).not.toContain('pointer-events:auto');
    expect(shield().listeners).toEqual([]);
  });

  it('does not intercept focus, so the page focus handlers still run', async () => {
    await overlay.showLockShield(7);

    expect(documentListeners('focus')).toEqual([]);
    expect(shield().listeners.some((l) => l.type === 'focus')).toBe(false);
  });

  it('cancels user pointer, key and wheel input on the document before the page sees it', async () => {
    await overlay.showLockShield(7);

    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click', 'contextmenu', 'keydown', 'keyup', 'wheel']) {
      const listeners = documentListeners(type);
      expect(listeners.length, type).toBeGreaterThan(0);
      expect(listeners.every((l) => l.capture), type).toBe(true);
      const event = inputEvent(type, true);
      for (const listener of listeners) listener.fn(event);
      expect(event.defaultPrevented, type).toBe(true);
      expect(event.propagationStopped, type).toBe(true);
    }
    // wheel/keydown/keyup must be non-passive for preventDefault to count.
    expect(documentListeners('wheel').every((l) => !l.passive)).toBe(true);
    expect(documentListeners('keydown').every((l) => !l.passive)).toBe(true);
  });

  it('lets the agent through: synthetic input (isTrusted false) and its CDP input window are not cancelled', async () => {
    await overlay.showLockShield(7);
    const synthetic = inputEvent('click', false);
    for (const listener of documentListeners('click')) listener.fn(synthetic);
    expect(synthetic.defaultPrevented).toBe(false);

    (globalThis as unknown as { __bcAgentInputUntil: number }).__bcAgentInputUntil = Date.now() + 5_000;
    const trusted = inputEvent('mousedown', true);
    for (const listener of documentListeners('mousedown')) listener.fn(trusted);
    expect(trusted.defaultPrevented).toBe(false);
  });

  it('blocks user movement while enabled and permits only the matching agent event', async () => {
    expect(await overlay.showLockShield(7, 'agent controlling the tab', false, true)).toBe(true);
    expect(shield().style.pointerEvents).toBe('auto');

    const userMove = inputEvent('mousemove', true, 31, 40);
    for (const listener of documentListeners('mousemove')) listener.fn(userMove);
    expect(userMove.defaultPrevented).toBe(true);

    let agentMove: FakeInputEvent | undefined;
    await overlay.dispatchAgentInput(7, async () => {
      agentMove = inputEvent('mousemove', true, 30, 40);
      for (const listener of documentListeners('mousemove')) listener.fn(agentMove);
    }, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: 30, y: 40 });

    expect(agentMove?.defaultPrevented).toBe(false);
    expect(agentMove?.__bcAgentInputPermitId).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((globalThis as unknown as { __bcAgentInputPermit: unknown }).__bcAgentInputPermit).toBeNull();
    expect(shield().style.pointerEvents).toBe('auto');
  });

  it('hiding the frame detaches every listener it added, leaving the page unblocked', async () => {
    await overlay.showLockShield(7);
    expect(document.listeners.length).toBeGreaterThan(0);

    await overlay.hideLockShield(7);

    expect(document.listeners).toEqual([]);
    expect(shield().removed).toBe(true);
  });
});
