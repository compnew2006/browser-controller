import { controlFact, languageFact, loginFact, searchFact, type CandidateFact } from './allowlist.js';

export const MAX_CANDIDATES = 64;

const SNAPSHOT_LINE = /^(\s*)(?:-\s+)?([a-z]+) "([^"\n]*)"(?:\s|$)/u;

/**
 * Candidate facts from snapshot lines `<role> "<name>"`. A line counts only when its role and whole name are
 * on the allowlist; nothing is truncated. The extension's snapshot names a cross-origin frame as a single
 * leaf line `iframe "cross-origin <origin>"` and never walks it, so none of its content is attributed to the
 * page; a same-origin frame is walked without a marker line, and its controls belong to the same origin as
 * the page. An `iframe` line never matches an allowlisted role, so it is ignored like any other line.
 */
export function extractSnapshotFacts(text: string): CandidateFact[] {
  const found = new Map<string, CandidateFact>();
  for (const line of text.split('\n')) {
    const match = SNAPSHOT_LINE.exec(line);
    if (!match) continue;
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
