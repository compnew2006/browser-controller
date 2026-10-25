# real-browser-mcp — function-by-function inventory and architecture remediation guide

Audit only: no source file was created, modified or deleted. This bundle is the only addition, and it lands in a docs-only commit limited to `docs/audit/**`.
Baseline: branch `codex/001-credential-vault`, commit `c2b37f6` (`refactor(vault): settle private requests through one helper`).
Pre-existing uncommitted changes at the time of the audit, deliberately untouched: `.codebase-memory/artifact.json`, `.codebase-memory/graph.db.zst`.

---

## 1. What is in this bundle

| File | Contents |
|---|---|
| `00-overview.md` | This file: method, coverage, how to read the evidence marks, what is verified and what is not. |
| `inventory-mcp-server.md` | 351 production symbols in 32 files: the MCP server process (tool surface, extension bridge, daemon client, credential vault). |
| `inventory-extension.md` | 686 production symbols in 44 files: the Chrome extension (service worker, handlers, page scripts, popup, vault page). |
| `inventory-scripts-agent-config.md` | 73 production symbols in 6 files: operator scripts, smoke harnesses, MCP client installers. |
| `inventory-tests.md` | 82 test files, 1,293 test-side symbols, at file level. Tests are counted, not analysed, and are out of scope for the plan. |
| `04-duplication-register.md` | Every same-purpose cluster found, split into mechanical duplicates, semantic duplicates, and look-alikes that must **not** be merged. |
| `05-architecture-analysis.md` | Requirements, layer map, findings F1–F13, ADR drafts, risk register (architecture-designer framing). |
| `06-remediation-phases.md` | The ordered remediation plan: P0–P6 plus a conditional P7, each with scope, steps, acceptance checks, blast radius, rollback. |
| `07-wayfinder/` | `wayfinder-map.md` (destination, notes, fog, out of scope) plus 7 decision tickets: page-script bundling, vault composition, vault smoke availability, origin-policy authority, failure-message voice, router placement, tool-vocabulary assertion. These are the steps in `06` that cannot be decided from the code alone. |
| `tools/` | The extractor that produced every number here, plus a README that says how to re-run it. Regeneration writes its JSON into `tools/` (gitignored) and its markdown into this directory. |

Numbering starts at `04` because the four `inventory-*.md` files occupy the place of 01–04. Nothing is missing: `04` onward are referenced by number from inside each other, so they keep their original numbers.

## 2. Coverage

- 193 source files parsed (`vitest.config.ts`, `eslint.config.js`, `mcp-server/src`, `extension`, `scripts`, `agent-config`, `tests`); 0 parse failures.
- 2,403 symbols total = **1,110 production** + 1,293 test-side.
- Every one of the 1,110 production symbols appears exactly once in an inventory table. Verified by row count against the extractor output (`production rows written: 1110 of 1110`).
- Symbols counted: named functions, arrow/function assignments, object-literal functions, class declarations, and every class member (method, constructor, getter, setter, property-function). Anonymous inline callbacks are not separate rows; they are counted inside their owner.
- **Not counted, and therefore not rows:** module-level non-function bindings (constants, literal tables, schema objects) and exported type/interface declarations. Measured to be honest about the gap: **98 exported non-function constants and 41 exported type/interface declarations** have no inventory row. They are not invisible — the export analysis in `05` F7 covers them (that is where `VAULT_MAX_ENTRIES`, `RESPONSE_WAIT_MS`, `toolManifest` and friends are discussed) — but they are not described function-by-function, because they are not functions.
- Import graph: 325 relative import edges, **100% resolved** (TypeScript `.js` → `.ts` mapping included), 193 modules. Two import cycles exist in production code and are named in `05` (F5).

## 3. How to read the purpose column

Documentation quality in this repository is unusual: 500 of 1,110 production symbols carry a doc comment, often a good one. The rest do not. Inventing a purpose for those would make the guide untrustworthy, so each row carries its provenance:

| Mark | Meaning | Rows |
|---|---|---:|
| `D` | Purpose quoted from the doc comment in the source. Trust it. | 467 |
| `R` | Purpose written after reading the body (vault store, vault service core, `extension/lib/vault.js`, `tab-concurrency.js`). Trust it. | 127 |
| `B` | No doc comment, and the whole body is the quoted line. Trust the quote; the summary is the code itself. | 125 |
| `N` | No doc comment, multi-statement body, purpose derived from the identifier only. Shown with `~`. **This is a label, not a verified description** — read the body before acting on it. | 391 |

`D` + `R` + `B` + `N` = 1,110. `D` is 467 rather than 500 because 33 of the 127 hand-read rows also had a doc comment, and a read body beats a comment.

`N` rows are concentrated (measured, not guessed):

| `N` rows | File |
|---:|---|
| 22 | `extension/lib/page-dom.js` |
| 22 | `extension/vault/vault.js` |
| 15 | `scripts/smoke-vault-isolated.mjs` |
| 14 | `scripts/smoke-real-chrome.mjs` |
| 13 | `mcp-server/src/bridge.ts` |
| 13 | `mcp-server/src/daemon.ts` |
| 13 | `mcp-server/src/vault/service-private.ts` |
| 12 | `extension/handlers/inspection.js` |
| 12 | `extension/handlers/logs.js` |
| 12 | `extension/lib/connection.js` |

Any refactor that touches those files must start from the source, not from this table.

## 4. What is verified, and what is not

Verified by running commands in this checkout:

- symbol counts, file counts, line counts, class member counts;
- the 325-edge import graph and the two cycles (DFS over resolved edges);
- mechanical duplicate groups (token-stream fingerprint, identical and same-shape);
- "unused export" classification, corrected by hand into *truly dead* (1) vs *used only inside its own file* (34);
- the duplication claims in `04` that carry an `R` mark — those bodies were read line by line.

Not verified:

- runtime behaviour of anything. This audit reads code; it never executed a browser, a daemon or a vault operation.
- The `N` purpose labels (see above).
- Whether an unused export is unused in *documentation* (`llms.txt`, `README.md`, tool schemas) rather than in code. `mcp-server/src/vault/types.ts` exports such as `VaultGrantSchema` may be referenced by generated docs; check before deleting.
- Token-fingerprint duplicates are *shape* evidence. Every one is listed with a verdict that was reached by reading both bodies, but a future edit could invalidate a verdict without changing the shape.

## 5. Verification baseline for any remediation work

Recorded here so later phases can prove they did not regress anything:

```
npm run typecheck        # clean at c2b37f6
npx eslint <files>       # clean at c2b37f6
npm test                 # 89 test files, 1,133 tests, all passing at c2b37f6
```

Any phase in `06` must be verified with at least `npm run typecheck` + `npm test`, and with `npx eslint` on the touched files.
