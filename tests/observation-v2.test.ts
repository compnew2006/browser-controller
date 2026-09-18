import { describe, expect, it } from 'vitest';
import {
  actionError,
  inferAllowedActions,
  isAcceptableComposedHit,
  validateActionArguments,
  validateElementGeometry,
  validateFreshness,
} from '../extension/lib/observation-v2.js';

describe('Observation Engine V2 semantics', () => {
  it.each([
    [{ role: 'button', tagName: 'button' }, ['click', 'focus', 'hover']],
    [{ role: 'textbox', tagName: 'input', inputType: 'text' }, ['focus', 'type', 'keypress', 'hover']],
    [{ role: 'checkbox', tagName: 'input', inputType: 'checkbox' }, ['click', 'focus', 'hover']],
    [{ role: 'combobox', tagName: 'select' }, ['select', 'focus', 'hover']],
    [{ role: 'link', tagName: 'a' }, ['click', 'focus', 'hover']],
    [{ role: 'textbox', tagName: 'input', inputType: 'file' }, ['upload']],
    [{ role: 'region', tagName: 'div', scrollable: true }, ['scroll']],
  ])('infers only executable actions for %o', (descriptor, expected) => {
    expect(inferAllowedActions(descriptor)).toEqual(expected);
  });

  it('does not offer mutating actions for disabled controls or type for readonly fields', () => {
    expect(inferAllowedActions({ role: 'button', tagName: 'button', disabled: true })).toEqual([]);
    expect(inferAllowedActions({ role: 'textbox', tagName: 'input', readOnly: true })).toEqual([
      'focus', 'keypress', 'hover',
    ]);
  });

  it('does not advertise native-only actions for unsupported ARIA lookalikes', () => {
    expect(inferAllowedActions({ role: 'textbox', tagName: 'div' })).toEqual([]);
    expect(inferAllowedActions({ role: 'listbox', tagName: 'div' })).toEqual([]);
  });

  it.each([
    [{ action: 'type', ref: 'e1' }, 'text'],
    [{ action: 'keypress', ref: 'e1' }, 'key'],
    [{ action: 'select', ref: 'e1' }, 'value'],
    [{ action: 'upload', ref: 'e1' }, 'filePath'],
    [{ action: 'focus' }, 'ref'],
  ])('rejects incomplete action request %o', (params, missing) => {
    expect(validateActionArguments(params)).toMatchObject({
      ok: false,
      error: 'INVALID_ACTION_ARGUMENTS',
      missing,
    });
  });

  it('permits page scroll without an element ref and rejects unknown operations', () => {
    expect(validateActionArguments({ action: 'scroll', deltaY: 300 })).toEqual({ ok: true });
    expect(validateActionArguments({ action: 'launch', ref: 'e1' })).toMatchObject({
      ok: false,
      error: 'INVALID_ACTION_ARGUMENTS',
    });
  });

  it.each([
    [{ action: 'focus', ref: 12 }, 'ref'],
    [{ action: 'type', ref: 'e1', text: 'ok', clear: 'yes' }, 'clear'],
    [{ action: 'select', ref: 'e1', index: -1 }, 'index'],
    [{ action: 'keypress', ref: 'e1', key: '', modifiers: ['super'] }, 'key'],
    [{ action: 'scroll', deltaY: Number.POSITIVE_INFINITY }, 'deltaY'],
    [{ action: 'upload', ref: 'e1', files: [] }, 'files'],
  ])('rejects malformed direct-wire action request %o', (params, invalid) => {
    expect(validateActionArguments(params)).toMatchObject({
      ok: false,
      error: 'INVALID_ACTION_ARGUMENTS',
      invalid,
    });
  });

  it('classifies hidden and invalid geometry with stable structured codes', () => {
    expect(validateElementGeometry({ connected: false })).toMatchObject({ error: 'STALE_STATE' });
    expect(validateElementGeometry({ connected: true, visible: false })).toMatchObject({ error: 'TARGET_NOT_VISIBLE' });
    expect(validateElementGeometry({ connected: true, visible: true, width: 0, height: 20 })).toMatchObject({ error: 'TARGET_NOT_VISIBLE' });
    expect(validateElementGeometry({ connected: true, visible: true, width: 10, height: 20, x: Number.NaN, y: 0 })).toMatchObject({ error: 'TARGET_NOT_VISIBLE' });
    expect(validateElementGeometry({ connected: true, visible: true, width: 10, height: 20, x: 3, y: 4 })).toEqual({ ok: true });
  });

  it('accepts descendant and open-shadow composed hits, but rejects unrelated blockers', () => {
    const host = { parentElement: null, getRootNode: () => ({ host: null }) };
    const target = { parentElement: host, getRootNode: () => ({ host: null }) };
    const child = { parentElement: target, getRootNode: () => ({ host: null }) };
    const shadowChild = { parentElement: null, getRootNode: () => ({ host: target }) };
    const blocker = { parentElement: null, getRootNode: () => ({ host: null }) };

    expect(isAcceptableComposedHit(target, child)).toBe(true);
    expect(isAcceptableComposedHit(target, shadowChild)).toBe(true);
    expect(isAcceptableComposedHit(target, blocker)).toBe(false);
  });

  it('allows relocation of the same attached node but rejects semantic replacement', () => {
    const observed = { role: 'button', name: 'Continue', tagName: 'button', stableId: 'continue' };
    expect(validateFreshness(observed, { ...observed, sameNode: true })).toEqual({ ok: true });
    expect(validateFreshness(observed, { ...observed, sameNode: false, name: 'Delete' })).toMatchObject({
      error: 'STALE_STATE',
    });
    expect(validateFreshness(observed, { ...observed, sameNode: false, stableId: null })).toMatchObject({
      error: 'STALE_STATE',
    });
    expect(validateFreshness(observed, { ...observed, sameNode: false })).toMatchObject({
      ok: true,
      recovered: true,
    });
  });

  it('builds compact, machine-readable errors without throwing', () => {
    expect(actionError('TARGET_OCCLUDED', 'Target is covered', {
      ref: 'e4',
      blockingElement: { role: 'dialog', name: 'Cookie preferences' },
    })).toEqual({
      success: false,
      ok: false,
      error: 'TARGET_OCCLUDED',
      message: 'Target is covered',
      ref: 'e4',
      blockingElement: { role: 'dialog', name: 'Cookie preferences' },
    });
  });
});
