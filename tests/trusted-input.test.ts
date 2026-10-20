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
const { fallbackByTab } = await import('../extension/lib/state.js');
const { handleClick, handleType, parseKeyCombo } = await import('../extension/handlers/interaction.js');

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

  it('Control+a and Meta+a carry the selectAll editing command (select-all in the field, on every OS)', async () => {
    const send = async (method: string, params: Record<string, unknown>) => { cdp.push({ method, params }); };
    await ti.cdpKeyPress(send, 'a', ['ctrl']);
    expect(cdp[0].params).toMatchObject({ type: 'rawKeyDown', key: 'a', modifiers: 2, commands: ['selectAll'] });
    cdp.length = 0;
    await ti.cdpKeyPress(send, 'a', ['meta']);
    expect(cdp[0].params).toMatchObject({ type: 'rawKeyDown', key: 'a', modifiers: 4, commands: ['selectAll'] });
    cdp.length = 0;
    // Other combos stay native: Control+Shift+a and a plain letter carry no editing command.
    await ti.cdpKeyPress(send, 'a', ['ctrl', 'shift']);
    expect(cdp[0].params.commands).toBeUndefined();
    cdp.length = 0;
    await ti.cdpKeyPress(send, 'a', []);
    expect(cdp[0].params.commands).toBeUndefined();
  });

  it('enables focus emulation once and reuses the session', async () => {
    await session.ensureCdp(5);
    await session.ensureCdp(5);
    expect(attachCount).toBe(1);
    expect(cdp.filter((c) => c.method === 'Emulation.setFocusEmulationEnabled')).toHaveLength(1);
  });

  it('click: real mouse events at the located centre', async () => {
    pageResults.push({ success: true, x: 100, y: 40, visible: true, focused: false });
    const res = await handleClick({ tabId: 5, target: '#go' });
    expect(res).toMatchObject({ success: true, input: 'cdp' });
    expect(inputs().map((c) => c.params.type)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
    expect(inputs()[1].params).toMatchObject({ x: 100, y: 40, button: 'left', clickCount: 1 });
  });

  it('click reports the point it clicked', async () => {
    pageResults.push({ success: true, x: 100, y: 40, visible: true });
    expect(await handleClick({ tabId: 5, target: '#go' })).toMatchObject({ at: { x: 100, y: 40 } });
  });

  it('click: count 2 sends clickCount 1 then 2', async () => {
    pageResults.push({ success: true, x: 1, y: 2, visible: true });
    await handleClick({ tabId: 5, target: '#go', count: 2 });
    expect(inputs().filter((c) => c.params.type === 'mousePressed').map((c) => c.params.clickCount)).toEqual([1, 2]);
  });

  it('click at a point: no element lookup check, real click at the point, triple click with Control', async () => {
    pageResults.push({ success: true, x: 30, y: 40, visible: true, via: 'point' });
    const res = await handleClick({ tabId: 5, target: '30,40', count: 3, modifiers: ['Control'] });
    expect(res).toMatchObject({ success: true, input: 'cdp', at: { x: 30, y: 40 } });
    const presses = inputs().filter((c) => c.params.type === 'mousePressed');
    expect(presses.map((c) => c.params.clickCount)).toEqual([1, 2, 3]);
    expect(presses[0].params).toMatchObject({ x: 30, y: 40, modifiers: 2 });
  });

  it('type with key: a combo goes through CDP as one key with its modifiers', async () => {
    pageResults.push({ success: true, x: 0, y: 0, visible: true, focused: true });
    const res = await handleType({ tabId: 5, key: 'shift+Tab' });
    expect(res).toMatchObject({ success: true, input: 'cdp' });
    expect(inputs()[0].params).toMatchObject({ key: 'Tab', modifiers: 8 });
  });

  it('the agent cursor is off by default: no cursor work, no wait, one measurement', async () => {
    pageResults.push({ success: true, x: 100, y: 40, visible: true });
    await handleClick({ tabId: 5, target: '#go' });
    expect(pageArgs[0][2]).toBeNull();
    expect(pageArgs).toHaveLength(2); // locate, then the release of the input window
  });

  it('click: the agent cursor glides first, then the target is measured again and clicked there', async () => {
    cursorOn = true;
    // The page reports a 30 ms glide; a layout shift moves the button meanwhile.
    pageResults.push({ success: true, x: 100, y: 40, visible: true, cursorMs: 30 });
    pageResults.push({ success: true, x: 100, y: 90, visible: true });
    const t0 = Date.now();
    const res = await handleClick({ tabId: 5, target: '#go', count: 2 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
    expect(res).toMatchObject({ success: true, input: 'cdp' });
    expect(pageArgs[0][2]).toEqual({ effect: 'click', count: 2 });
    expect(pageArgs[1][2]).toEqual({ effect: 'track' });
    expect(inputs().find((c) => c.params.type === 'mousePressed')?.params).toMatchObject({ x: 100, y: 90 });
  });

  it('click: a target that disappears during the glide is not clicked', async () => {
    cursorOn = true;
    pageResults.push({ success: true, x: 100, y: 40, visible: true, cursorMs: 5 });
    pageResults.push({ success: false, error: 'NOT_FOUND: #go matches nothing', url: 'https://example.test' });
    const res = await handleClick({ tabId: 5, target: '#go' });
    expect(res).toMatchObject({ success: false, error: expect.stringMatching(/^NOT_FOUND: #go/) });
    expect(inputs()).toHaveLength(0);
  });

  it('click at a point: the press waits until the agent cursor has arrived', async () => {
    cursorOn = true;
    pageResults.push({ success: true, x: 30, y: 40, visible: true, cursorMs: 30 });
    pageResults.push({ success: true, x: 30, y: 40, visible: true });
    const t0 = Date.now();
    await handleClick({ tabId: 5, target: '30,40' });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
    expect(pageArgs[0][2]).toEqual({ effect: 'click', count: 1 });
    expect(inputs().map((c) => c.params.type)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
  });

  it('without a debugger, click fails with DEBUGGER_UNAVAILABLE and sends nothing (no synthetic fallback)', async () => {
    attachError = new Error('Another debugger is attached');
    pageResults.push({ success: true, x: 100, y: 40, visible: true });
    await expect(handleClick({ tabId: 5, target: '#go' })).rejects.toThrow(/^DEBUGGER_UNAVAILABLE: could not attach the debugger to tab 5/);
    expect(inputs()).toHaveLength(0);
    expect(attachCount).toBe(1);
  });
});

describe('ref misses on the target path: one wording, decided by the page\'s `issued`', () => {
  beforeEach(async () => {
    cdp.length = 0;
    pageResults.length = 0;
    attachError = null;
    fallbackByTab.clear();
    await session.detachCdp(5);
  });

  it('issued true: the ref was issued in this document and its element is gone: REF_GONE', async () => {
    pageResults.push({ success: false, error: 'REF_GONE', ref: 'e12', issued: true, url: 'https://example.test' });
    expect(await handleClick({ tabId: 5, target: 'e12' })).toMatchObject({ success: false, error: expect.stringMatching(/^REF_GONE: ref e12 /) });
    expect(inputs()).toHaveLength(0);
  });

  it('issued false: the ref was never issued in this document: REF_NOT_FOUND, even with a known name', async () => {
    fallbackByTab.set(5, new Map([['e12', { text: 'Save', role: 'button' }]]));
    pageResults.push({ success: false, error: 'REF_GONE', ref: 'e12', issued: false, url: 'https://example.test' });
    expect(await handleClick({ tabId: 5, target: 'e12' })).toMatchObject({ success: false, error: expect.stringMatching(/^REF_NOT_FOUND: ref e12 /) });
  });

  it('issued absent: the extension record decides: a known ref is REF_GONE', async () => {
    fallbackByTab.set(5, new Map([['e12', { text: 'Save', role: 'button' }]]));
    pageResults.push({ success: false, error: 'REF_GONE', ref: 'e12', url: 'https://example.test' });
    expect(await handleClick({ tabId: 5, target: 'e12' })).toMatchObject({ success: false, error: expect.stringMatching(/^REF_GONE: ref e12 /) });
  });

  it('issued absent and no record: REF_NOT_FOUND', async () => {
    pageResults.push({ success: false, error: 'REF_GONE', ref: 'e12', url: 'https://example.test' });
    expect(await handleClick({ tabId: 5, target: 'e12' })).toMatchObject({ success: false, error: expect.stringMatching(/^REF_NOT_FOUND: ref e12 /) });
  });
});
