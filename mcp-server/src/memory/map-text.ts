/**
 * Text rules of the site map (specs/004-site-navigation-map research R-12–R-15): matching
 * normalization, masking, length bounds, the data-changing vocabulary and path prefixes.
 * Pure functions; nothing here reads or stores page content.
 */
import { MAP_ALLOWLIST, MAP_LIMITS, type MapArea, type MapRole } from './map-allowlist.js';

const TASHKEEL = /[ً-ٰٟـ]/gu;
const WORD_SPLIT = /[^\p{L}\p{N}]+/u;
const MASK_RULES = MAP_ALLOWLIST.masking.rules.map((rule) => ({ placeholder: rule.placeholder, pattern: new RegExp(rule.pattern, 'gu') }));
/** A stored string that still matches one of these was not masked: the write is refused (defense in depth). */
const UNMASKED = MAP_ALLOWLIST.masking.rules.map((rule) => new RegExp(rule.pattern, 'u'));

/** Lower case, NFKC, Arabic diacritics and tatweel removed, Arabic letter forms unified, whitespace collapsed. */
export function normalizeForMatch(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(TASHKEEL, '')
    .replace(/[أإآٱ]/gu, 'ا')
    .replace(/ة/gu, 'ه')
    .replace(/ى/gu, 'ي')
    .replace(/ؤ/gu, 'و')
    .replace(/ئ/gu, 'ي')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[.:…]+$/u, '')
    .trim();
}

export interface Masked {
  text: string;
  masked: boolean;
}

/** Replace e-mail addresses, phone numbers, long identifiers and runs of 4+ digits with placeholders, in that order. */
export function maskText(value: string): Masked {
  let text = value;
  for (const rule of MASK_RULES) text = text.replace(rule.pattern, rule.placeholder);
  return { text, masked: text !== value };
}

/** True when `value` still contains something masking would replace. */
export function looksUnmasked(value: string): boolean {
  return UNMASKED.some((pattern) => pattern.test(value));
}

/**
 * The stored form of a URL path. An unmasked path is kept exactly (it stays addressable); a masked one is the
 * masked decoded text, never addressable. Null when the result is longer than the path bound.
 */
export function maskPath(rawPath: string): { path: string; masked: boolean } | null {
  const raw = rawPath || '/';
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // Not valid percent-encoding: mask the raw text.
  }
  const fromDecoded = maskText(decoded);
  const fromRaw = maskText(raw);
  const masked = fromDecoded.masked || fromRaw.masked;
  const path = masked ? fromDecoded.text : raw;
  if (path.length > MAP_LIMITS.pathChars || !path.startsWith('/')) return null;
  return { path, masked };
}

const collapse = (value: string): string => value.replace(/\s+/gu, ' ').trim();

/**
 * A control name as stored, or null when it is empty, too long, or held something masking would replace. The
 * snapshot prints at most `nameChars` characters, so a name of that length may be cut and is skipped too.
 */
export function boundName(name: string): string | null {
  const text = collapse(name);
  if (!text || text.length >= MAP_LIMITS.nameChars) return null;
  return maskText(text).masked ? null : text;
}

/** A page title as stored: masked and cut to the title bound; null when empty. */
export function boundTitle(title: string | null | undefined): string | null {
  if (typeof title !== 'string') return null;
  const text = maskText(collapse(title)).text;
  if (!text) return null;
  return text.length > MAP_LIMITS.titleChars ? `${text.slice(0, MAP_LIMITS.titleChars - 1)}…` : text;
}

const PROCLITICS = [...MAP_ALLOWLIST.arabicProclitics.prefixes].sort((a, b) => b.length - a.length);
const words = (value: string): string[] => normalizeForMatch(value).split(WORD_SPLIT).filter(Boolean);
const PHRASES = [...MAP_ALLOWLIST.dataChanging.en, ...MAP_ALLOWLIST.dataChanging.ar].map(words).filter((phrase) => phrase.length > 0);
const NOT_DATA = new Set([...MAP_ALLOWLIST.notDataChanging.en, ...MAP_ALLOWLIST.notDataChanging.ar].map((name) => words(name).join(' ')));

/** The word, and the word with each proclitic removed that leaves at least 2 letters. */
function wordForms(word: string): string[] {
  const forms = [word];
  for (const prefix of PROCLITICS) {
    if (word.startsWith(prefix) && word.length - prefix.length >= 2) forms.push(word.slice(prefix.length));
  }
  return forms;
}

/** Whether a control name matches the reviewed data-changing vocabulary (FR-015). */
export function isDataChanging(name: string): boolean {
  const nameWords = words(name);
  if (nameWords.length === 0 || NOT_DATA.has(nameWords.join(' '))) return false;
  const forms = nameWords.map(wordForms);
  return PHRASES.some((phrase) => {
    for (let start = 0; start + phrase.length <= forms.length; start += 1) {
      if (phrase.every((word, offset) => forms[start + offset].includes(word))) return true;
    }
    return false;
  });
}

/** Lookup words: normalized, split on whitespace, at most 8. */
export function queryWords(query: string): string[] {
  return normalizeForMatch(query).split(' ').filter(Boolean).slice(0, 8);
}

/** Every word occurs in the normalized haystack. */
export function matchesWords(haystack: string, wanted: readonly string[]): boolean {
  if (wanted.length === 0) return true;
  const text = normalizeForMatch(haystack);
  return wanted.every((word) => text.includes(word));
}

/**
 * A path prefix as stored: decoded (readablePath), starts with "/", is not "/", has no query or fragment and no
 * trailing slash. Null otherwise.
 */
export function canonicalPrefix(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAP_LIMITS.pathChars || !value.startsWith('/') || /[?#\s]/u.test(value)) return null;
  const decoded = readablePath(value);
  if (!decoded.startsWith('/') || /[?#\s]/u.test(decoded)) return null;
  const trimmed = decoded.replace(/\/+$/u, '');
  return trimmed.length >= 2 ? trimmed : null;
}

/** One page's path as the owner names it for a delete: decoded, starts with "/" (the root is allowed), no query or fragment. */
export function canonicalPagePath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAP_LIMITS.pathChars || !value.startsWith('/') || /[?#\s]/u.test(value)) return null;
  const decoded = readablePath(value);
  return decoded.startsWith('/') && !/[?#\s]/u.test(decoded) ? decoded : null;
}

/**
 * A path as a person reads it: percent-decoded when the encoding is valid, in NFC. Stored paths keep the browser's
 * encoding when unmasked and are decoded when masked; owner prefixes are typed decoded. Compare in this form.
 */
export function readablePath(path: string): string {
  try {
    return decodeURIComponent(path).normalize('NFC');
  } catch {
    return path.normalize('NFC');
  }
}

/** Segment-boundary prefix match, ignoring case and percent-encoding: /health covers /health and /health/x, not /healthy. */
export function pathUnderPrefix(path: string, prefix: string): boolean {
  const p = readablePath(path).toLowerCase();
  const q = readablePath(prefix).toLowerCase();
  return p === q || p.startsWith(`${q}/`);
}

/** The same page path, ignoring case and percent-encoding. */
export function samePath(a: string, b: string): boolean {
  return readablePath(a).toLowerCase() === readablePath(b).toLowerCase();
}

/** A control's identity within one page. */
export function controlKey(area: MapArea, role: MapRole, name: string): string {
  return `${area}\n${role}\n${normalizeForMatch(name)}`;
}
