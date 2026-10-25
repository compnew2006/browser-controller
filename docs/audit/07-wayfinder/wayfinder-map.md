# Map — Making real-browser-mcp's structure match its rules

Tracker: local markdown (no issue tracker was configured for this effort). Tickets live beside this
file as `ticket-*.md`; blocking is recorded as `Blocked by:` lines in each ticket body, because local
markdown has no native dependency edges.

Labels: `wayfinder:map` (this file), `wayfinder:grilling`, `wayfinder:research`, `wayfinder:task`.

---

## Destination

A chosen, ordered remediation route that a developer can execute without re-deciding anything: which
duplicate-purpose code gets merged, which 75-member class gets split and in what order, and which
cross-runtime policy becomes single-source — with the trade-off for each already made and written down.

The route itself is already drafted as `06-remediation-phases.md`. This map exists because six of those
steps are not decidable from the code alone: they trade maintainability against build risk, or against
changing tests, or against touching security-critical code with no bug to justify it.

## Notes

- Domain: a two-runtime tool. `mcp-server/` is TypeScript compiled by `tsc`; `extension/` is plain
  JavaScript loaded by Chrome. There is no bundler and no shared package, and the audit assumed no new
  dependencies. Any ticket that implies one is a product decision, not a refactor.
- Constraints that bound every answer here: MV3 service worker (no persistent globals);
  `chrome.scripting.executeScript` serialises the function body (injected code cannot import);
  one process, one writer for the vault; 1,133 tests that must stay green.
- Read first, in this order: `00-overview.md` (what is verified), `05-architecture-analysis.md`
  (F1–F13 and ADR-01…05), `04-duplication-register.md` (merge / parameterise / keep-separate verdicts),
  `06-remediation-phases.md` (the draft route).
- Standing preference: analysis only. No ticket on this map authorises a code edit until the map is
  clear and someone deliberately starts phase 1.
- Skills a session should consult: `architecture-designer` for any ticket that changes a decision
  recorded in `05`; `grilling` and `domain-modeling` for the grilling tickets.

## Decisions so far

<!-- one line per closed ticket; detail lives in the ticket, never here -->

- None yet. All six tickets below are open.

## Not yet specified

- **What phase 5 does to the published contract.** Narrowing 34 exports is safe inside the repository,
  but `llms.txt`, `README.md` and `server.json` may name vault schemas. Whether the fix is "keep those
  nine exports" or "publish them deliberately" can't be phrased until someone looks at the docs surface.
  Hangs on the export-narrowing ticket.
- **Whether `CredentialVaultStore` needs anything at all.** 45 members, complexity 130, and every branch
  is load-bearing. A split might be pure harm. Can't be decided before the vault-composition ticket
  either way, because the answer changes what the facade has to hold.
- **The order between the vault split and the bridge/IPC split.** Both touch `daemon.ts`; doing them in
  the wrong order means rebasing one against the other. Depends on how much appetite the vault ticket
  finds.
- **What "load unpacked" means after a build step.** If page-script bundling is adopted, a developer
  who wants to hack on the extension may lose the no-build workflow. The mitigation (commit the
  generated artefact? a watch task?) can't be phrased until bundling is chosen.
- **Whether the two smoke harnesses are runnable in this checkout at all.** If they are not,
  `npm run smoke:vault-isolated` cannot be the phase-3 gate and something else has to be.

## Out of scope

- **Test-helper deduplication** (`04` D: 9 `executeScript` fakes, 6 storage stubs, 2 `FakeWebSocket`,
  ~200 duplicated lines). Real debt, but touching `tests/` collides with every phase on the route and
  the brief was explicit that tests are not to be modified.
- **Consolidating the intentional cross-runtime duplication** (`04` C: `collect`/`visible`, the two
  `Daemon`/`DaemonClient` validators, extension-vs-daemon origin checks). Defence in depth; merging it
  would remove a safety property, not a duplicate.
- **Rewriting `CredentialVaultStore`.** Its complexity is the security model.
- **Introducing a general bundler or shared package** as a build-system change. Only page-script
  bundling may be considered, and only because injected code physically cannot import.
- **Any change to the vault's on-disk format, key handling, or backup/restore protocol.**

---

## Tickets

| Ticket | Type | Blocked by | Unblocks |
|---|---|---|---|
| [Page scripts: bundle or keep](ticket-page-scripts-bundle-or-keep.md) | grilling | — | phase 7, and the `collect`/`visible` verdict in `04` A6 |
| [Vault service: pay for composition or freeze it](ticket-vault-composition-pay-or-freeze.md) | grilling | — | phase 3 |
| [Can the vault smoke run here](ticket-vault-smoke-runnable.md) | task | — | phase 3 acceptance gate |
| [Origin policy: which side is authoritative](ticket-origin-policy-authority.md) | grilling | — | phase 6 step 3 |
| [Failure messages: one voice or two](ticket-failure-message-voice.md) | grilling | — | phase 6 step 4 |
| [Router placement: move it or document it](ticket-router-placement.md) | grilling | — | phase 2 step 2 |
| [Tool vocabulary: add the cross-runtime assertion](ticket-tool-vocabulary-assertion.md) | grilling | — | phase 6 step 5 |

Frontier (takeable now, nothing blocking): all seven.
