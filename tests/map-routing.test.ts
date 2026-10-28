/**
 * specs/005-direct-site-routing: complete reads become page entries (FR-001), late address changes are credited to
 * the click (FR-002, FR-003), entrances from other sites (FR-004, FR-005, FR-009), computed routes (FR-006) and the
 * reminder's known pages (FR-007). E2–E4 replay the 2026-10-28 evidence on synthetic sites.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryService, type MemoryConnection } from '../mcp-server/src/memory/service.js';
import { defaultPolicy, enablePolicy, excludeOrigin, writePolicy } from '../mcp-server/src/memory/policy.js';
import { defaultMapPolicy, enableMapProfile, excludeMapPath, writeMapPolicy } from '../mcp-server/src/memory/map-policy.js';
import { runMapAdmin } from '../mcp-server/src/memory/map-admin.js';
import { buildMapLookup, buildMapOutline, buildMapReminder } from '../mcp-server/src/memory/map-output.js';
import { applyMapOp, type MapReadOp, type ObservedControl } from '../mcp-server/src/memory/map-reconcile.js';
import { emptyMapRecord, validateMapRecord, type MapRecord } from '../mcp-server/src/memory/map-record.js';
import { controlKey } from '../mcp-server/src/memory/map-text.js';
import type { MapArea, MapRole } from '../mcp-server/src/memory/map-allowlist.js';
import {
  clickOutcome,
  mkMapDir,
  navigateOutcome,
  navigateWithSnapshot,
  siteContext,
  snapshotOutcome,
  snapshotText,
  type Line,
  type OutcomeShape,
} from './helpers/map-fixtures.js';

const START = Date.parse('2026-10-28T09:00:00.000Z');
const PROFILE = 'profile-a';
const POS = 'https://pos.example';
const PORTAL = 'https://portal.example';
const HOME = `${POS}/odoo`;
const HUB = `${POS}/odoo/point-of-sale`;
const FLOOR = `${POS}/pos/ui/1/floor`;
const DATABASES = `${PORTAL}/ar/my/databases`;

let dir: ReturnType<typeof mkMapDir>;
let clock: number;
let conn: MemoryConnection;
let service: MemoryService;
let seq = 0;

const iso = (): string => new Date(clock).toISOString();

async function enableAll(): Promise<void> {
  await writePolicy(dir.memoryDir, enablePolicy(defaultPolicy(), iso()));
  await writeMapPolicy(dir.memoryDir, enableMapProfile(defaultMapPolicy(), PROFILE, iso()));
  clock += 1_000;
}

async function run(shape: OutcomeShape, advanceMs = 1_000): Promise<unknown> {
  clock += advanceMs;
  const call = service.beginCall(shape.sessionId, shape.tool);
  const observation = call.observe && shape.observation ? { ...shape.observation, digestBefore: 'a', digestAfter: 'a' } : undefined;
  const outcome = { sessionId: shape.sessionId, tool: shape.tool, params: shape.params, daemonCallId: shape.daemonCallId, result: shape.result, observation, ...(shape.error !== undefined ? { error: shape.error } : {}) };
  const result = shape.error === undefined ? await service.withReminder(call, outcome) : shape.result;
  service.afterCall(call, outcome);
  await service.flush();
  return result;
}

/** Any other tab action, as the daemon hands it over: not observed, no siteContext. */
function typeOutcome(tabId = 7): OutcomeShape {
  seq += 1;
  return { sessionId: 's1', tool: 'browser_type', params: { tabId, target: 'e1', text: 'x' }, daemonCallId: `type-${seq}`, result: { success: true }, observation: undefined };
}

/** A direct open that the site redirected: requested `url`, landed on `landed`. */
function redirectedOpen(url: string, landed: string): OutcomeShape {
  seq += 1;
  return {
    sessionId: 's1',
    tool: 'browser_navigate',
    params: { tabId: 7, url },
    daemonCallId: `open-${seq}`,
    result: { success: true, tabId: 7, url: landed, status: 200, title: 'Odoo' },
    observation: { siteContext: siteContext({ url: landed }), sanitizedUnchanged: true },
  };
}

const map = (origin = POS): Promise<MapRecord | null> => service.map.store.getMap(PROFILE, origin, { afterWrites: true });
const page = (record: MapRecord | null, path: string) => record?.pages.find((entry) => entry.path === path);

const homeLines = (): Line[] => [
  { depth: 0, role: 'banner' },
  { depth: 1, role: 'button', name: 'Ask AI', ref: 'e1' },
  { depth: 0, role: 'combobox', ref: 'e2' },
  { depth: 0, role: 'listbox', name: 'Apps', ref: 'e3' },
  { depth: 1, role: 'option', name: 'Point of Sale', ref: 'e4' },
];
const hubLines = (): Line[] => [
  { depth: 0, role: 'navigation' },
  { depth: 1, role: 'link', name: 'Home menu', ref: 'e10' },
  { depth: 0, role: 'main' },
  { depth: 1, role: 'button', name: 'Continue Selling', ref: 'e11' },
];
const floorLines = (): Line[] => [{ depth: 0, role: 'button', name: 'Tables', ref: 'e20' }, { depth: 0, role: 'button', name: 'New Order', ref: 'e21' }];
const databasesLines = (): Line[] => [
  { depth: 0, role: 'main' },
  { depth: 1, role: 'table' },
  { depth: 2, role: 'row' },
  { depth: 3, role: 'cell' },
  { depth: 4, role: 'button', name: 'arkan-aser', ref: 'e30' },
  { depth: 4, role: 'link', name: 'Connect', ref: 'e31' },
];

const homeText = () => snapshotText('Odoo', HOME, homeLines());
const hubText = () => snapshotText('Point of Sale', HUB, hubLines());
const floorText = () => snapshotText('Odoo POS', FLOOR, floorLines());

beforeEach(() => {
  dir = mkMapDir('bc-maproute-');
  clock = START;
  conn = { browserId: PROFILE, browserLabel: 'Work', connectionId: 'conn-1', ambiguous: false, supportsSiteContext: true, supportsSiteMap: true };
  service = new MemoryService({ memoryDir: dir.memoryDir, vault: { memoryEligibility: () => 'clear' }, connection: () => ({ ...conn }), now: () => clock });
});

afterEach(async () => {
  await service.flush();
  dir.cleanup();
});

describe('005 FR-001 (E4): a complete read records the page', () => {
  it('a page opened by address and read completely gets an entry with its address and title', async () => {
    await enableAll();
    await run(navigateOutcome({ url: FLOOR, snapshot: true, text: navigateWithSnapshot(floorText()) }));
    expect(page(await map(), '/pos/ui/1/floor')).toMatchObject({ reason: 'read', addressable: true, title: 'Odoo POS' });
  });

  it('a scoped, a truncated or a failed read creates no entry', async () => {
    await enableAll();
    await run(snapshotOutcome({ url: FLOOR, text: floorText(), params: { query: 'tables' } }));
    await run(snapshotOutcome({ url: `${POS}/pos/ui/2/floor`, text: snapshotText('Odoo POS', `${POS}/pos/ui/2/floor`, floorLines(), { truncatedMore: 900 }), truncated: true }));
    await run(navigateOutcome({ url: `${POS}/pos/ui/3/floor`, snapshot: true, status: 500, text: navigateWithSnapshot(floorText(), 500) }));
    expect(await map()).toBeNull();
  });

  it('a page reached through a content link or a redirect to another site gets no entry from its read (SC-004, RV-05)', async () => {
    await enableAll();
    const idp = 'https://idp.example/login';
    const redirected = navigateOutcome({ url: FLOOR, snapshot: true, text: navigateWithSnapshot(snapshotText('Sign in', idp, [{ depth: 0, role: 'button', name: 'Next', ref: 'e1' }])), context: { url: idp } });
    await run({ ...redirected, result: { ...redirected.result, url: idp } });
    expect(await map('https://idp.example')).toBeNull();
    // A button inside a table row is content: the page it opens is not recorded by the read that follows.
    const detail = `${PORTAL}/ar/my/databases/arkan-aser`;
    await run(navigateOutcome({ url: DATABASES, snapshot: true, text: navigateWithSnapshot(snapshotText('Databases', DATABASES, databasesLines())) }));
    await run(clickOutcome({ target: 'e30', fromUrl: DATABASES, url: detail }));
    await run(snapshotOutcome({ url: detail, text: snapshotText('arkan-aser', detail, []) }));
    await run(snapshotOutcome({ url: detail, text: snapshotText('arkan-aser', detail, []) }));
    expect(page(await map(PORTAL), '/ar/my/databases/arkan-aser')).toBeUndefined();
    // Opened by address, it is recorded (FR-001).
    await run(navigateOutcome({ url: detail, snapshot: true, text: navigateWithSnapshot(snapshotText('arkan-aser', detail, [])) }));
    expect(page(await map(PORTAL), '/ar/my/databases/arkan-aser')).toMatchObject({ reason: 'read', addressable: true });
  });
});

describe('005 FR-002/FR-003 (E2): a late address change is credited to the click', () => {
  async function clickContinue(): Promise<void> {
    await run(navigateOutcome({ url: HUB, snapshot: true, text: navigateWithSnapshot(hubText()) }));
    // The click returns before the app changes the address; the expect wrapper then reads the same page.
    await run(clickOutcome({ target: 'text=Continue Selling', fromUrl: HUB, url: HUB }));
    await run(snapshotOutcome({ url: HUB, text: hubText() }));
  }

  it('records the destination when the new address shows up in a later read (exact replay)', async () => {
    await enableAll();
    await clickContinue();
    await run(snapshotOutcome({ url: FLOOR, text: floorText() }));
    const record = await map();
    const button = page(record, '/odoo/point-of-sale')?.controls.find((control) => control.name === 'Continue Selling');
    expect(button?.destinations.public).toMatchObject({ path: '/pos/ui/1/floor' });
    expect(page(record, '/pos/ui/1/floor')).toMatchObject({ reason: 'destination', via: { path: '/odoo/point-of-sale' }, addressable: true });
  });

  it('another action in the tab cancels it', async () => {
    await enableAll();
    await clickContinue();
    await run(typeOutcome());
    await run(snapshotOutcome({ url: FLOOR, text: floorText() }));
    const button = page(await map(), '/odoo/point-of-sale')?.controls.find((control) => control.name === 'Continue Selling');
    expect(button?.destinations).toEqual({});
  });

  it('expires after 120 seconds', async () => {
    await enableAll();
    await clickContinue();
    await run(snapshotOutcome({ url: FLOOR, text: floorText() }), 121_000);
    const button = page(await map(), '/odoo/point-of-sale')?.controls.find((control) => control.name === 'Continue Selling');
    expect(button?.destinations).toEqual({});
    // FR-001 still records the page itself.
    expect(page(await map(), '/pos/ui/1/floor')).toMatchObject({ reason: 'read' });
  });
});

describe('005 FR-001 (E3): pages reached through clicks the map could not attribute', () => {
  it('a click on an ineligible option, then a click from an unread page, still leaves the target page', async () => {
    await enableAll();
    await run(navigateOutcome({ url: HOME, snapshot: true, text: navigateWithSnapshot(homeText()) }));
    await run(clickOutcome({ target: 'e4', fromUrl: HOME, url: HUB }));
    await run(clickOutcome({ target: 'text=Continue Selling', fromUrl: HUB, url: FLOOR }));
    await run(snapshotOutcome({ url: FLOOR, text: floorText() }));
    expect(page(await map(), '/pos/ui/1/floor')).toMatchObject({ reason: 'read', addressable: true });
  });
});

describe('005 FR-004/FR-005/FR-009: entrances from another site', () => {
  async function enterFromPortal(): Promise<void> {
    await run(navigateOutcome({ url: DATABASES, snapshot: true, text: navigateWithSnapshot(snapshotText('Databases', DATABASES, databasesLines())) }));
    // "Connect" sits in a table row: not an eligible control, so only the address of the page it was on is kept.
    await run(clickOutcome({ target: 'e31', fromUrl: DATABASES, url: HOME }));
    await run(snapshotOutcome({ url: HOME, text: homeText() }));
  }

  it('records the source page address on the arriving site, never the control name', async () => {
    await enableAll();
    await enterFromPortal();
    const record = await map();
    expect(record?.entrances).toEqual([{ origin: PORTAL, path: '/ar/my/databases', addressable: true, at: expect.any(String) }]);
    const stored = JSON.stringify(record);
    expect(stored).not.toContain('Connect');
    expect(stored).not.toContain('arkan-aser');
    // The tab arrived through a content link, so that read records no page (SC-004, R-10); an open by address would.
    expect(page(record, '/odoo')).toBeUndefined();
    // The portal page itself was read completely (FR-001); its table rows stay content, so it holds no controls.
    const portal = await map(PORTAL);
    expect(page(portal, '/ar/my/databases')?.controls).toEqual([]);
    expect(JSON.stringify(portal)).not.toContain('Connect');
  });

  it('a sign-in landing is classified as sign_in, and the lookup names the way in', async () => {
    await enableAll();
    await enterFromPortal();
    await run(navigateOutcome({ url: FLOOR, snapshot: true, text: navigateWithSnapshot(floorText()) }));
    await run(redirectedOpen(FLOOR, `${POS}/web/login?redirect=%2Fpos%2Fui%2F1%2Ffloor`));
    const floor = page(await map(), '/pos/ui/1/floor');
    expect(floor?.lastOpen).toMatchObject({ result: 'sign_in', path: '/web/login' });
    const answer = await service.handleTool('browser_site_map', { origin: POS, query: 'pos' }, 's1', { siteContext: null, connectionIdBefore: null }) as { text: string };
    expect(answer.text).toContain('sign-in expected');
    expect(answer.text).toContain(`entered before from ${PORTAL}/ar/my/databases`);
    const outline = await service.handleTool('browser_site_map', { origin: POS }, 's1', { siteContext: null, connectionIdBefore: null }) as { text: string };
    expect(outline.text).toContain(`entered before from ${PORTAL}/ar/my/databases`);
  });

  it('keeps no entrance from an excluded site or an excluded path of it', async () => {
    await enableAll();
    await writeMapPolicy(dir.memoryDir, excludeMapPath(enableMapProfile(defaultMapPolicy(), PROFILE, new Date(START).toISOString()), PORTAL, '/ar/my', iso()));
    await enterFromPortal();
    expect((await map())?.entrances ?? []).toEqual([]);
    await writePolicy(dir.memoryDir, excludeOrigin(enablePolicy(defaultPolicy(), new Date(START).toISOString()), PORTAL, iso()));
    await writeMapPolicy(dir.memoryDir, enableMapProfile(defaultMapPolicy(), PROFILE, new Date(START).toISOString()));
    await enterFromPortal();
    expect((await map())?.entrances ?? []).toEqual([]);
  });

  it('an owner delete of the source site removes its entrances from the file', async () => {
    await enableAll();
    await enterFromPortal();
    await run(navigateOutcome({ url: HOME, snapshot: true, text: navigateWithSnapshot(homeText()) }));
    expect((await map())?.entrances).toHaveLength(1);
    const result = await runMapAdmin(service.map, 'admin-1', { command: 'delete', origin: PORTAL });
    expect(result.success).toBe(true);
    expect((await map())?.entrances ?? []).toEqual([]);
    expect(page(await map(), '/odoo')).toBeDefined();
  });
});

describe('005 FR-006/FR-007: routes and the reminder', () => {
  const O = POS;
  let tick = 0;
  const at = (): string => new Date(START + (tick += 1) * 1_000).toISOString();
  const ctl = (area: MapArea, role: MapRole, name: string, parent: string | null = null): ObservedControl => ({ key: controlKey(area, role, name), area, role, name, nth: null, parent });

  function read(record: MapRecord, path: string, title: string, controls: ObservedControl[], over: Partial<MapReadOp> = {}): void {
    applyMapOp(record, { type: 'read', opId: `r${(tick += 1)}`, profile: 'p', origin: O, at: at(), path, addressable: true, title, lang: 'en', dir: 'ltr', context: 'public', complete: true, readChars: 100, controls, reason: 'read', ...over });
  }

  function click(record: MapRecord, fromPath: string, control: ObservedControl, to: string, addressable = false): void {
    applyMapOp(record, { type: 'click', opId: `c${(tick += 1)}`, profile: 'p', origin: O, at: at(), fromPath, control, lang: 'en', sourceContext: 'public', navigated: true, destination: { path: to }, destinationAddressable: addressable });
  }

  function app(): MapRecord {
    const record = emptyMapRecord('p', O, at());
    const sales = ctl('main', 'button', 'Continue Selling');
    const tables = ctl('main', 'button', 'Tables');
    read(record, '/odoo/point-of-sale', 'Point of Sale', [sales]);
    read(record, '/pos/screen', 'Register', [tables], { addressable: false });
    read(record, '/pos/tables', 'Floor plan', [], { addressable: false });
    click(record, '/odoo/point-of-sale', sales, '/pos/screen');
    click(record, '/pos/screen', tables, '/pos/tables');
    return record;
  }

  const nextArgs = (cursor: string) => `browser_site_map {origin: "${O}", cursor: "${cursor}"}`;

  it('gives the shortest route from an addressable page to a page without its own address', () => {
    const lookup = buildMapLookup(O, app(), { query: 'floor plan', nextArgs });
    const target = lookup.pages.find((entry) => entry.path === '/pos/tables');
    expect(target?.route).toEqual({
      start: '/odoo/point-of-sale',
      steps: [
        { from: '/odoo/point-of-sale', locator: { role: 'button', name: 'Continue Selling' } },
        { from: '/pos/screen', locator: { role: 'button', name: 'Tables' } },
      ],
    });
    expect(lookup.text).toContain('route: open /odoo/point-of-sale · browser_click {"target":{"role":"button","name":"Continue Selling"}} · browser_click {"target":{"role":"button","name":"Tables"}}');
  });

  it('adds the menu opener before a control inside a menu', () => {
    const record = emptyMapRecord('p', O, at());
    const menu = ctl('header', 'button', 'Apps');
    const item = ctl('menu', 'menuitem', 'Sales', menu.key);
    read(record, '/', 'Home', [menu, item], { reason: 'root' });
    read(record, '/sales/board', 'Sales board', [], { addressable: false });
    click(record, '/', item, '/sales/board');
    const route = buildMapLookup(O, record, { query: 'sales board', nextArgs }).pages.find((entry) => entry.path === '/sales/board')?.route;
    expect(route?.steps.map((step) => step.locator.name)).toEqual(['Apps', 'Sales']);
  });

  it('offers no route through a data-changing control or a control whose last use failed', () => {
    const record = app();
    const tables = record.pages.find((entry) => entry.path === '/pos/screen')?.controls[0];
    if (tables) tables.lastUse = { result: 'failed', code: 'NOT_FOUND', at: at() };
    expect(buildMapLookup(O, record, { query: 'floor plan', nextArgs }).pages.find((entry) => entry.path === '/pos/tables')?.route).toBeUndefined();
    const paying = emptyMapRecord('p', O, at());
    const pay = ctl('main', 'button', 'Pay now');
    read(paying, '/cart', 'Cart', [pay]);
    read(paying, '/receipt', 'Receipt', [], { addressable: false });
    click(paying, '/cart', pay, '/receipt');
    expect(buildMapLookup(O, paying, { query: 'receipt', nextArgs }).pages.find((entry) => entry.path === '/receipt')?.route).toBeUndefined();
  });

  it('the reminder lists up to 3 known addresses within 600 characters', () => {
    const record = emptyMapRecord('p', O, at());
    read(record, '/', 'Home', [ctl('nav', 'link', 'Help')], { reason: 'root' });
    for (let index = 0; index < 5; index += 1) read(record, `/section-${index}`, `Section ${index} ${'x'.repeat(60)}`, []);
    const lines = buildMapReminder(record, '/', () => false) ?? [];
    const known = lines.find((line) => line.startsWith('map pages:'));
    expect(known?.match(/\/section-\d/gu)).toHaveLength(3);
    expect(known).not.toContain(' / ');
    expect(lines.join('\n').length).toBeLessThanOrEqual(600);
    expect(lines.length).toBeLessThanOrEqual(4);
    // Long addresses are never cut: the ones that do not fit are left out, and the line stays.
    for (let index = 0; index < 3; index += 1) read(record, `/long-${index}/${'a'.repeat(180)}`, `Long ${index}`, []);
    const long = (buildMapReminder(record, '/', () => false) ?? []).find((line) => line.startsWith('map pages:'));
    expect(long).toContain(`/long-2/${'a'.repeat(180)}`);
    expect(long?.match(/\/long-\d/gu)).toHaveLength(1);
    expect(long!.length).toBeLessThanOrEqual(300);
  });

  it('the outline shows entrances even when the site has no page yet', () => {
    const record = emptyMapRecord('p', O, at());
    record.entrances = [{ origin: PORTAL, path: '/ar/my/databases', addressable: true, at: at() }];
    expect(validateMapRecord(record, 'write').entrances).toHaveLength(1);
    expect(buildMapOutline(O, record).text).toContain(`entered before from ${PORTAL}/ar/my/databases`);
  });
});
