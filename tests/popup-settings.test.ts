import { beforeEach, describe, expect, it, vi } from 'vitest';

const localStore = vi.hoisted(() => ({ values: {} as Record<string, unknown>, writes: [] as Array<Record<string, unknown>> }));

(globalThis as unknown as { chrome: unknown }).chrome = {
  storage: {
    local: {
      get: (key: string, callback: (stored: Record<string, unknown>) => void) => callback({ [key]: localStore.values[key] }),
      set: (value: Record<string, unknown>) => { localStore.writes.push(value); },
    },
  },
};

const { bindBooleanSetting } = await import('../extension/popup/settings-input.js');
const { AGENT_MOUSE_MOVEMENT_LOCK_KEY } = await import('../extension/lib/overlay.js');

function settingInput() {
  const handlers = new Map<string, () => void>();
  return {
    element: {
      checked: false,
      addEventListener: (type: string, handler: () => void) => handlers.set(type, handler),
    },
    change: () => handlers.get('change')?.(),
  };
}

describe('popup boolean settings', () => {
  beforeEach(() => {
    localStore.values = {};
    localStore.writes.length = 0;
  });

  it('loads a persisted true value and stores the next switch state', () => {
    localStore.values[AGENT_MOUSE_MOVEMENT_LOCK_KEY] = true;
    const input = settingInput();
    const onChange = vi.fn();
    bindBooleanSetting(input.element, AGENT_MOUSE_MOVEMENT_LOCK_KEY, onChange);

    expect(input.element.checked).toBe(true);
    input.element.checked = false;
    input.change();

    expect(localStore.writes).toEqual([{ [AGENT_MOUSE_MOVEMENT_LOCK_KEY]: false }]);
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('defaults missing settings to off', () => {
    const input = settingInput();
    bindBooleanSetting(input.element, AGENT_MOUSE_MOVEMENT_LOCK_KEY);
    expect(input.element.checked).toBe(false);
  });
});
