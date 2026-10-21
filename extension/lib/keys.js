/**
 * Keys as CDP sends them (Input.dispatchKeyEvent): key names to key definitions,
 * modifier bits, and one full key press. Used by the trusted input of browser_type
 * and browser_fill (lib/trusted-input.js re-exports it).
 */

const MOD_BITS = { alt: 1, ctrl: 2, meta: 4, shift: 8 };

export function modifierBits(mods = []) {
  return mods.reduce((bits, m) => bits | (MOD_BITS[m] || 0), 0);
}

const NAMED_KEYS = {
  Enter: { code: 'Enter', vk: 13, text: '\r' },
  Tab: { code: 'Tab', vk: 9 },
  Escape: { code: 'Escape', vk: 27 },
  Backspace: { code: 'Backspace', vk: 8 },
  Delete: { code: 'Delete', vk: 46 },
  Insert: { code: 'Insert', vk: 45 },
  ArrowUp: { code: 'ArrowUp', vk: 38 },
  ArrowDown: { code: 'ArrowDown', vk: 40 },
  ArrowLeft: { code: 'ArrowLeft', vk: 37 },
  ArrowRight: { code: 'ArrowRight', vk: 39 },
  Home: { code: 'Home', vk: 36 },
  End: { code: 'End', vk: 35 },
  PageUp: { code: 'PageUp', vk: 33 },
  PageDown: { code: 'PageDown', vk: 34 },
  ' ': { code: 'Space', vk: 32, text: ' ' },
  Space: { code: 'Space', vk: 32, text: ' ', key: ' ' },
  Shift: { code: 'ShiftLeft', vk: 16 },
  Control: { code: 'ControlLeft', vk: 17 },
  Alt: { code: 'AltLeft', vk: 18 },
  Meta: { code: 'MetaLeft', vk: 91 },
  CapsLock: { code: 'CapsLock', vk: 20 },
  NumLock: { code: 'NumLock', vk: 144 },
  ScrollLock: { code: 'ScrollLock', vk: 145 },
  PrintScreen: { code: 'PrintScreen', vk: 44 },
  Pause: { code: 'Pause', vk: 19 },
  ContextMenu: { code: 'ContextMenu', vk: 93 },
};
for (let i = 1; i <= 12; i++) NAMED_KEYS[`F${i}`] = { code: `F${i}`, vk: 111 + i };
// US-layout code + Windows virtual key code for printable punctuation.
const PUNCTUATION = {
  '.': ['Period', 190], '>': ['Period', 190], ',': ['Comma', 188], '<': ['Comma', 188],
  '-': ['Minus', 189], '_': ['Minus', 189], '=': ['Equal', 187], '+': ['Equal', 187],
  '/': ['Slash', 191], '?': ['Slash', 191], ';': ['Semicolon', 186], ':': ['Semicolon', 186],
  "'": ['Quote', 222], '"': ['Quote', 222], '[': ['BracketLeft', 219], '{': ['BracketLeft', 219],
  ']': ['BracketRight', 221], '}': ['BracketRight', 221], '\\': ['Backslash', 220], '|': ['Backslash', 220],
  '`': ['Backquote', 192], '~': ['Backquote', 192],
  '!': ['Digit1', 49], '@': ['Digit2', 50], '#': ['Digit3', 51], '$': ['Digit4', 52], '%': ['Digit5', 53],
  '^': ['Digit6', 54], '&': ['Digit7', 55], '*': ['Digit8', 56], '(': ['Digit9', 57], ')': ['Digit0', 48],
};
const KEY_ALIASES = { Esc: 'Escape', Return: 'Enter', Del: 'Delete', Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight' };

/** CDP key definition for a key name ("Enter", "a", "7", "ب"). */
export function keyDefinition(rawKey) {
  const name = KEY_ALIASES[rawKey] || rawKey;
  const named = NAMED_KEYS[name];
  if (named) return { key: named.key || name, code: named.code, vk: named.vk, text: named.text };
  if ([...name].length !== 1) throw new Error(`Unknown key "${rawKey}"`);
  const ch = name;
  const upper = ch.toUpperCase();
  if (/^[a-z]$/i.test(ch)) return { key: ch, code: `Key${upper}`, vk: upper.charCodeAt(0), text: ch };
  if (/^[0-9]$/.test(ch)) return { key: ch, code: `Digit${ch}`, vk: ch.charCodeAt(0), text: ch };
  // Numeric/mask plugins filter on keyCode: a "." with keyCode 0 is dropped.
  const punct = PUNCTUATION[ch];
  if (punct) return { key: ch, code: punct[0], vk: punct[1], text: ch };
  return { key: ch, code: '', vk: 0, text: ch };
}

/**
 * Control+a / Meta+a (no alt, no shift): select all in the focused field. macOS Chrome
 * binds Control+a to "line start" and reads select-all from the key event's `commands`
 * (the editing command Chrome itself sends for Cmd+A), so the command goes out with the
 * key on every OS.
 */
function selectAllCombo(key, modifiers) {
  const ctrlOrMeta = modifiers & (MOD_BITS.ctrl | MOD_BITS.meta);
  return /^a$/i.test(key) && ctrlOrMeta !== 0 && !(modifiers & (MOD_BITS.alt | MOD_BITS.shift));
}

/** The key each modifier name presses, in the order a person holds them down. */
const MODIFIER_KEYS = [['ctrl', 'Control'], ['alt', 'Alt'], ['meta', 'Meta'], ['shift', 'Shift']];

/**
 * One full key press (keyDown[+char] / keyUp). The modifiers are held as a person holds
 * them: each one's own keydown first, its keyup last, with the flags of the keys down at
 * that moment. With ctrl/alt/meta no text is produced; Shift with a letter types it in capitals.
 */
export async function cdpKeyPress(send, rawKey, mods = []) {
  const def = keyDefinition(rawKey);
  const modifiers = modifierBits(mods);
  // "Control+Shift" presses Shift with Control held: Shift is the key, not a modifier held around it.
  const held = MODIFIER_KEYS.filter(([name, keyName]) => (modifiers & MOD_BITS[name]) !== 0 && def.key !== keyName);
  let down = 0;
  for (const [name, keyName] of held) {
    const m = keyDefinition(keyName);
    down |= MOD_BITS[name];
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: m.key, code: m.code, windowsVirtualKeyCode: m.vk, nativeVirtualKeyCode: m.vk, modifiers: down });
  }
  const printable = def.text && !(modifiers & (MOD_BITS.ctrl | MOD_BITS.alt | MOD_BITS.meta));
  const shifted = (modifiers & MOD_BITS.shift) !== 0 && /^[a-z]$/i.test(def.key);
  const key = shifted ? def.key.toUpperCase() : def.key;
  const text = shifted ? def.text.toUpperCase() : def.text;
  const base = { key, code: def.code, windowsVirtualKeyCode: def.vk, nativeVirtualKeyCode: def.vk, modifiers };
  await send('Input.dispatchKeyEvent', {
    type: printable ? 'keyDown' : 'rawKeyDown',
    ...base,
    ...(printable ? { text, unmodifiedText: text } : {}),
    ...(selectAllCombo(def.key, modifiers) ? { commands: ['selectAll'] } : {}),
  });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  for (const [name, keyName] of [...held].reverse()) {
    const m = keyDefinition(keyName);
    down &= ~MOD_BITS[name];
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: m.key, code: m.code, windowsVirtualKeyCode: m.vk, nativeVirtualKeyCode: m.vk, modifiers: down });
  }
}
