# 04 — Duplication register

Every same-purpose cluster found in production code, with a verdict and a proposed home.
Three sections: **mechanical** (found by token fingerprint, then read), **semantic** (found by reading, invisible to the fingerprint), and **look-alikes that must stay**.

Method: 193 files parsed with `@babel/parser`; each function body fingerprinted twice — literal-preserving and identifier-normalised — then grouped. 45 identical groups and 22 same-shape groups across the whole repository; most are in `tests/`. Only groups with at least two **production** members are listed below; test-side duplication is summarised at the end because the plan does not touch tests.

Verdict vocabulary:

- **MERGE** — one implementation, one home, delete the other.
- **PARAMETERISE** — one implementation plus a parameter or manifest entry; the differences are data, not behaviour.
- **KEEP SEPARATE** — the resemblance is accidental, or the two copies exist for a reason that merging would destroy. Write the reason down in the code.

---

## A. Mechanical duplicates (production)

### A1. `isRecord` — identical, 20 tokens — **MERGE**

- `mcp-server/src/vault/daemon-routing.ts:30`
- `mcp-server/src/vault/service-common.ts:123` (already exported)

Both are `value !== null && typeof value === 'object' && !Array.isArray(value)`. Same folder, same meaning, one already exported.
Action: delete the private copy in `daemon-routing.ts`, import from `./service-common.js`. No cycle: `service-common` does not import `daemon-routing`.
Blast radius: 1 file plus its importer. Risk: none. Effort: minutes.

### A2. Timeout racers — `withTimeout`, `bounded`, `settleWithin` — **MERGE into one timing module**

- `extension/handlers/screenshot.js:39` `withTimeout(promise, ms, what)` — reject on timeout, message `<what> timed out`
- `extension/lib/cdp-session.js:23` `bounded(promise, what)` — same code, fixed `SETUP_MS = 5_000`, message `CDP <what> timed out (page not responding)`
- `extension/lib/cdp-session.js:38` `settleWithin(promise, ms)` — same race, but *resolves* with `TIMED_OUT`

`bounded` is literally `withTimeout(promise, SETUP_MS, …)` with a different sentence. Three copies of one idea: race a promise against a timer, always clear the timer, decide reject-or-resolve.
Action: new `extension/lib/timing.js` exporting `raceReject(promise, ms, message)` and `settleWithin(promise, ms)` (moved, with `TIMED_OUT`). `bounded` becomes a two-line wrapper that keeps its message and budget, so call sites do not change.
Blast radius: 2 files, 2 imports. Risk: low — the timer-clearing semantics are identical. Effort: under an hour, tests already cover the CDP path.

### A3. `sleep` / `pause` — identical, 14 tokens, five production copies — **PARAMETERISE (same module as A2)**

- `mcp-server/src/tools/batch.ts:8` `sleep` — daemon runtime
- `extension/handlers/evaluate.js:15` `pause` — extension runtime
- `extension/handlers/inspection.js:31` `pause` — extension runtime
- `extension/lib/trusted-input.js:31` `sleep` — extension runtime
- `scripts/smoke-vault-isolated.mjs:20` `sleep` — Node script

Three copies inside the extension runtime, one inside the daemon runtime, one in a script. Cross-runtime merging is impossible (separate bundles).
Action: `extension/lib/timing.js` also exports `sleep(ms)`; the three extension copies import it. `tools/batch.ts` keeps its local one-line helper (single use in its runtime) or imports a `delay` from a new `mcp-server/src/tools/timing.ts` only if a second daemon-side copy appears. Scripts keep theirs.
Blast radius: 3 files. Risk: none. Effort: 15 minutes.

### A4. `loadOrCreateToken` / `loadOrCreateEnrollment` and `readToken` / `readEnrollmentSecret` — same shape, 122 and 42 tokens — **PARAMETERISE**

- `mcp-server/src/daemon-config.ts:213` and `:255`
- `mcp-server/src/daemon-config.ts:228` and `:270`

The two create-paths differ only in the file path, the field name (`token` vs `secret`) and the type name. The two read-paths differ the same way. Four functions, two operations.
Action: two generic helpers — `loadOrCreateSecret(file, field)` and `readSecret(file, field)` — plus four one-line named wrappers that keep today's call sites and types. Behaviour preserved: 24 random bytes, hex, `0700` dir, `0600` file, `{ [field], createdAt }`, invalid file treated as absent.
Blast radius: 1 file, 4 exported functions. Risk: low, and the fall-back-on-invalid-file semantics are the only subtle part — keep them verbatim. Effort: under an hour.

### A5. `restartManagedDaemon` / `startManagedDaemon` — identical, 27 tokens — **MERGE**

- `scripts/smoke-real-chrome.mjs:97` and `:102`

Two names, byte-identical bodies. One of them is redundant.
Action: keep `restartManagedDaemon` if it is the one call sites use; delete the other. Script-only, no shipped code.
Risk: none. Effort: minutes. (Verify call sites before deleting — the extractor shows the body, not the call graph.)

### A6. `collect` / `collect` and `visible` / `visible` — identical, 69 tokens — **KEEP SEPARATE**

- `extension/lib/vault.js:137` inside `inspectPasswordField`
- `extension/lib/vault.js:180` inside `fillInspectedPassword`

Both functions are serialised by `chrome.scripting.executeScript` and run in the page's isolated world. Chrome ships only the function body — no module scope, no closure over a shared helper. The duplication is the *mechanism* that makes the isolation work. It cannot be hoisted without converting both injections to string bodies or a bundle.
Action: none. The existing comment at `:135` already explains it; extend it to say the duplication with `fillInspectedPassword` is deliberate. This entry exists to stop a future dedup pass.

### A7. `refIssued` / `refIsEarlier` — same shape, 44 tokens — **KEEP SEPARATE**

- `extension/lib/page-dom.js:92` and `:97`

Two four-line predicates over the same ref counter, different questions ("was this ref issued in this tab" vs "was it issued by an earlier document"). Both live inside the injected page script. A shared `isIssued(ref, boundary, comparator)` would be longer than either.
Action: none.

### A8. `call` / `callSecond` — same shape, 29 tokens — **KEEP SEPARATE**

- `scripts/smoke-vault-isolated.mjs:264` and `:358`

A concurrency scenario needs two independent clients; sharing the helper would share the state the scenario is proving. Script-only.
Confidence: shape and names; the bodies were not read line by line. Confirm before acting.

### A9. `assert` / `ensure` across the two smoke scripts — **KEEP SEPARATE**

- `scripts/smoke-real-chrome.mjs:53` `assert`
- `scripts/smoke-vault-isolated.mjs:21` `ensure`

Two standalone harnesses with their own exit codes and output style. Merging them would couple two independent smoke entry points for three lines of code.

### A10. `replacedClause` / `buildSessionId` — same shape, 15 tokens — **KEEP, coincidental**

- `extension/handlers/navigation.js:343` and `mcp-server/src/protocol.ts:21`

Different runtimes, unrelated semantics, identical token shape by accident. Recorded so nobody "fixes" it.

---

## B. Semantic duplicates (found by reading, no token match)

### B1. Origin canonicalisation and origin policy — two implementations, **one policy that already differs** — **PARAMETERISE via shared fixture**

- `mcp-server/src/vault/types.ts:11` `canonicalizeOrigin` — HTTPS only, or HTTP on a loopback list that includes `::ffff:127.0.0.1`; rejects credentials, path, query, fragment; throws `VAULT_ORIGIN_MISMATCH: …`.
- `mcp-server/src/vault/service-core.ts:104` `assertOrigin` — thin wrapper converting the throw into `VaultServiceError`.
- `extension/lib/vault.js:47` `canonicalOrigin` — HTTPS, or HTTP on `localhost` / `127.0.0.1` / `[::1]`; rejects credentials; **allows** path/query/hash (it returns `url.origin` anyway) and does **not** accept `::ffff:127.0.0.1`; throws `VAULT_TARGET_UNSAFE`.

Because both return `url.origin`, the path/query difference changes validation, not output: the daemon never receives a path, because the extension sends an origin.

The real divergence is the loopback host list, and it runs the other way from what symmetry would suggest: `http://[::ffff:127.0.0.1]:8080/` is a fixture the **daemon** is willing to fill and the **extension** refuses, before any request is made. Worse, the extension reports that refusal as `VAULT_TARGET_UNSAFE`, whose sentence is *"The page does not have one verified editable password field"* — so an origin problem reaches the model as a claim about the page's fields. See `05` F13.

Two implementations is correct here (different trust domains, defence in depth — `C` below). What is not correct is that they disagree about the supported set and about the failure code, with nothing to catch it: `VAULT_ORIGIN_MISMATCH` is asserted twice in `tests/`, `VAULT_TARGET_UNSAFE` **nowhere**.

Action: one JSON fixture of origin cases with an expected verdict per runtime, consumed by a test in each, so drift fails CI. Keep the two implementations. See the wayfinder ticket *Origin policy: which side is authoritative*.
Blast radius: 2 new test files, no production change. Risk: none. Effort: half a day.

### B2. Failure-message tables — two maps from the same code vocabulary to different sentences — **PARAMETERISE via fixture, or accept and document**

- `extension/lib/vault.js:33` `safeFailure` — code → user sentence, extension side.
- `mcp-server/src/vault/service-common.ts` `publicError` / `safeMessage` — code → sentence, daemon side.

Both translate `VAULT_TARGET_UNSAFE`, `VAULT_DOCUMENT_CHANGED`, `VAULT_OUTCOME_UNKNOWN`, `VAULT_PERMISSION_DENIED`, `VAULT_RECOVERY_REQUIRED` into prose the agent reads. Two tables means the same failure can reach the model with two different explanations depending on which layer caught it. That is a correctness-of-communication issue for an agent-facing tool, not just tidiness.

And it is worse than a wording difference: `extension/lib/vault.js:596` feeds `VAULT_TARGET_UNSAFE` from a bare `catch`, so *every* throw in inspect and fill is announced as "no verified editable password field". See `05` F13 — the table is being consulted with the wrong key.
Action: if the two tables are meant to say the same thing, add a fixture test asserting every shared code maps to a sentence with the same meaning (or literally the same text); if they are meant to differ (extension text says "reload the page", daemon text says "ask the user"), write that down in a comment in both files. Do **not** merge blindly.

### B3. Wire-protocol contract — duplicated by hand across two runtimes — **PARAMETERISE / generate**

- `mcp-server/src/protocol.ts` — `PROTOCOL_VERSION`, `TOOLS_V3_CAPABILITY`, `CREDENTIAL_VAULT_CAPABILITY`, `EXTENSION_PROTOCOL_CAPABILITIES`, the validators.
- `extension/lib/protocol.js` — the same constants and the mirror-image validator, with the comment *"Keep in sync with mcp-server/src/protocol.ts (guarded by protocol tests)."*

The seam is honest (a comment plus tests), but a comment is not a constraint: adding a capability on one side is a silent failure mode that only a test catches. This is the highest-consequence duplication in the repository because it is the handshake that refuses old peers.
Action: see ADR-01. Minimum viable: a test that parses both files and compares the constant lists. Better: generate `extension/lib/protocol.js` from a single JSON/TS source at build time.

### B4. Three modules named "vault" with three different jobs — **RENAME (navigability, not dedup)**

- `extension/lib/vault.js` (600) — worker-side vault actions and document-protection state.
- `extension/vault/vault.js` (508) — the private UI page (DOM rendering, RPC to the worker).
- `extension/lib/vault-connection.js` (106) — the daemon-channel wrapper used by the UI page.

Plus `extension/vault/vault.html`. Four paths, three files, one word. Every search for "vault" lands on all of them.
Action: `vault-actions.js`, `vault-page.js`, keep `vault-connection.js`. Pure rename plus import updates; no behaviour change. Verify with `npm test` (tests import these paths) and a manifest check (`web_accessible_resources` and the HTML script tag).

### B5. Injected page scripts — large functions that must stay self-contained — **KEEP, with a build-time answer**

- `extension/lib/page-dom.js:25` `PAGE_DOM_INSTALL` (904 lines, complexity 484)
- `extension/utils/smart-selector.js:27` `PAGE_FALLBACK_INSTALL` (166) and `:36` `generateFallback` (153)
- `extension/lib/vault.js:134` / `:177` (the two injected functions in A6)
- `extension/lib/trusted-input.js:43` `pageLocate` (225 lines, complexity 152)

These are strings/functions handed to `chrome.scripting.executeScript`. They cannot import, cannot close over module scope, and cannot be unit-tested as modules. The 904-line function is not sloppy authorship; it is the *absence of a bundler*. See ADR-03: bundle page scripts at build time, then split them.

### B6. Three tab-keyed registries with parallel lifecycle verbs — **KEEP SEPARATE**

- `extension/lib/tab-concurrency.js:16` `TabMutexMap` (serialise calls per tab)
- `:79` `TabLockMap` (exclusive ownership per session)
- `:197` `TabControlMap` (who is acting, for display; lingering)

`release`, `releaseByOwner`, `clear`, `snapshot` appear in two of the three with different semantics: `TabLockMap.releaseByOwner` returns the released ids and is authoritative; `TabControlMap.releaseByOwner` promotes the latest remaining caller and is cosmetic. A shared base class would couple an authority to a display hint — the worst possible coupling in a concurrency module.
Action: none. Add one line to the file header stating the three are deliberately separate registries over the same key space.

### B7. Duplicate-purpose lists that were already fixed — **precedent, not debt**

Two comments in the source record earlier dedup work and are the model for phases 1–2 of the plan:

- `mcp-server/src/tools/types.ts` — `forwardHandler` exists because the forwarding body "was previously copy-pasted across nearly every tool file".
- `mcp-server/src/daemon-config.ts:200` — the hand-maintained idempotent-tool set was removed and derived from the tool registry, because it "silently drifted from the real registry".

Both were the right shape of fix: delete the second source of truth, derive it. The remaining findings in section B are the same disease in different places.

---

## C. Look-alikes that must NOT be merged

Written down so the next dedup pass does not "fix" them:

| Pair | Why not |
|---|---|
| `vault.js` `collect`/`visible` (A6) | Chrome serialises the function body; no shared scope exists. |
| *Correction (2026-10-27, `09` F8-2).* `09` says this duplication is between `PAGE_DOM_INSTALL` and `PAGE_FALLBACK_INSTALL`, and that `inspection.js` calls `D.isVisible` / `D.nameOf` rather than copying them. The calls in `inspection.js` hold. The page-script claim was not reproduced, so this row stands with a new file name: the `collect`/`visible` pair is copied in `extension/lib/vault-actions.js` (`inspectPasswordField` and `fillInspectedPassword`; the file was `vault.js` when A6 was written). Separately, `computeNth` in `PAGE_FALLBACK_INSTALL` (`extension/utils/smart-selector.js`) has its own display/visibility/opacity check that overlaps `isVisible` in `PAGE_DOM_INSTALL`. `09` section 5 is corrected to match. | |
| `PAGE_DOM_INSTALL` vs `PAGE_FALLBACK_INSTALL` | Two independent injected scripts with separate lifecycles and separate injection points. |
| Extension origin checks vs daemon origin checks | Different trust domains. The daemon must not trust the extension's verdict, and vice versa — this is defence in depth, and the same reasoning already governs `tools/fill.ts` and `vault/daemon-routing.ts`. |
| `Daemon` handshake vs `DaemonClient` handshake | Two sides of a wire must validate the peer independently. Only the *plumbing* may be shared (framing, pending table, backoff), never the validation. |
| `VaultServiceCore.settle` vs `TabControlMap.settle` | Same verb, unrelated concepts (request terminal state vs end of display linger). |
| `mcp-server/src/vault/protected-paths.ts` vs extension tab-protection state | One asks "is this a filesystem path inside the vault tree", the other "is this document protected". Different questions, similar words. |

---

## D. Test-side duplication (counted, not planned)

These are the largest identical groups in `tests/`. They are outside the plan because the brief is analysis-only and tests are not to be modified, but they are real: 45 identical groups / 119 members and 22 same-shape groups / 68 members are dominated by test helpers.

| Cluster | Copies |
|---|---|
| `browserReply` | `tests/fill-kinds.test.ts:61`, `tests/v3-input.test.ts:63` |
| `get`/`set` storage stub | 6+ test files |
| `sendCommand` / `emitHeaders` / `emitError` / `emitUpdated` | 3–5 files each |
| `executeScript` fake | 9 test files |
| `FakeWebSocket` | 2 test files |
| `FakeElement`/`FakeDocument` | `tests/helpers/fake-dom.ts` **and** `tests/legacy-ref-registry.test.ts` |
| `FakeNode` | `tests/wp2b-overlay.test.ts` |
| `flush` / `sleep` | 6 test files |

If test work is ever in scope, the shape of the fix is already visible: one `tests/helpers/chrome-fakes.ts` and one `tests/helpers/express-fakes.ts`, imported everywhere. That would remove roughly 200 duplicated test lines. Do not attempt it as part of the production remediation — it would collide with every phase below.
