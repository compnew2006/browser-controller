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
      // The file input browser_fill marked in the page, found from the main world.
      if (method === 'Runtime.evaluate' && String(params.expression).includes('data-bc-upload')) return { result: { objectId: 'obj-1' } };
      return {};
    },
    onDetach: { addListener: () => {} },
  },
};

const ti = await import('../extension/lib/trusted-input.js');
const session = await import('../extension/lib/cdp-session.js');
const { handleClick, handleType, parseKeyCombo } = await import('../extension/handlers/interaction.js');
const { handleFill } = await import('../extension/handlers/fill.js');

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
    expect(res).toEqual({ success: true });
    expect(inputs().map((c) => c.params.type)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
    expect(inputs()[1].params).toMatchObject({ x: 100, y: 40, button: 'left', clickCount: 1 });
  });

  it('click by text: finds the control in the page, then a real click on it', async () => {
    pageResults.push({ success: true, clicked: 'button "Go"' });
    pageResults.push({ success: true, x: 12, y: 34, visible: true });
    const res = await handleClick({ tabId: 5, text: 'go' });
    expect(res).toEqual({ success: true, clicked: 'button "Go"' });
    expect(pageArgs[1][0]).toBe(pageArgs[0][1]); // the click targets the ref the text search parked
    expect(inputs()[1].params).toMatchObject({ type: 'mousePressed', x: 12, y: 34 });
  });

  it('click by text says when several elements match equally', async () => {
    pageResults.push({ success: true, clicked: 'button "Edit"', matches: 3 });
    pageResults.push({ success: true, x: 1, y: 2, visible: true });
    expect(await handleClick({ tabId: 5, text: 'edit' })).toMatchObject({ success: true, matches: 3, hint: expect.stringMatching(/clicked the first/) });
  });

  it('click: double click sends clickCount 1 then 2', async () => {
    pageResults.push({ success: true, x: 1, y: 2, visible: true });
    await handleClick({ tabId: 5, selector: '#go', clickCount: 2 });
    expect(inputs().filter((c) => c.params.type === 'mousePressed').map((c) => c.params.clickCount)).toEqual([1, 2]);
  });

  it('click at x/y: no element lookup, real click at the point, triple click', async () => {
    pageResults.push({ inView: true, hit: { role: 'button', name: 'Go', tag: 'button' } });
    const res = await handleClick({ tabId: 5, x: 30, y: 40, clickCount: 3, modifiers: ['ctrl'] });
    expect(res).toEqual({ success: true, hit: { role: 'button', name: 'Go', tag: 'button' } });
    const presses = inputs().filter((c) => c.params.type === 'mousePressed');
    expect(presses.map((c) => c.params.clickCount)).toEqual([1, 2, 3]);
    expect(presses[0].params).toMatchObject({ x: 30, y: 40, modifiers: 2 });
  });

  it('a disabled, hidden or covered target is not clicked; hover may rest on a disabled one', async () => {
    pageResults.push({ success: true, x: 1, y: 2, visible: true, disabled: true });
    expect(await handleClick({ tabId: 5, selector: '#go' })).toMatchObject({ success: false, error: expect.stringMatching(/^DISABLED/) });
    pageResults.push({ success: true, x: 1, y: 2, visible: true, occludedBy: 'div.modal' });
    expect(await handleClick({ tabId: 5, selector: '#go' })).toMatchObject({ success: false, error: expect.stringMatching(/^COVERED: div.modal/) });
    expect(inputs()).toHaveLength(0);
    pageResults.push({ success: true, x: 5, y: 6, visible: true, disabled: true });
    expect(await handleClick({ tabId: 5, selector: '#go', hover: true })).toEqual({ success: true });
    expect(inputs().map((c) => c.params.type)).toEqual(['mouseMoved']);
  });

  it('dragTo: presses on the element, moves in steps, releases on the drop target measured where it is', async () => {
    pageResults.push({ success: true, x: 10, y: 10, visible: true });
    pageResults.push({ success: true, x: 110, y: 10, visible: true, inView: true });
    const res = await handleClick({ tabId: 5, ref: 's1-2', dragTo: { ref: 's1-5' } });
    expect(res).toEqual({ success: true });
    expect(pageArgs[1].slice(0, 4)).toEqual(['s1-5', null, null, 'measure']); // the drop target is not scrolled
    const types = inputs().map((c) => c.params.type);
    expect(types[0]).toBe('mouseMoved');
    expect(types[1]).toBe('mousePressed');
    expect(types.filter((t) => t === 'mouseMoved')).toHaveLength(11);
    expect(inputs().at(-1)?.params).toMatchObject({ type: 'mouseReleased', x: 110, y: 10 });
  });

  it('dragTo: a drop target out of view fails before the mouse is pressed', async () => {
    pageResults.push({ success: true, x: 10, y: 10, visible: true });
    pageResults.push({ success: true, x: 110, y: 2000, visible: true, inView: false });
    const res = await handleClick({ tabId: 5, selector: '#a', dragTo: { selector: '#b' } });
    expect(res).toMatchObject({ success: false, error: expect.stringMatching(/not in view/) });
    expect(inputs().filter((c) => c.params.type === 'mousePressed')).toHaveLength(0);
  });

  it('type key: space-separated sequences go to the focused element or the page', async () => {
    pageResults.push({ success: true, x: 1, y: 2, visible: true, focused: true, via: 'active' });
    pageResults.push({ value: 'x', focusedTag: 'input#q' });
    const res = await handleType({ tabId: 5, key: 'ArrowDown ArrowDown Enter' });
    expect(res).toEqual({ success: true, focused: 'input#q' });
    expect(pageArgs[0][3]).toBe('active');
    expect(inputs().filter((c) => c.params.type !== 'keyUp').map((c) => c.params.key)).toEqual(['ArrowDown', 'ArrowDown', 'Enter']);
  });

  it('type text then key: the text is typed into the field, then the key is pressed', async () => {
    pageResults.push({ success: true, x: 1, y: 2, visible: true, focused: true });
    pageResults.push({ value: '', focusedTag: 'input#next' });
    const res = await handleType({ tabId: 5, selector: '#q', text: 'hi', key: 'Tab' });
    expect(res).toEqual({ success: true, focused: 'input#next' });
    expect(inputs().filter((c) => c.params.type !== 'keyUp').map((c) => c.params.key)).toEqual(['h', 'i', 'Tab']);
  });

  it('type: an unknown key fails before anything is pressed', async () => {
    await expect(handleType({ tabId: 5, text: 'hello', key: 'Enter Submit' })).rejects.toThrow(/Unknown key "Submit"/);
    expect(attachCount).toBe(0);
    expect(inputs()).toHaveLength(0);
  });

  it('type without ref/selector types into the focused field, and refuses the page body', async () => {
    pageResults.push({ success: true, x: 1, y: 2, visible: true, focused: true, via: 'active' });
    pageResults.push({ value: 'hi' });
    expect(await handleType({ tabId: 5, text: 'hi' })).toEqual({ success: true, value: 'hi' });
    pageResults.push({ success: false, error: 'NO_FOCUS' });
    expect(await handleType({ tabId: 5, text: 'hi' })).toMatchObject({ success: false, error: expect.stringMatching(/No field has focus/) });
  });

  it('type: key per character, select-all when clearing an unselectable value', async () => {
    pageResults.push({ success: true, x: 1, y: 2, visible: true, focused: true, needsSelectAll: true, hasText: true });
    pageResults.push({ value: 'ab' });
    const res = await handleType({ tabId: 5, selector: '#f', text: 'ab', clear: true });
    expect(res).toEqual({ success: true, value: 'ab' });
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

  it('type key: a combo goes through CDP with its modifiers', async () => {
    pageResults.push({ success: true, x: 0, y: 0, visible: true });
    await handleType({ tabId: 5, key: 'shift+Tab' });
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
    pageResults.push({ inView: true });
    await handleClick({ tabId: 5, x: 10, y: 10, dragTo: { x: 110, y: 10 } });
    expect(pageArgs).toHaveLength(2); // pointInfo + releaseShield only
    expect(inputs().filter((c) => c.params.type === 'mouseMoved')).toHaveLength(11);
  });

  it('click: the agent cursor glides first, then the target is measured again and clicked there', async () => {
    cursorOn = true;
    // The page reports a 30 ms glide; a layout shift moves the button meanwhile.
    pageResults.push({ success: true, x: 100, y: 40, visible: true, cursorMs: 30 });
    pageResults.push({ success: true, x: 100, y: 90, visible: true });
    const t0 = Date.now();
    const res = await handleClick({ tabId: 5, selector: '#go', clickCount: 2 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
    expect(res).toEqual({ success: true });
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
    pageResults.push({ inView: true }); // pointInfo at the start ('down')
    pageResults.push({ ms: 40 }); // cursor glide to the end ('up')
    const t0 = Date.now();
    const res = await handleClick({ tabId: 5, x: 10, y: 10, dragTo: { x: 110, y: 10 } });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(35);
    expect(res).toEqual({ success: true });
    expect(pageArgs[0]).toEqual([10, 10, 'down', 1]);
    expect(pageArgs[1]).toEqual([110, 10, 'up', 1]);
  });

  it('fill: a text field gets its value in one insertion after its old value is selected', async () => {
    pageResults.push({ kind: 'text' });
    pageResults.push({ success: true, x: 1, y: 2, visible: true, focused: true, needsSelectAll: false, hasText: true });
    const res = await handleFill({ tabId: 5, fields: [{ selector: '#name', value: 'Ada' }] });
    expect(res).toEqual({ success: true, filled: 1 });
    expect(pageArgs[1][3]).toBe('clear');
    expect(inputs()).toEqual([{ method: 'Input.insertText', params: { text: 'Ada' } }]);
  });

  it('fill: an empty value deletes the selected old one', async () => {
    pageResults.push({ kind: 'text' });
    pageResults.push({ success: true, x: 1, y: 2, visible: true, focused: true, hasText: true });
    await handleFill({ tabId: 5, fields: [{ ref: 's1-3', value: '' }] });
    expect(inputs().map((c) => c.params.key)).toEqual(['Delete', 'Delete']);
  });

  it('fill: select/checkbox are set in the page; files go through DOM.setFileInputFiles; only failures are listed', async () => {
    pageResults.push({ done: true }); // <select>
    pageResults.push({ kind: 'file' });
    pageResults.push(null); // unmark
    pageResults.push({ error: 'no option "Mars"; options: Earth | Venus' });
    const res = await handleFill({ tabId: 5, fields: [
      { selector: '#country', value: 'Egypt' },
      { selector: '#cv', value: ['/tmp/a.pdf', '/tmp/b.pdf'] },
      { selector: '#planet', value: 'Mars' },
    ] });
    expect(res).toEqual({ success: false, error: '1 of 3 fields failed', failed: [{ field: '#planet', error: 'no option "Mars"; options: Earth | Venus' }] });
    expect(cdp.find((c) => c.method === 'DOM.setFileInputFiles')?.params).toEqual({ files: ['/tmp/a.pdf', '/tmp/b.pdf'], objectId: 'obj-1' });
    expect(inputs()).toHaveLength(0);
  });

  it('no debugger, no input: CDP_UNAVAILABLE says why instead of a weaker fallback', async () => {
    attachError = new Error('Cannot attach to this target.');
    await expect(handleClick({ tabId: 5, selector: '#go' })).rejects.toThrow(/^CDP_UNAVAILABLE: .*Cannot attach/);
    await expect(handleType({ tabId: 5, selector: '#q', text: 'x' })).rejects.toThrow(/CDP_UNAVAILABLE/);
    await expect(handleFill({ tabId: 5, fields: [{ selector: '#q', value: 'x' }] })).rejects.toThrow(/CDP_UNAVAILABLE/);
    expect(pageArgs).toHaveLength(0);
  });
});
