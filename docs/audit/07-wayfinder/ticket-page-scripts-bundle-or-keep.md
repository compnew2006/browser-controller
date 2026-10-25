# Page scripts: bundle or keep

`wayfinder:grilling` · Blocked by: none · Unblocks: phase 7 of the route, and the `04` A6 verdict.

## Question

Do the injected page scripts get a build step so they can be ordinary importable modules, or do they
stay self-contained functions for the life of the project?

## Why this is a decision and not a refactor

`PAGE_DOM_INSTALL` is 904 lines with cognitive complexity 484. `pageLocate` is 225 lines / 152.
`PAGE_FALLBACK_INSTALL` is 166 / 76. The `collect`/`visible` pair inside `extension/lib/vault.js` is
byte-identical duplication. None of that is sloppiness: `chrome.scripting.executeScript` ships the
function body only, so an injected function cannot import and cannot close over module scope. The size
and the duplication are the *absence of a bundler*, and a bundler is a build-system change, not a
refactor. That is why this sits on the map and not in a phase.

## What a session needs to settle

1. Is the "load unpacked, no build" workflow a thing anyone relies on? If yes, what does bundling cost
   them, and is a committed generated artefact an acceptable answer?
2. Does the repo accept a second `tsc` target (or the existing `tsc` compiler API) that emits one IIFE
   string per page script into a generated module? No new dependency is available, so a real bundler
   (esbuild/rollup) is out unless the no-new-dependency rule is reopened — which is a separate question.
3. If bundling is rejected, is the honest answer "document the constraint harder"? The four large
   functions are correct today. Writing the constraint down at each one, plus a `04`-style entry
   forbidding future dedup, is a legitimate outcome — but say so, don't drift into it.
4. If bundling is adopted: which script converts first (the audit suggests `smart-selector`, the
   smallest), and what proves the conversion changed nothing? The existing page-behaviour tests must
   pass **unchanged**; that is the acceptance bar.

## Trade-off to state in the answer

Cost of bundling: a generated artefact in the tree, a build step that can break unpacked-loading, and a
wrapper that must preserve `wedgedError`, the 8 s/7 s vault timeouts, and the failure semantics of each
injected function. Cost of not bundling: four functions that cannot be unit-tested as modules, one
duplication that must never be "fixed", and a 904-line function that every future reader must treat as
untouchable.

## Resolution

<!-- fill on close: the decision, the reason, and what it unblocks or kills -->
