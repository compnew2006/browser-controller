import { describe, it, expect, beforeEach } from 'vitest';

// Minimal chrome mock: executeScript answers with the next queued page result,
// debugger records every CDP command.
const cdp: Array<{ method: string; params: Record<string, unknown> }> = [];
const pageResults: unknown[] = [];
let attachError: Error | null = null;
let attachCount = 0;

(globalThis as unknown as { chrome: unknown }).chrome = {
  tabs: {
    get: async (id: number) => ({ id, url: 'https://example.test', windowId: 1 }),
    onRemoved: { addListener: () => {} },
  },
  scripting: {
    executeScript: async () => [{ result: pageResults.length ? pageResults.shift() : {} }],
  },
  storage: {
    session: { get: async () => ({}), set: async () => {} },
    local: { get: async () => ({}), set: async () => {} },
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
const { handleClick, handleType, handlePressKey, parseKeyCombo } = await import('../extension/handlers/interaction.js');

const inputs = () => cdp.filter((c) => c.method.startsWith('Input.'));

describe('trusted input (CDP)', () => {
  beforeEach(async () => {
    cdp.length = 0;
    pageResults.length = 0;
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
