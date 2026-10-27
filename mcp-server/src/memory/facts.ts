import { controlFact, languageFact, loginFact, searchFact, type CandidateFact } from './allowlist.js';

export const MAX_CANDIDATES = 64;

const SNAPSHOT_LINE = /^(\s*)(?:-\s+)?([a-z]+) "([^"\n]*)"(?:\s|$)/u;
const FRAME_ROLES: ReadonlySet<string> = new Set(['iframe', 'frame']);

/**
 * Candidate facts from snapshot lines `<role> "<name>"`. A line counts only when its role and whole name are
 * on the allowlist; nothing is truncated. Lines nested under a frame are skipped: the snapshot walks only
 * same-origin frames, but a frame's content is never attributed to the top-level page.
 */
export function extractSnapshotFacts(text: string): CandidateFact[] {
  const found = new Map<string, CandidateFact>();
  let frameIndent: number | null = null;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const indent = /^\s*/u.exec(line)?.[0].length ?? 0;
    if (frameIndent !== null) {
      if (indent > frameIndent) continue;
      frameIndent = null;
    }
    const match = SNAPSHOT_LINE.exec(line);
    if (!match) continue;
    if (FRAME_ROLES.has(match[2])) {
      frameIndent = indent;
      continue;
    }
    const fact = searchFact(match[2], match[3]) ?? controlFact(match[2], match[3]);
    if (fact && !found.has(fact.factId)) found.set(fact.factId, fact);
    if (found.size >= MAX_CANDIDATES) break;
  }
  return [...found.values()];
}

export interface FactSources {
  /** The snapshot or navigate result text, if the call returned one. */
  text: string | null;
  lang: string | null;
  dir: string | null;
  passwordField: boolean;
  /** The page path from the verified scope; never a query or fragment. */
  path: string;
}

/** `site.language`, `ui.login` and the snapshot facts for one verified page read, at most 64, one per identity. */
export function collectFacts(sources: FactSources): CandidateFact[] {
  const facts = new Map<string, CandidateFact>();
  const add = (fact: CandidateFact | null) => {
    if (fact && !facts.has(fact.factId)) facts.set(fact.factId, fact);
  };
  add(languageFact(sources.lang, sources.dir));
  add(loginFact(sources.passwordField, sources.path));
  if (sources.text !== null) for (const fact of extractSnapshotFacts(sources.text)) add(fact);
  return [...facts.values()].slice(0, MAX_CANDIDATES);
}
