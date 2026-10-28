import { describe, expect, it } from 'vitest';
import { parseMapSnapshot } from '../mcp-server/src/memory/map-snapshot.js';
import { arabicText, contentText, homeText, navigateWithSnapshot, PLANTED, profileText, snapshotText } from './helpers/map-fixtures.js';

const names = (text: string, options = {}) => parseMapSnapshot(text, options).controls.map((control) => `${control.area}:${control.role}:${control.name}`);

describe('parseMapSnapshot (R-10, AC-06)', () => {
  it('reads areas from the nearest landmark and keeps eligible roles only', () => {
    const parsed = parseMapSnapshot(homeText());
    expect(parsed.title).toBe('Shop home');
    expect(parsed.complete).toBe(true);
    expect(names(homeText())).toEqual([
      'header:link:Home',
      'header:button:Account',
      'header:link:Help',
      'header:link:Contact',
      'main:button:Show offers',
      'footer:link:Contact',
      'footer:link:Privacy',
    ]);
  });

  it('never records links in the main area, headings or inputs', () => {
    const all = names(profileText());
    expect(all).toContain('main:button:Edit profile');
    expect(all).toContain('main:menuitem:Sign out');
    expect(all.some((entry) => entry.includes('Display name'))).toBe(false);
    expect(names(homeText()).some((entry) => entry.includes('Read the story'))).toBe(false);
  });

  it('skips content containers and names with data (AC-14)', () => {
    const parsed = parseMapSnapshot(contentText());
    const all = parsed.controls.map((control) => control.name);
    expect(all).toEqual(['Inbox', 'Compose']);
    // The title is raw here; capture bounds and masks it (boundTitle).
    const dump = JSON.stringify({ controls: parsed.controls, refs: [...parsed.refs] });
    for (const marker of Object.values(PLANTED)) expect(dump).not.toContain(marker);
  });

  it('treats a content container as content in every area, even with a landmark inside it (AC-14)', () => {
    const text = snapshotText('Blog', 'https://shop.example/', [
      { depth: 0, role: 'banner' },
      { depth: 1, role: 'list' },
      { depth: 2, role: 'listitem' },
      { depth: 3, role: 'link', name: 'Archive', ref: 'e1' },
      { depth: 0, role: 'main' },
      { depth: 1, role: 'article' },
      { depth: 2, role: 'banner' },
      { depth: 3, role: 'link', name: 'My cancer diagnosis story', ref: 'e2' },
      { depth: 1, role: 'list' },
      { depth: 2, role: 'listitem' },
      { depth: 3, role: 'contentinfo' },
      { depth: 4, role: 'link', name: 'Reply to Ahmed Hassan', ref: 'e3' },
      { depth: 0, role: 'dialog' },
      { depth: 1, role: 'feed' },
      { depth: 2, role: 'article' },
      { depth: 3, role: 'link', name: 'Ahmed Hassan commented on your photo', ref: 'e4' },
      { depth: 1, role: 'button', name: 'Mark all read', ref: 'e5' },
      { depth: 0, role: 'complementary' },
      { depth: 1, role: 'table' },
      { depth: 2, role: 'row' },
      { depth: 3, role: 'button', name: 'Pay invoice 7', ref: 'e6' },
      { depth: 1, role: 'link', name: 'Settings', ref: 'e7' },
    ]);
    const parsed = parseMapSnapshot(text);
    expect(parsed.controls.map((control) => `${control.area}:${control.name}`)).toEqual(['header:Archive', 'dialog:Mark all read', 'sidebar:Settings']);
    expect([...parsed.refs.keys()].sort()).toEqual(['e1', 'e5', 'e7']);
  });

  it('gives nth only to duplicates across the page in a complete read', () => {
    const twins = snapshotText('t', 'https://a.example/', [
      { depth: 0, role: 'banner' },
      { depth: 1, role: 'button', name: 'More', ref: 'e1' },
      { depth: 0, role: 'navigation' },
      { depth: 1, role: 'button', name: 'more', ref: 'e2' },
    ]);
    const parsed = parseMapSnapshot(twins);
    expect(parsed.controls.map((control) => [control.area, control.nth])).toEqual([
      ['header', 0],
      ['nav', 1],
    ]);
    expect(parseMapSnapshot(twins, { scoped: true }).controls.every((control) => control.nth === null)).toBe(true);
  });

  it('records duplicates in one area once', () => {
    const twins = snapshotText('t', 'https://a.example/', [
      { depth: 0, role: 'banner' },
      { depth: 1, role: 'link', name: 'Help', ref: 'e1' },
      { depth: 1, role: 'link', name: 'Help', ref: 'e2' },
    ]);
    const parsed = parseMapSnapshot(twins);
    expect(parsed.controls).toHaveLength(1);
    expect(parsed.refs.get('e2')).toEqual({ role: 'link', name: 'Help' });
  });

  it('marks opened menus and expanded controls', () => {
    const parsed = parseMapSnapshot(homeText({ menuOpen: true }));
    expect(parsed.openedContainers).toBe(1);
    expect(parsed.controls.find((control) => control.name === 'Account')?.expanded).toBe(true);
    const profile = parsed.controls.find((control) => control.name === 'Profile');
    expect(profile).toMatchObject({ area: 'menu', opened: 'menu', role: 'menuitem' });
  });

  it('treats truncated, scoped and no-match reads as incomplete', () => {
    expect(parseMapSnapshot(homeText({ truncatedMore: 500 })).complete).toBe(false);
    expect(parseMapSnapshot(homeText(), { truncated: true }).complete).toBe(false);
    expect(parseMapSnapshot(homeText(), { scoped: true }).complete).toBe(false);
    expect(parseMapSnapshot(`${homeText()}\n(no element matches "zzz")`).complete).toBe(false);
  });

  it('never reads value= or context= fields', () => {
    const text = snapshotText('t', 'https://a.example/', [
      { depth: 0, role: 'banner' },
      { depth: 1, role: 'button', name: 'Go', ref: 'e1', value: '[e99] secret', context: 'row 12345678' },
    ]);
    const parsed = parseMapSnapshot(text);
    expect(parsed.controls).toHaveLength(1);
    expect(JSON.stringify(parsed.controls)).not.toContain('secret');
    expect(parsed.refs.has('e99')).toBe(false);
  });

  it('reads the navigate {snapshot:true} text and the Arabic fixture', () => {
    const parsed = parseMapSnapshot(navigateWithSnapshot(homeText()));
    expect(parsed.controls.length).toBeGreaterThan(0);
    expect(parsed.title).toBe('Shop home');
    expect(names(arabicText())).toEqual(['header:link:الملف الشخصي', 'header:button:تسجيل الخروج', 'header:link:حول الموقع']);
  });

  it('returns nothing for text without a page header', () => {
    expect(parseMapSnapshot('title: x\nstatus: 200').controls).toEqual([]);
    expect(parseMapSnapshot('title: x\nstatus: 200').title).toBe('x');
  });

  it('skips cross-origin (not readable) lines', () => {
    const text = `page: t — https://a.example/\nbanner [e1]\n  link "Frame" (not readable)\n  link "Ok" [e2]`;
    expect(names(text)).toEqual(['header:link:Ok']);
  });
});
