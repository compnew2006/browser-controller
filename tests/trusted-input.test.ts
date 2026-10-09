import { describe, it, expect, beforeEach } from 'vitest';

// Minimal chrome mock: executeScript answers with the next queued page result,
// debugger records every CDP command.
const cdp: Array<{ method: string; params: Record<string, unknown> }> = [];
const pageResults: unknown[] = [];
/** Arguments of every page function call, in order. */
const pageArgs: unknown[][] = [];
/** The popup's "Show agent cursor" switch (chrome.storage.local agentCursor). */
let cursorOn = false;
let attachError: Error | null = null;
let attachCount = 0;

(globalThis as unknown as { chrome: unknown }).chrome = {
  tabs: {
    get: async (id: number) => ({ id, url: 'https://example.test', windowId: 1 }),
    onRemoved: { addListener: () => {} },
  },
  scripting: {
    executeScript: async (opts: { args?: unknown[] }) => {
      pageArgs.push(opts.args ?? []);
      return [{ result: pageResults.length ? pageResults.shift() : {} }];
    },
  },
  storage: {
    session: { get: async () => ({}), set: async () => {} },
    local: { get: async () => ({ agentCursor: cursorOn }), set: async () => {} },
  },
  debugger: {
    attach: async () => { attachCount++; if (attachError) throw attachError; },
    detach: async () => {},
    sendCommand: async (_t: unknown, method: string, params: Record<string, unknown> = {}) => {
      cdp.push({ method, params });
      return {};
    },
    onDetach: { addListener: () => {} },
  },
};

const ti = await import('../extension/lib/trusted-input.js');
const session = await import('../extension/lib/cdp-session.js');
const { handleClick, handleClickByText, handleType, handlePressKey, handleDrag, parseKeyCombo } = await import('../extension/handlers/interaction.js');

const inputs = () => cdp.filter((c) => c.method.startsWith('Input.'));

describe('trusted input (CDP)', () => {
  beforeEach(async () => {
    cdp.length = 0;
    pageResults.length = 0;
    pageArgs.length = 0;
    cursorOn = false;
    attachError = null;
    attachCount = 0;
    await session.detachCdp(5);
  });

  it('maps key names to CDP key definitions', () => {
    expect(ti.keyDefinition('Enter')).toMatchObject({ key: 'Enter', vk: 13, text: '\r' });
    expect(ti.keyDefinition('Esc')).toMatchObject({ key: 'Escape', vk: 27 });
    expect(ti.keyDefinition('a')).toMatchObject({ code: 'KeyA', vk: 65, text: 'a' });
    expect(ti.keyDefinition('7')).toMatchObject({ code: 'Digit7', vk: 55 });
    expect(ti.keyDefinition('ب')).toMatchObject({ key: 'ب', text: 'ب' });
    expect(ti.keyDefinition('F5')).toMatchObject({ vk: 116 });
    expect(ti.keyDefinition('.')).toMatchObject({ code: 'Period', vk: 190, text: '.' });
    expect(ti.keyDefinition('-')).toMatchObject({ code: 'Minus', vk: 189 });
    expect(() => ti.keyDefinition('NoSuchKey')).toThrow(/Unknown key/);
  });

  it('parses "ctrl+a" style combos', () => {
    expect(parseKeyCombo('ctrl+a')).toEqual({ key: 'a', mods: ['ctrl'] });
    expect(parseKeyCombo('Control+Shift+Tab')).toEqual({ key: 'Tab', mods: ['ctrl', 'shift'] });
    expect(parseKeyCombo('Enter', ['alt'])).toEqual({ key: 'Enter', mods: ['alt'] });
    expect(parseKeyCombo('+')).toEqual({ key: '+', mods: [] });
  });

  it('a modified key press produces no text (shortcut, not typing)', async () => {
    const send = async (method: string, params: Record<string, unknown>) => { cdp.push({ method, params }); };
    await ti.cdpKeyPress(send, 'a', ['ctrl']);
    expect(cdp[0]).toMatchObject({ params: { type: 'rawKeyDown', modifiers: 2 } });
    expect(cdp[0].params.text).toBeUndefined();
  });

  it('enables focus emulation once and reuses the session', async () => {
    await session.ensureCdp(5);
    await session.ensureCdp(5);
    expect(attachCount).toBe(1);
    expect(cdp.filter((c) => c.method === 'Emulation.setFocusEmulationEnabled')).toHaveLength(1);
  });

  it('click: real mouse events at the located centre', async () => {
    pageResults.push({ success: true, x: 100, y: 40, visible: true, focused: false });
    const res = await handleClick({ tabId: 5, selector: '#go' });
    expect(res).toMatchObject({ success: true, input: 'cdp' });
    expect(inputs().map((c) => c.params.type)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
    expect(inputs()[1].params).toMatchObject({ x: 100, y: 40, button: 'left', clickCount: 1 });
  });

  it('click by ref/selector reports the point it clicked (browser_gif rings it)', async () => {
    pageResults.push({ success: true, x: 100, y: 40, visible: true });
    expect(await handleClick({ tabId: 5, selector: '#go' })).toMatchObject({ at: { x: 100, y: 40 } });
  });

  it('click_text reports the point it clicked (browser_gif rings it)', async () => {
    pageResults.push({ success: true, clicked: 'Go', role: 'button', matchCount: 1 });
    pageResults.push({ success: true, x: 12, y: 34, visible: true });
    const res = await handleClickByText({ tabId: 5, text: 'go' });
    expect(res).toMatchObject({ success: true, input: 'cdp', at: { x: 12, y: 34 } });
    expect(inputs()[1].params).toMatchObject({ type: 'mousePressed', x: 12, y: 34 });
  });

  it('click: double click sends clickCount 1 then 2', async () => {
    pageResults.push({ success: true, x: 1, y: 2, visible: true });
    await handleClick({ tabId: 5, selector: '#go', doubleClick: true });
    expect(inputs().filter((c) => c.params.type === 'mousePressed').map((c) => c.params.clickCount)).toEqual([1, 2]);
  });

  it('click at x/y: no element lookup, real click at the point, triple click', async () => {
    pageResults.push({ inView: true, hit: { role: 'button', name: 'Go', tag: 'button' } });
    const res = await handleClick({ tabId: 5, x: 30, y: 40, clickCount: 3, modifiers: ['ctrl'] });
    expect(res).toMatchObject({ success: true, input: 'cdp', at: { x: 30, y: 40 }, hit: { name: 'Go' } });
    const presses = inputs().filter((c) => c.params.type === 'mousePressed');
    expect(presses.map((c) => c.params.clickCount)).toEqual([1, 2, 3]);
    expect(presses[0].params).toMatchObject({ x: 30, y: 40, modifiers: 2 });
  });

  it('press_key: space-separated sequences and repeat', async () => {
    pageResults.push({ success: true, x: 1, y: 2, visible: true, focused: true });
    await handlePressKey({ tabId: 5, key: 'ArrowDown ArrowDown Enter' });
    expect(inputs().filter((c) => c.params.type !== 'keyUp').map((c) => c.params.key)).toEqual(['ArrowDown', 'ArrowDown', 'Enter']);
    cdp.length = 0;
    pageResults.push({ success: true, x: 1, y: 2, visible: true, focused: true });
    const res = await handlePressKey({ tabId: 5, key: 'ctrl+a Backspace', repeat: 2 });
    expect(res).toMatchObject({ success: true, repeat: 2 });
    const downs = inputs().filter((c) => c.params.type !== 'keyUp');
    expect(downs.map((c) => [c.params.key, c.params.modifiers])).toEqual([['a', 2], ['Backspace', 0], ['a', 2], ['Backspace', 0]]);
  });

  it('type without ref/selector types into the focused field, and refuses the page body', async () => {
    pageResults.push({ success: true, x: 1, y: 2, visible: true, focused: true, via: 'active' });
    pageResults.push({ value: 'hi' });
    expect(await handleType({ tabId: 5, text: 'hi' })).toMatchObject({ success: true, value: 'hi', via: 'active' });
    pageResults.push({ success: false, error: 'NO_FOCUS' });
    expect(await handleType({ tabId: 5, text: 'hi' })).toMatchObject({ success: false, error: expect.stringMatching(/No field has focus/) });
  });

  it('type: key per character, select-all when clearing an unselectable value', async () => {
    pageResults.push({ success: true, x: 1, y: 2, visible: true, focused: true, needsSelectAll: true, hasText: true });
    pageResults.push({ value: 'ab' });
    const res = await handleType({ tabId: 5, selector: '#f', text: 'ab', clear: true });
    expect(res).toMatchObject({ success: true, input: 'cdp', value: 'ab' });
    const downs = inputs().filter((c) => c.params.type !== 'keyUp');
    expect(downs.map((c) => c.params.key)).toEqual(['a', 'a', 'b']);
    expect(downs[0].params.modifiers).toBe(2); // Ctrl+A
    expect(downs[1].params.text).toBe('a');
  });

  it('type: clearing to empty presses Backspace', async () => {
    pageResults.push({ success: true, x: 1, y: 2, visible: true, focused: true, needsSelectAll: false, hasText: true });
    await handleType({ tabId: 5, selector: '#f', text: '', clear: true });
    expect(inputs().map((c) => c.params.key)).toEqual(['Backspace', 'Backspace']);
  });

  it('press_key: combo goes through CDP', async () => {
    pageResults.push({ success: true, x: 0, y: 0, visible: true });
    const res = await handlePressKey({ tabId: 5, key: 'shift+Tab' });
    expect(res).toMatchObject({ success: true, key: 'Tab', modifiers: ['shift'], input: 'cdp' });
    expect(inputs()[0].params).toMatchObject({ key: 'Tab', modifiers: 8 });
  });

  it('the agent cursor is off by default: no cursor work, no wait, one measurement', async () => {
    pageResults.push({ success: true, x: 100, y: 40, visible: true });
    await handleClick({ tabId: 5, selector: '#go' });
    expect(pageArgs[0][4]).toBeNull();
    pageResults.push({ inView: true });
    await handleClick({ tabId: 5, x: 30, y: 40 });
    expect(pageArgs.at(-2)).toEqual([30, 40, null, 1]); // pointInfo: no cursor effect
    cdp.length = 0;
    pageArgs.length = 0;
    await handleDrag({ tabId: 5, startX: 10, startY: 10, endX: 110, endY: 10, steps: 2 });
    expect(pageArgs).toHaveLength(2); // openShield + releaseShield only
    expect(inputs().map((c) => c.params.type)).toEqual(['mousePressed', 'mouseMoved', 'mouseMoved', 'mouseReleased']);
  });

  it('click: the agent cursor glides first, then the target is measured again and clicked there', async () => {
    cursorOn = true;
    // The page reports a 30 ms glide; a layout shift moves the button meanwhile.
    pageResults.push({ success: true, x: 100, y: 40, visible: true, cursorMs: 30 });
    pageResults.push({ success: true, x: 100, y: 90, visible: true });
    const t0 = Date.now();
    const res = await handleClick({ tabId: 5, selector: '#go', clickCount: 2 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
    expect(res).toMatchObject({ success: true, input: 'cdp' });
    expect(pageArgs[0][4]).toEqual({ effect: 'click', count: 2 });
    expect(pageArgs[1][4]).toEqual({ effect: 'track' });
    expect(inputs().find((c) => c.params.type === 'mousePressed')?.params).toMatchObject({ x: 100, y: 90 });
  });

  it('click: a target that disappears during the glide is not clicked', async () => {
    cursorOn = true;
    pageResults.push({ success: true, x: 100, y: 40, visible: true, cursorMs: 5 });
    pageResults.push({ success: false, error: 'REF_GONE', url: 'https://example.test' });
    const res = await handleClick({ tabId: 5, selector: '#go' });
    expect(res).toMatchObject({ success: false, error: expect.stringMatching(/No element matches selector #go/) });
    expect(inputs()).toHaveLength(0);
  });

  it('click at x/y: the press waits until the agent cursor has arrived', async () => {
    cursorOn = true;
    pageResults.push({ inView: true, cursorMs: 30 });
    const t0 = Date.now();
    await handleClick({ tabId: 5, x: 30, y: 40 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
    expect(pageArgs[0]).toEqual([30, 40, 'click', 1]);
    expect(inputs().map((c) => c.params.type)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
  });

  it('drag: the cursor presses at the start and the moves follow its glide to the end', async () => {
    cursorOn = true;
    pageResults.push({}); // openShield
    pageResults.push({ ms: 0 }); // cursor to the start ('down')
    pageResults.push({ ms: 40 }); // cursor glide to the end ('up')
    const t0 = Date.now();
    const res = await handleDrag({ tabId: 5, startX: 10, startY: 10, endX: 110, endY: 10, steps: 4 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(35);
    expect(res).toMatchObject({ success: true, from: { x: 10, y: 10 }, to: { x: 110, y: 10 } });
    expect(pageArgs[1]).toEqual([10, 10, 'down', 1]);
    expect(pageArgs[2]).toEqual([110, 10, 'up', 1]);
    expect(inputs().map((c) => c.params.type)).toEqual(['mousePressed', 'mouseMoved', 'mouseMoved', 'mouseMoved', 'mouseMoved', 'mouseReleased']);
  });

  it('falls back to synthetic events when the debugger cannot attach', async () => {
    attachError = new Error('Another debugger is attached');
    pageResults.push({ success: true });
    const res = await handleClick({ tabId: 5, selector: '#go' });
    expect(res).toEqual({ success: true });
    expect(inputs()).toHaveLength(0);
  });

  it('trusted:false forces the synthetic path', async () => {
    pageResults.push({ success: true });
    await handleClick({ tabId: 5, selector: '#go', trusted: false });
    expect(attachCount).toBe(0);
  });
});
