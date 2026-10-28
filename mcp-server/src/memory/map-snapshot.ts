/**
 * Reads a browser_snapshot text for the site map (specs/004-site-navigation-map research R-10).
 * Only depth, role, the JSON name, the [eN] ref and the expanded/collapsed flags are read; the
 * value="…" and context="…" fields are never parsed. Content areas are skipped entirely.
 */
import { MAP_ALLOWLIST, type MapArea, type MapRole } from './map-allowlist.js';
import { boundName, controlKey } from './map-text.js';

export interface SnapshotControl {
  ref: string | null;
  area: MapArea;
  role: MapRole;
  /** Masked and bounded (boundName). */
  name: string;
  key: string;
  /** Index among every printed line with this role and name (case-insensitive), as browser_click's role locator counts. Null when it is the only one or the read was scoped. */
  nth: number | null;
  /** The opened dialog or menu this control sits in, if any. */
  opened: 'dialog' | 'menu' | null;
  expanded: boolean;
}

export interface ParsedSnapshot {
  title: string | null;
  /** Unscoped and not cut short: the only kind of read that may mark controls not seen. */
  complete: boolean;
  /** Characters of snapshot text read (a number only; used for the savings estimate). */
  chars: number;
  controls: SnapshotControl[];
  /** Number of dialog or menu subtrees printed. */
  openedContainers: number;
  /** ref → role and name of every eligible control, for click attribution. */
  refs: Map<string, { role: MapRole; name: string }>;
}

const LINE = /^( *)(?:- )?([a-z]+)(?: ("(?:[^"\\]|\\.)*"))?(?: \[(e\d+)\])?(.*)$/u;
const VALUE_FIELD = /^ value="(?:[^"\\]|\\.)*"/u;
const TRUNCATED = /^… truncated \(/u;
const NO_MATCH = /^\(no element matches /u;
const CONTENT = new Set<string>(MAP_ALLOWLIST.contentContainers.roles);
const AREAS = MAP_ALLOWLIST.areas;
const OPENED_ONLY = new Set<MapArea>(MAP_ALLOWLIST.openedOnly);
/** Areas where a list is navigation; a list item anywhere else is content (R-10). */
const LIST_IS_NAVIGATION = new Set<MapArea>(['header', 'nav', 'sidebar', 'footer']);

interface Ancestor {
  depth: number;
  role: string;
  /** The area this line sits in: its own landmark's, else the nearest one above it. */
  area: MapArea;
}

/**
 * A content container anywhere above the line makes it content, whatever landmark sits in between: a header
 * inside an article, a feed in a dialog or a table in a sidebar (AC-14). Only lists in navigation areas are not.
 */
function isContent(ancestor: Ancestor): boolean {
  return CONTENT.has(ancestor.role) && !(ancestor.role === 'listitem' && LIST_IS_NAVIGATION.has(ancestor.area));
}

function titleOf(lines: readonly string[], start: number): string | null {
  if (start >= 0) {
    const header = lines[start].slice('page: '.length);
    const cut = header.lastIndexOf(' — ');
    const title = cut >= 0 ? header.slice(0, cut) : header;
    return title === '(untitled)' ? null : title;
  }
  const line = lines.find((entry) => entry.startsWith('title: '));
  return line ? line.slice('title: '.length) : null;
}

function parseName(quoted: string | undefined): string | null {
  if (quoted === undefined) return null;
  try {
    const name = JSON.parse(quoted) as unknown;
    return typeof name === 'string' ? name : null;
  } catch {
    return null;
  }
}

/**
 * Parse a snapshot text, or the text of `browser_navigate {snapshot:true}` (navigation lines, a blank line, then
 * the snapshot). `scoped` is true when the read used query or target. `truncated` is the result's flag when the
 * tool reports one; the marker line counts either way.
 */
export function parseMapSnapshot(text: string, options: { scoped?: boolean; truncated?: boolean } = {}): ParsedSnapshot {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.startsWith('page: '));
  const title = titleOf(lines, start);
  const empty: ParsedSnapshot = { title, complete: false, chars: 0, controls: [], openedContainers: 0, refs: new Map() };
  if (start < 0) return empty;

  const body = lines.slice(start + 1);
  let truncated = options.truncated === true;
  let scoped = options.scoped === true;
  const parsed: Array<{ depth: number; role: string; name: string | null; ref: string | null; flags: string[] }> = [];
  for (const line of body) {
    if (TRUNCATED.test(line)) {
      truncated = true;
      break;
    }
    if (NO_MATCH.test(line)) {
      scoped = true;
      continue;
    }
    if (!line.trim()) break;
    const match = LINE.exec(line);
    if (!match) continue;
    const [, indent, role, quoted, ref, rawRest] = match;
    if (rawRest.startsWith(' (not readable)')) continue;
    const rest = rawRest.replace(VALUE_FIELD, '').split(' context="')[0];
    parsed.push({ depth: indent.length / 2, role, name: parseName(quoted), ref: ref ?? null, flags: rest.trim().split(/\s+/u) });
  }

  // Duplicates across the whole printed page, as the role locator counts them.
  const totals = new Map<string, number>();
  for (const item of parsed) {
    if (item.name !== null) totals.set(`${item.role}\n${item.name.toLowerCase()}`, (totals.get(`${item.role}\n${item.name.toLowerCase()}`) ?? 0) + 1);
  }
  const seenSoFar = new Map<string, number>();

  const stack: Ancestor[] = [];
  const controls: SnapshotControl[] = [];
  const keys = new Set<string>();
  const refs = new Map<string, { role: MapRole; name: string }>();
  let openedContainers = 0;
  for (const item of parsed) {
    while (stack.length && stack[stack.length - 1].depth >= item.depth) stack.pop();
    const twinKey = item.name !== null ? `${item.role}\n${item.name.toLowerCase()}` : '';
    const index = twinKey ? (seenSoFar.get(twinKey) ?? 0) : 0;
    if (twinKey) seenSoFar.set(twinKey, index + 1);

    const area: MapArea = stack.length ? stack[stack.length - 1].area : AREAS['(none)'];
    const inContent = stack.some(isContent);
    const ownArea = Object.hasOwn(AREAS, item.role) ? AREAS[item.role] : undefined;
    if (ownArea === 'dialog' || ownArea === 'menu') openedContainers += 1;
    stack.push({ depth: item.depth, role: item.role, area: ownArea ?? area });

    if (inContent || item.name === null) continue;
    const role = item.role as MapRole;
    if (!(MAP_ALLOWLIST.eligibleRoles[area] as readonly string[]).includes(role)) continue;
    const name = boundName(item.name);
    if (!name) continue;
    const key = controlKey(area, role, name);
    if (item.ref) refs.set(item.ref, { role, name });
    if (keys.has(key)) continue;
    keys.add(key);
    const total = totals.get(twinKey) ?? 1;
    controls.push({
      ref: item.ref,
      area,
      role,
      name,
      key,
      nth: !scoped && total > 1 ? index : null,
      opened: OPENED_ONLY.has(area) ? (area as 'dialog' | 'menu') : null,
      expanded: item.flags.includes('expanded'),
    });
  }
  return { title, complete: !scoped && !truncated, chars: body.join('\n').length, controls, openedContainers, refs };
}
