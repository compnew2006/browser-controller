# Vault service: pay for composition or freeze it

`wayfinder:grilling` · Blocked by: none · Unblocks: phase 3 of the route.

## Question

Is the four-file, 75-member inheritance chain that implements the credential vault worth 2–3 days of
high-risk mechanical churn, given that it currently passes every test and has no known bug?

## Why this is the hardest ticket on the map

`VaultServiceCore` (349 lines, 44 members) → `VaultServicePrivate` (+14) → `VaultServiceProtection`
(+12) → `VaultService` (+5). One logical object, ~1,050 lines. The base declares `abstract fillGranted`
at `service-core.ts:359`; the implementation lives three levels down; `service.ts` exists only to be the
non-abstract leaf, i.e. a file whose sole job is to satisfy the type system.

Concrete costs, all verified by reading:

- Every subclass can reach all the base's `protected` maps. There is no seam at which a layer says "I may
  not touch grants".
- The split point is file length, not responsibility. The code that *calls* `settle()` lives in
  `service-private.ts`; `settle()` itself lives in the base — one rule, two files.
- Testing one concern requires constructing the whole chain, because the abstract method forces the top.

Against that: it is the security-critical path. A behaviour change here can lock a user out of their
vault or fill the wrong document. Fail-closed code is exactly the code where a mechanical move can
convert a refusal into an exception that gets swallowed.

## What a session needs to settle

1. **Is there a forcing function?** Nothing in the audit is a bug in this class. If the only answer is
   "it would be nicer", say so and freeze it — a documented freeze with the `04` C reasoning is a real
   outcome, not a cop-out.
2. **If it moves: does the first step hold?** The proposed order is `OperationRegistry` →
   `GrantRegistry` → `RequestJournal` → facade. The first step is the one to judge, because it is the
   cheapest and has no domain knowledge: a map of id → `{abort, done, meta}` with five operations. If
   extracting *that* needs more than ~10 call-site edits, the audit's model of the coupling is wrong and
   the whole plan is wrong. That is the stop rule, and it should be agreed before the first commit.
3. **What proves it did not change behaviour?** The 1,133 tests are necessary and not sufficient. Decide
   the manual vault path that gets walked before and after, in this order: initialise → save → list →
   approve → fill → confirm the page is protected → close the tab → recycle the worker → confirm the
   restored state still refuses fills. If `smoke:vault-isolated` is available it is part of the gate; see
   *Can the vault smoke run here*.
4. **Does `service.ts` get to disappear?** Turning `abstract fillGranted` into an injected strategy is
   what removes it. If that one step is judged too invasive, the chain can shrink without it — but then
   the map should say the leaf file stays.
5. **Is the churn reviewable?** One collaborator per commit, `npm run typecheck` after each, no commit
   touching two collaborators. Agree that a revert of any single commit leaves the tree green.

## Trade-off to state in the answer

Paying: a facade plus three testable registries, `protected` becomes genuinely private, hidden
cross-layer use surfaces as a compile error. That last one is both the benefit and the risk — it can turn
a one-day move into a three-day excavation, and it will happen in the file that must not regress.
Freezing: `protected` leakage stays, `service.ts` stays, and every future vault change keeps paying the
two-file reading cost.

## Resolution

<!-- fill on close: pay or freeze, the agreed first step, the stop rule, the manual gate -->
