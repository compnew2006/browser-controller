# Audit tooling

The scripts that produced every number in `../`. Nothing here is part of the build, the test suite
or the shipped packages — it is read-only analysis tooling, kept so the numbers can be re-derived
instead of trusted.

| File | What it does |
|---|---|
| `extract2.cjs` | Walks the repository, parses every `.ts`/`.js`/`.mjs` file with `@babel/parser`, and writes `symbols.json`, `modules.json` (the resolved import graph), `dups.json` (function-body fingerprints), `flags.json` and `summary.json` into the output directory. |
| `gen-inventory.cjs` | Renders the four `inventory-*.md` tables from `symbols.json` + `modules.json` + `purposes.json`. |
| `check-cycles.cjs` | DFS over the resolved import graph; prints every cycle and exits non-zero when there is one, so it can be a CI step. |
| `purposes.json` | The hand-written purposes. Key is `file:line`; value is the purpose, written after reading the body. This file wins over a doc comment, because a read body beats a comment. |
| `.gitignore` | Keeps the generated JSON and the regenerated markdown out of git. Only `purposes.json` is tracked. |

## Regenerating

Run from the repository root:

```bash
node docs/audit/tools/extract2.cjs "$PWD" docs/audit/tools   # parse + graph + fingerprints
node docs/audit/tools/gen-inventory.cjs docs/audit           # rebuild the four inventory tables
node docs/audit/tools/check-cycles.cjs                       # exit 0 when the graph is acyclic
```

`extract2.cjs` takes `<repo-root> <output-dir>`. Output defaults to the script's own directory when
the second argument is omitted; `gen-inventory.cjs` reads its inputs from the script's directory and
writes its markdown to `argv[2]` (or beside itself when omitted). That split is deliberate: the
generated data stays gitignored in `tools/`, the markdown lands where it is read.

## What the numbers should be

Baseline at commit `c2b37f6` (branch `codex/001-credential-vault`):

```
files 193 · parseFailures 0 · symbols 2403 (production 1110 / tests 1293)
exactGroups 45 (119 members) · shapeGroups 22 (68 members)
unusedExports 35 · testOnlyExports 53
modules 193 · edges 325 · unresolved 0 · cycles 2
```

The two cycles are both through `mcp-server/src/tools/batch.ts` and are described in
`../05-architecture-analysis.md` (F5). Phase 2 of `../06-remediation-phases.md` must bring that to 0,
which is what `check-cycles.cjs`'s exit code is for.

After phase 1 of the plan, `exactGroups` must drop; after phase 5, `unusedExports` must reach 0.

## Two things to know before trusting the output

1. **`N` means "label, not description".** 391 of the 1,110 production rows have no doc comment and a
   multi-statement body; their purpose is derived from the identifier and printed with `~`. Read the
   body before acting on one. `D`/`R`/`B` rows are safe to quote. The full explanation is in
   `../00-overview.md` §3.
2. **Non-function symbols are not rows.** 98 exported constants and 41 exported `type`/`interface`
   declarations have no inventory row because they are not functions. They are covered by the export
   analysis in `../05-architecture-analysis.md` (F7).

## Dependency note

`extract2.cjs` requires `@babel/parser`. It is **not** a direct dependency: it currently resolves
transitively through `@babel/core` (7.29.9 at the time of the audit). That is fine for a one-off
run and fragile for CI — the honest fix is to add `@babel/parser` to `devDependencies` and pin it,
which is a `package.json` change nobody has approved yet. Until then, if the script fails with
`Cannot find module '@babel/parser'`, that is the cause, and `npm ls @babel/parser` will show what is
actually installed.
