import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryService, type MemoryConnection } from '../mcp-server/src/memory/service.js';
import { defaultPolicy, enablePolicy, writePolicy } from '../mcp-server/src/memory/policy.js';
import { routeMemoryToolCall } from '../mcp-server/src/memory/policy-tool-route.js';
import { installNetworkSink } from './helpers/memory-fixtures.js';
import {
  ORIGIN,
  PLANTED,
  clickOutcome,
  contentText,
  homeText,
  mkMapDir,
  navigateOutcome,
  navigateWithSnapshot,
  profileText,
  snapshotOutcome,
  snapshotText,
  type OutcomeShape,
} from './helpers/map-fixtures.js';

/**
 * Privacy of the site map (specs/004-site-navigation-map AC-13–AC-15, SC-004): structure only, masked addresses,
 * no content, no form values, per-profile isolation, and no network I/O. Every stored file and every answer an
 * agent or the owner can get is scanned for the planted markers.
 */

const PROFILE = 'profile-a';
const QUERY_SECRET = 'sessionid=Zx81KqPLANTED';
const FRAGMENT_SECRET = 'frag-PLANTED-77'; // gitleaks:allow (synthetic planted value; the privacy test checks it is never stored)
const USERINFO = 'planteduser';
// Arabic-Indic and full-width digits (RV-02).
const ARABIC_ORDER = '١٢٣٤٥٦٧٨';
const ARABIC_PHONE = '٠١٠٠١٢٣٤٥٦٧';
const WIDE_ORDER = '１２３４５６７８';
// Content inside a nested landmark and inside an opened dialog (RV-01).
const POST_TITLE = 'My cancer diagnosis story';
const NOTIFICATION = 'Ahmed Hassan commented on your photo';
const MARKERS = [PLANTED.email, PLANTED.phone, '12345678', PLANTED.token, PLANTED.value, QUERY_SECRET, FRAGMENT_SECRET, USERINFO, 'Message from', 'Planted', ARABIC_ORDER, ARABIC_PHONE, WIDE_ORDER, POST_TITLE, NOTIFICATION];

let dir: ReturnType<typeof mkMapDir>;
let clock: number;
let conn: MemoryConnection;
let eligibility: 'clear' | 'protected' | 'unknown';
let service: MemoryService;
const outputs: string[] = [];

async function run(shape: OutcomeShape): Promise<void> {
  clock += 1_000;
  const call = service.beginCall(shape.sessionId, shape.tool);
  const observation = call.observe && shape.observation ? { ...shape.observation, digestBefore: 'a', digestAfter: 'a' } : undefined;
  const outcome = { sessionId: shape.sessionId, tool: shape.tool, params: shape.params, daemonCallId: shape.daemonCallId, result: shape.result, observation, ...(shape.error ? { error: shape.error } : {}) };
  if (!shape.error) {
    const result = await service.withReminder(call, outcome) as { memory?: string[] };
    outputs.push(JSON.stringify(result.memory ?? []));
  }
  service.afterCall(call, outcome);
  await service.flush();
}

function storedText(): string {
  const parts: string[] = [];
  const walk = (folder: string) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(file);
      else parts.push(`${entry.name}\n${fs.readFileSync(file, 'utf8')}`);
    }
  };
  walk(dir.memoryDir);
  return parts.join('\n');
}

/** Browse a site that holds every kind of planted data, in the ways an agent would. */
async function browse(): Promise<void> {
  await run(navigateOutcome({ url: `${ORIGIN}/`, snapshot: true, text: navigateWithSnapshot(homeText()) }));
  // A content page reached through a header link: content-area controls, links holding personal data, a form value.
  await run(clickOutcome({ target: 'e3', fromUrl: `${ORIGIN}/`, url: `${ORIGIN}/inbox` }));
  await run(snapshotOutcome({ url: `${ORIGIN}/inbox`, text: contentText() }));
  // A click on a content link leads to a page that must not be recorded.
  await run(clickOutcome({ target: 'e207', fromUrl: `${ORIGIN}/inbox`, url: `${ORIGIN}/message/991` }));
  await run(snapshotOutcome({ url: `${ORIGIN}/message/991`, text: profileText() }));
  // An address with userinfo, an e-mail, a phone-like number, a token, a query and a fragment.
  await run(navigateOutcome({ url: `${ORIGIN}/`, snapshot: true, text: navigateWithSnapshot(homeText()) }));
  const messy = `https://${USERINFO}:pw@shop.example/u/${encodeURIComponent(PLANTED.email)}/orders/12345678/${PLANTED.token}?${QUERY_SECRET}#${FRAGMENT_SECRET}`;
  await run(clickOutcome({ target: 'e4', fromUrl: `${ORIGIN}/`, url: messy }));
  await run(snapshotOutcome({ url: messy, text: profileText() }));
  // Numbers in other digit sets: a title and navigation names.
  await run(snapshotOutcome({
    url: `${ORIGIN}/inbox`,
    text: snapshotText(`طلب رقم ${ARABIC_ORDER}`, `${ORIGIN}/inbox`, [
      { depth: 0, role: 'navigation' },
      { depth: 1, role: 'link', name: 'Inbox', ref: 'e1' },
      { depth: 1, role: 'link', name: `اتصل ${ARABIC_PHONE}`, ref: 'e2' },
      { depth: 1, role: 'link', name: `Order ${WIDE_ORDER}`, ref: 'e3' },
    ]),
  }));
  // A post's own header inside main > article, as a page that predates the HTML-AAM role fix would print it.
  const blog = (dialog: boolean) => snapshotText('Shop home', `${ORIGIN}/`, [
    { depth: 0, role: 'banner' },
    { depth: 1, role: 'button', name: 'Notifications', ref: 'e1' },
    { depth: 0, role: 'main' },
    { depth: 1, role: 'article' },
    { depth: 2, role: 'banner' },
    { depth: 3, role: 'link', name: POST_TITLE, ref: 'e2' },
    ...(dialog ? [{ depth: 0, role: 'dialog' }, { depth: 1, role: 'feed' }, { depth: 2, role: 'article' }, { depth: 3, role: 'link', name: NOTIFICATION, ref: 'e3' }] : []),
  ]);
  await run(snapshotOutcome({ url: `${ORIGIN}/`, text: blog(false) }));
  // A header button opens a notifications dialog whose feed holds personal text.
  await run(clickOutcome({ target: 'e1', fromUrl: `${ORIGIN}/`, url: `${ORIGIN}/` }));
  await run(snapshotOutcome({ url: `${ORIGIN}/`, text: blog(true) }));
  await run(clickOutcome({ target: 'e2', fromUrl: `${ORIGIN}/`, url: `${ORIGIN}/posts/diagnosis` }));
  await run(snapshotOutcome({ url: `${ORIGIN}/posts/diagnosis`, text: profileText() }));
  // A direct open of an unknown address with planted data is not a structural page.
  await run(navigateOutcome({ url: `${ORIGIN}/inbox?${QUERY_SECRET}`, snapshot: true, text: navigateWithSnapshot(contentText(), 200, `Inbox (${PLANTED.order})`) }));
}

beforeEach(async () => {
  dir = mkMapDir('bc-mappriv-');
  clock = Date.parse('2026-10-28T09:00:00.000Z');
  conn = { browserId: PROFILE, browserLabel: 'Work', connectionId: 'conn-1', ambiguous: false, supportsSiteContext: true, supportsSiteMap: true };
  eligibility = 'clear';
  outputs.length = 0;
  service = new MemoryService({ memoryDir: dir.memoryDir, vault: { memoryEligibility: () => eligibility }, connection: () => ({ ...conn }), now: () => clock });
  await writePolicy(dir.memoryDir, enablePolicy(defaultPolicy(), new Date(clock).toISOString()));
  clock += 1_000;
  for (const profile of [PROFILE, 'profile-b']) {
    await service.adminFromWire({ kind: 'memory-admin', id: `e-${profile}`, command: 'map', map: { command: 'enable', browser: profile } });
  }
  clock += 1_000;
});

afterEach(async () => {
  await service.flush();
  dir.cleanup();
});

describe('site map privacy (T030, SC-004)', () => {
  it('stores and returns structure only: no planted marker in any file, lookup, reminder, inspect, export or status (AC-14, AC-15)', async () => {
    const sink = installNetworkSink();
    try {
      await browse();
      const ask = async (params: Record<string, unknown>) => outputs.push(JSON.stringify(await service.handleTool('browser_site_map', params, 's1', { siteContext: null, connectionIdBefore: null })));
      await ask({ origin: ORIGIN });
      for (const query of ['inbox', 'orders', 'edit', 'message', 'planted', 'compose']) await ask({ origin: ORIGIN, query });
      for (const command of ['status', 'export']) outputs.push(JSON.stringify(await service.adminFromWire({ kind: 'memory-admin', id: command, command: 'map', map: { command } })));
      outputs.push(JSON.stringify(await service.adminFromWire({ kind: 'memory-admin', id: 'i', command: 'map', map: { command: 'inspect', origin: ORIGIN } })));
      const bridge = { callTool: async () => ({ success: true, siteContext: { url: `${ORIGIN}/`, incognito: false, topLevel: true, stable: true } }) };
      outputs.push(JSON.stringify(await routeMemoryToolCall('browser_site_map', service, bridge, 's1', 'agent', { tabId: 7, query: 'inbox' }, new AbortController().signal)));
    } finally {
      sink.restore();
    }
    expect(sink.violations).toEqual([]);

    const everything = `${storedText()}\n${outputs.join('\n')}`;
    for (const marker of MARKERS) expect(everything, marker).not.toContain(marker);
    expect(everything).not.toContain('Edit"');

    const record = await service.map.store.getMap(PROFILE, ORIGIN);
    const paths = record?.pages.map((page) => page.path).sort();
    expect(paths).toContain('/inbox');
    expect(paths).not.toContain('/message/991');
    // A page reached only from a post's own header link is content too (RV-01).
    expect(paths).not.toContain('/posts/diagnosis');
    const masked = record?.pages.find((page) => page.path.startsWith('/u/'));
    expect(masked).toMatchObject({ addressable: false, title: null });
    expect(masked?.path).toMatch(/\{email\}.*\{(?:id|phone)\}/u);
    const inbox = record?.pages.find((page) => page.path === '/inbox');
    expect(inbox?.title).not.toBeNull();
    expect(inbox?.controls.map((control) => control.name).sort()).toEqual(['Compose', 'Inbox']);
  });

  it('records nothing for a private tab or a vault-protected page (AC-13)', async () => {
    await run(navigateOutcome({ url: `${ORIGIN}/`, snapshot: true, text: navigateWithSnapshot(homeText()), context: { url: `${ORIGIN}/`, incognito: true } }));
    eligibility = 'protected';
    await run(navigateOutcome({ url: `${ORIGIN}/`, snapshot: true, text: navigateWithSnapshot(homeText()) }));
    expect(await service.map.store.listMaps()).toEqual([]);
  });

  it('keeps profiles apart: profile B never sees or stores profile A\'s entries (AC-12)', async () => {
    await browse();
    conn = { ...conn, browserId: 'profile-b', browserLabel: 'Home', connectionId: 'conn-2' };
    const answer = JSON.stringify(await service.handleTool('browser_site_map', { origin: ORIGIN, query: 'inbox' }, 's1', { siteContext: null, connectionIdBefore: null }));
    expect(answer).not.toContain('/inbox');
    expect(await service.map.store.listMaps('profile-b')).toEqual([]);
  });
});
