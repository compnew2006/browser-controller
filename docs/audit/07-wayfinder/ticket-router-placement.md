# Router placement: move it or document it

`wayfinder:grilling` · Blocked by: none · Unblocks: phase 2 step 2 of the route.

## Question

`extension/lib/router.js` is the composition root but sits in the leaf layer. Move it to
`extension/dispatch/router.js`, or keep it and write the exception down?

## Why the placement is wrong, and why "cycle" is the wrong word

Measured from the resolved import graph: 12 of the 13 `lib → handlers` edges come from `router.js`; every
other module in `lib/` is *below* the handlers (`state`, `page-exec`, `cdp-session`, `target`,
`ref-errors`). At directory level that looks like a cycle. It is not a logic cycle — `router.js` is the
dispatcher, i.e. the composition root, and the handlers are leaves. DFS over the whole graph finds
exactly two cycles in production code, both through `mcp-server/src/tools/batch.ts`, and neither is here.

So this is a naming/reading problem, not a correctness problem: a reader who trusts directory names
concludes "lib depends on handlers", which is backwards for the other 24 files in `lib/`.

## What a session needs to settle

1. Are tests allowed to be edited for a pure rename? `tests/` import `lib/router.js` (e.g.
   `tests/extension-router.test.ts`). If the answer is no, the move is off the table and the ticket
   resolves to "document the exception at the top of the file" — which is a perfectly good outcome, and
   cheaper. This is the gate question; answer it first.
2. If tests may change: do `manifest.json`, `background.js` or `web_accessible_resources` name the path?
   `web_accessible_resources` lists directories, so the risk is low, but the unpacked extension has to be
   reloaded once and a private vault page opened to confirm nothing broke.
3. Is `extension/dispatch/` the right name, or does `extension/router.js` (one file at the root) read
   better? Root placement makes "this is the entry, not a library" obvious; a directory future-proofs for
   a second dispatch file. Pick one and say why.
4. The rename must be one commit with no other change, so a reviewer can confirm it is a pure move.

## Trade-off to state in the answer

Moving: `lib/` becomes honestly a leaf layer, and "everything in lib is below the handlers" stops being
something a reader has to know. Cost: ~14 import paths, one test file, one manual reload, and a diff that
touches nothing but strings — which is exactly the kind of diff that gets rubber-stamped and hides a
mistake. Documenting: zero risk, and the directory keeps a lie that every new contributor has to be told.

## Resolution

<!-- fill on close: whether tests may move, where router.js lives, which commit shape -->
