# 04 — Duplication register

Every same-purpose cluster found in production code, with a verdict and a proposed home.
Three sections: **mechanical** (found by token fingerprint, then read), **semantic** (found by reading, invisible to the fingerprint), and **look-alikes that must stay**.

Method: 333 files parsed with `@babel/parser`; each function body fingerprinted twice — literal-preserving and identifier-normalised — then grouped. 93 identical groups (238 members) and 37 same-shape groups (121 members) across the whole repository; most are in `tests/`. Only groups with at least two **production** members are listed below; test-side duplication is summarised at the end because the plan does not touch tests.

> **خط الأساس (Baseline).** أُعيد قياس كل رقم في هذا السجل بتاريخ 2026-10-31 على `HEAD = 0c0c2ce` ("feat(memory): add form shape facts and hidden-control counter")، أي بعد **78 كوميتًا** عن خط الأساس القديم `c2b37f6` (`git rev-list --count c2b37f6..HEAD` → `78`؛ و`git diff --name-only c2b37f6..HEAD -- mcp-server/src extension` → `128` ملفًا). يوجد **merge قادم من `origin/main` (`532d895`) غير مُثبَّت** في شجرة العمل هذه، فالشجرة المقيسة هي `0c0c2ce` + ذلك الـmerge المُفهرس + تعديلات غير مُفهرسة — وليست كوميتًا نظيفًا. الأرقام هنا أرقام الشجرة الحيّة وقت القياس، لا أرقام كوميت.
>
> **ما الذي غيّره هذا التحديث.** خط الأساس القديم `c2b37f6` (2026-10-26) يسبق نظام الذاكرة بالكامل: `git ls-tree -r --name-only c2b37f6 -- mcp-server/src/memory` يعطي **نتيجة فارغة** — لم يكن المجلد موجودًا. أضيفت 32 ملفًا كلها بين `c2b37f6` و`HEAD`، ومنها 10 ملفات `map-*` هي النصف الثاني من الشوكة (انظر A0). لذلك لم يرَ تمرير البصمة القديم أيًّا من ازدواج الذاكرة/الخريطة، لا لأن البصمة كانت عمياء عنه، بل لأن نصفَي الشوكة لم يكونا موجودين بعد. الأرقام التي لم يمكن إعادة اشتقاقها بنفس الطريقة كُتبت «غير متاح» مع سببها بدل التخمين.

> **حجم الشجرة عند القياس (2026-10-31).** `mcp-server/src`: **102 ملف `.ts`**، **18,483 سطرًا**. `extension`: **58 ملف `.js`**، **13,792 سطرًا** (و7 ملفات غير JS: `manifest.json`، ثلاثة أيقونات، `popup/popup.html`، `vault/vault.css`، `vault/vault.html`). الاختبارات: **156 ملف `*.test.ts`** تحت `tests/`، و**2,225 اختبارًا** (`npx vitest list` يعطي 2,225 سطرًا، لا واحد منها ترويسة). تمرير البصمة نفسه يقرأ **333 ملفًا** (إنتاج 157 + اختبارات 144، بعد استبعاد `docs/`) ويخرج **4,042 رمزًا** (إنتاج 2,078 + اختبارات 1,964) مع **0 فشل تحليل**، و**795 حافة** في رسم الاستيراد.
>
> **دورات الاستيراد ما زالت 2.** `node docs/audit/tools/check-cycles.cjs <out-dir>` يخرج بالرمز 1 ويطبع: `mcp-server/src/tools/types.ts → mcp-server/src/tools/browser-selection.ts → mcp-server/src/tools/types.ts` و`mcp-server/src/memory/queue.ts → mcp-server/src/memory/reconcile.ts → mcp-server/src/memory/queue.ts`. الأولى هي الدورتان القديمتان عبر `tools/batch.ts` وقد حُلّت؛ **الثانية جديدة**: `queue.ts` ↔ `reconcile.ts` داخل نظام الذاكرة، وهي جزء من شوكة A0. عدد التصديرات غير المستخدمة ارتفع من 35 إلى **72**، والتصديرات المستخدمة في الاختبارات فقط من 53 إلى **114** — إشارة أن نظام الذاكرة أضاف سطحًا كبيرًا لم يُستهلك بعد.
>
> **ملاحظة عن إعادة القياس.** أُعيد تشغيل تمرير البصمة ثلاث مرات أثناء التحديث، لأن وكلاء آخرين عدّلوا الشجرة في الوقت نفسه (`mcp-server/src/memory/*`، `mcp-server/src/vault/*`، `mcp-server/src/core/` الجديد، `tests/memory-queue.test.ts`، `.cursor/rules/project.mdc`، `extension/lib/site-context.js`). الأرقام أعلاه هي القياس **الاخير**. الأرقام الجوهرية — وهي موضوع هذا السجل — لم تتغيّر: مجموعات الذاكرة 20 (14 متطابقة + 6 متشابهة الشكل) بـ699 رمزًا، والمجموعات العابرة بين `map-*` وغيره 14 مجموعة بـ530 رمزًا (13 منها الشوكة نفسها = 515 رمزًا)، وكل أرقام أسطر أزواج الشوكة كما هي، والدورتان 2. ما الذي تحرّك هو الإجماليات فقط (333 ملفًا، 4,042 رمزًا، 795 حافة).

Verdict vocabulary:

- **MERGE** — one implementation, one home, delete the other.
- **PARAMETERISE** — one implementation plus a parameter or manifest entry; the differences are data, not behaviour.
- **KEEP SEPARATE** — the resemblance is accidental, or the two copies exist for a reason that merging would destroy. Write the reason down in the code.

---

## A. Mechanical duplicates (production)

### A0. The `memory/` ↔ `map-*` fork — the whole website-memory subsystem shipped twice — **PARAMETERISE (one implementation, two key spaces)** — **Open**

> **أعلى مدخل ازدواج في هذا السجل.** لم يكن في النسخة القديمة (خط الأساس `c2b37f6`) لأن نصفَي الشوكة لم يكونا موجودين؛ أُضيفت بعده بـ78 كوميتًا. أقاسِر مدخل مفرد في هذا السجل يتجاوز 100 رمز مكرَّر.

Two specs shipped as two parallel families inside one directory. Spec 003 (website memory: facts per origin) and spec 004 (site map: pages and controls per origin, per Chrome profile) are the same design with a different key space — 003 keys by `(origin, profile)`, 004 adds a map switch, a profile-scoped counter and a page/control tree. The implementation was written twice, file for file, with the map files carrying a `map-` prefix and the same method names.

**Measured (2026-10-31, `docs/audit/tools/extract2.cjs` against the working tree):** 20 duplicate groups live entirely inside `mcp-server/src/memory/` (14 identical + 6 same-shape), **699 duplicated tokens** in total. **13 of those groups — 515 tokens — pair a `map-*` file with a non-`map-*` file**: that is the fork itself, and it is the largest single duplication in the repository. (The 14th cross-family group, 15 tokens, is a coincidental four-file shape across `extension/handlers/navigation.js`, `mcp-server/src/memory/map-capture.ts`, `mcp-server/src/memory/record-files.ts` and `mcp-server/src/protocol.ts` — not a fork pair, so it is not counted here.)

| Memory side | lines | Map side | lines | Duplicated members (memory line / map line, fingerprint tokens) |
|---|---|---|---|---|
| `mcp-server/src/memory/queue.ts` | 512 | `mcp-server/src/memory/map-queue.ts` | 538 | `settle` (240 / 203, 98) · `drain` (252 / 214, 42) · `heldOrigins` / `heldGroups` (277 / 265, 33) |
| `mcp-server/src/memory/store.ts` | 380 | `mcp-server/src/memory/map-store.ts` | 534 | `warm` (127 / 161, 23) · `serialize` (247 / 339, 37) · `remember` (256 / 348, 70) · `ready` (267 / 410, 47) · `loadUsage` (302 / 447, 48) |
| `mcp-server/src/memory/service.ts` | 596 | `mcp-server/src/memory/map-service.ts` | 436 | `noteError` (224 / 158, 18) · `fail` (481 / 322, 20) |
| `mcp-server/src/memory/policy.ts` | 247 | `mcp-server/src/memory/map-policy.ts` | 289 | `requireOrigin` (158 / 178, 27) · `countQuarantinedPolicies` / `countQuarantinedMapPolicies` (241 / 165, 35) |
| `mcp-server/src/memory/site-record.ts` | 258 | `mcp-server/src/memory/map-record.ts` | 302 | `isTime` (96 / 138, 23) |
| `mcp-server/src/memory/admin.ts` | 104 | `mcp-server/src/memory/map-admin.ts` | 253 | `errorCode` (31) / `mapErrorCode` (83), 17 |
| `mcp-server/src/memory/reconcile.ts` | 159 | `mcp-server/src/memory/map-reconcile.ts` | 458 | لا توجد مجموعة متطابقة؛ الشوكة هنا شكلية لا بصمة |
| `mcp-server/src/memory/allowlist.ts` | 313 | `mcp-server/src/memory/map-allowlist.ts` | 99 | لا توجد مجموعة متطابقة |
| `mcp-server/src/memory/policy-tool-route.ts` | 158 | `mcp-server/src/memory/map-policy-route.ts` | 146 | لا توجد مجموعة متطابقة |
| `mcp-server/src/memory/tool-route.ts` | 114 | `mcp-server/src/memory/map-tool-route.ts` | 63 | لا توجد مجموعة متطابقة |

Seven further duplicate groups sit inside the memory subsystem **without** crossing to the map side, and belong to the same finding:

- `mcp-server/src/memory/outcome-observer.ts:45` `failureCode` ↔ `mcp-server/src/memory/service.ts:116` `failureCode` — 48 tokens
- `mcp-server/src/memory/policy.ts:62` `isTime` ↔ `mcp-server/src/memory/site-record.ts:96` `isTime` — 27 tokens
- `mcp-server/src/memory/policy.ts:17` constructor ↔ `mcp-server/src/memory/site-record.ts:35` constructor — 19 tokens
- `mcp-server/src/memory/site-record.ts:88` `bad` ↔ `mcp-server/src/memory/site-record.ts:92` `full` — 17 tokens
- `mcp-server/src/memory/policy.ts:58` `invalid` ↔ `mcp-server/src/memory/site-record.ts:88` `bad` ↔ `:92` `full` — 17 tokens
- `mcp-server/src/memory/map-policy.ts:51` `isTime` ↔ `mcp-server/src/memory/map-record.ts:138` `isTime` — 23 tokens
- `mcp-server/src/memory/map-output.ts:203` `rankPages` ↔ `mcp-server/src/memory/map-output.ts:204` `rankControls` — 33 tokens

**Why this is the top entry and not a look-alike.** The two sides are not independent subsystems that happen to rhyme: the map re-implements the memory store, queue, policy and service *method for method*, with the same names and the same bodies, differing only in the key and in a few branches. The fingerprint found `settle` byte-identical at 98 tokens, `remember` at 70, `loadUsage` at 48, `ready` at 47 — those are not coincidences of shape, they are copies. A change to `JsonMemoryStore.ready` that fixes a torn-write race leaves `JsonMapStore.ready` with the same bug, silently, because the two are not tested against each other.

**Action.** Extract the shared mechanics into one parameterised core and let the two families supply the key and the policy — `JsonStore<TKey>` with the file layout and the write path, a `Queue<TKey>` with the pending-group lifecycle, and a shared policy reader. The map side then adds only what is genuinely map-specific: the profile-scoped counter, the map switch, the page/control tree. The `map-` prefix becomes a constructor argument rather than a forked file. This is the same shape as the fixes already accepted in A1 and A4: delete the second source of truth, derive it.

Blast radius: 20 files, and the `mcp-server/src/memory/` public surface that `mcp-server/src/tools/memory.ts` and `mcp-server/src/tools/batch.ts` consume. Risk: **medium** — this is behaviour-preserving in principle but touches the persistence and queue paths of a shipped feature, so each step needs its existing tests plus `npm run test:coverage` green before the next. Effort: not one commit; sequence it store → queue → policy → service, one family-move per commit, and keep the `map-*` file as a thin wrapper until the map family is fully migrated. **Owner decision required before any code lands**: this entry changes the shape of a shipped feature (specs 003 and 004), which is beyond an analysis-only audit.

**Evidence.** `node docs/audit/tools/extract2.cjs <repo-root> <out-dir>` → `dups.json`, groups filtered to production members; line numbers and file sizes re-measured on the working tree. `git ls-tree -r --name-only c2b37f6 -- mcp-server/src/memory` → empty; `git diff --name-only --diff-filter=A c2b37f6..HEAD -- mcp-server/src/memory` → 32 files.

### A1. `isRecord` — identical, 20 tokens — **MERGE** — **Done 2026-10-31** — **Moved again 2026-10-31**

- `mcp-server/src/core/guards.ts:23` — **the one copy**, in a new neutral layer shared by both sides (24-line file, imports nothing, so it cannot create a cycle)
- `mcp-server/src/memory/guards.ts` — **deleted**: the memory copy was lifted out of `memory/` into `core/`, because leaving it under `memory/` made the vault layer depend on the memory layer for a check unrelated to either
- `mcp-server/src/vault/service-common.ts` — **no longer exports `isRecord`**; the vault's copy is gone too, and `vault/daemon-routing.ts`, `vault/fill.ts`, `vault/service-core.ts`, `vault/service-private.ts` and `vault/service-protection.ts` import it from `../core/guards.js`
- 18 modules import the single copy: 13 under `mcp-server/src/memory/` (`admin.ts`, `map-policy.ts`, `map-policy-route.ts`, `map-record.ts`, `map-service.ts`, `map-store.ts`, `map-tool-route.ts`, `outcome-observer.ts`, `policy.ts`, `policy-tool-route.ts`, `service.ts`, `site-record.ts`, `tool-route.ts`) and 5 under `mcp-server/src/vault/`

All of them answer the same question with the same body: `typeof value === 'object' && value !== null && !Array.isArray(value)`.
Action: **done, and then generalised**. The first pass kept two copies — the vault's own and a new `memory/guards.ts` — because `memory/` already depends on `vault/` and the direction could not be reversed. Lifting the guard into `core/` removes the constraint instead of working around it: now there is exactly one definition and no layer depends on another for it.
Blast radius: 19 files (one new, one deleted, 18 importers touched). Risk: none — a pure move of a three-line predicate. Effort: minutes.

**Widened 2026-10-31:** the register listed two copies and both were in `vault/`. The `memory/` subsystem carried **eight** more — seven as a local `const` and one as a local `function` — that the fingerprint pass had not reported (they sit in files the pass did not fingerprint, and the two spellings differ in operand order). All nine answered the same question, so a change to one could have left another accepting a shape the rest reject. They now share one file, which imports nothing and so cannot create a cycle.

### A2. Timeout racers — `withTimeout`, `bounded`, `settleWithin` — **MERGE into one timing module** — **Done 2026-10-31**

- `extension/lib/timing.js:18` `raceReject(promise, ms, message)` — the one reject-on-timeout racer (new module)
- `extension/lib/timing.js:34` `settleWithin(promise, ms)` — the one resolve-with-`TIMED_OUT` racer (moved, with `TIMED_OUT` at `:27`)
- `extension/lib/cdp-session.js:27` `bounded(promise, what)` — now a two-line wrapper over `raceReject`, keeping its `SETUP_MS = 5_000` budget and its `CDP <what> timed out (page not responding)` message
- `extension/handlers/screenshot.js:17` — imports `raceReject` from `../lib/timing.js`; its private `withTimeout` is gone

`bounded` was literally `withTimeout(promise, SETUP_MS, …)` with a different sentence. Three copies of one idea: race a promise against a timer, always clear the timer, decide reject-or-resolve. One module now holds that idea.
Action: **done**. `extension/lib/timing.js` (43 lines) exports `raceReject`, `TIMED_OUT`, `settleWithin` and `sleep`.
Blast radius: 2 files, 2 imports. Risk: low — the timer-clearing semantics are identical. Effort: under an hour, tests already cover the CDP path.

### A3. `sleep` / `pause` — identical, 14 tokens, five production copies — **PARAMETERISE (same module as A2)** — **Done 2026-10-31**

- `extension/lib/timing.js:43` `sleep` — the one extension copy (new module)
- `extension/handlers/evaluate.js:10` — imports `sleep` from `../lib/timing.js` (its local `pause` is gone)
- `extension/handlers/inspection.js:10` — imports `sleep` from `../lib/timing.js` (its local `pause` is gone)
- `extension/lib/trusted-input.js:18` — imports `sleep` from `./timing.js` (its local `sleep` is gone)
- `extension/lib/drag-input.js:9`, `extension/handlers/interaction.js:14`, `extension/handlers/interaction-advanced.js:9` — now import the same `sleep`
- `mcp-server/src/tools/batch.ts:20` `sleep` — daemon runtime, kept local (single use in its runtime)
- `scripts/smoke-vault-isolated.mjs:21` `sleep` — Node script, kept

The three extension copies collapsed into one; the daemon copy and the script copy stayed, because cross-runtime merging is impossible (separate bundles) and the daemon has no second caller yet.
Action: **done**.
Blast radius: 3 files. Risk: none. Effort: 15 minutes.

### A4. `loadOrCreateToken` / `loadOrCreateEnrollment` and `readToken` / `readEnrollmentSecret` — same shape, 122 and 42 tokens — **PARAMETERISE** — **Done 2026-10-31**

- `mcp-server/src/daemon-config.ts:432` `loadOrCreateToken` and `:437` `readToken`
- `mcp-server/src/daemon-config.ts:457` `loadOrCreateEnrollment` and `:462` `readEnrollmentSecret`
- the generic helpers they now call: `mcp-server/src/daemon-config.ts:407` `loadOrCreateSecret<T>(file, field)` and `:422` `readSecret(file, field)`

The two create-paths differ only in the file path, the field name (`token` vs `secret`) and the type name. The two read-paths differ the same way. Four functions, two operations.
Action: **done** — two generic helpers, `loadOrCreateSecret(file, field)` and `readSecret(file, field)`, plus four one-line named wrappers that keep today's call sites and types. Behaviour preserved: 24 random bytes, hex, `0700` dir, `0600` file, `{ [field], createdAt }`, invalid file treated as absent.
Blast radius: 1 file, 4 exported functions. Risk: low, and the fall-back-on-invalid-file semantics are the only subtle part — they are kept verbatim. Effort: under an hour.

### A5. `restartManagedDaemon` / `startManagedDaemon` — identical, 27 tokens — **MERGE** — **Open**

- `scripts/smoke-real-chrome.mjs:97` and `:102`

Two names, byte-identical bodies. One of them is redundant. Still present in the current tree: the fingerprint pass still reports this pair as an identical group.
Action: keep `restartManagedDaemon` if it is the one call sites use; delete the other. Script-only, no shipped code.
Risk: none. Effort: minutes. (Verify call sites before deleting — the extractor shows the body, not the call graph.)

### A6. `collect` / `collect` and `visible` / `visible` — identical, 121 tokens — **KEEP SEPARATE**

- `extension/lib/vault-page-scripts.js:11` `inspectPasswordField` — carries its own copy of the helper at `:61`, now named `editableText`
- `extension/lib/vault-page-scripts.js:125` `fillInspectedPassword` — carries the same helper at `:128`, now named `writable`

The two bodies are byte-identical (the fingerprint pass reports them as one identical group of **121 tokens**, `extension/lib/vault-page-scripts.js:61` and `:128`).
Both functions are serialised by `chrome.scripting.executeScript` and run in the page's isolated world. Chrome ships only the function body — no module scope, no closure over a shared helper. The duplication is the *mechanism* that makes the isolation work. It cannot be hoisted without converting both injections to string bodies or a bundle.
Action: none. The existing comment in the file already explains it; extend it to say the duplication with `fillInspectedPassword` is deliberate. This entry exists to stop a future dedup pass.

**Moved and renamed 2026-10-31.** The pair used to live in `extension/lib/vault.js` (`:137` and `:180`), where the helpers were called `collect` and `visible`; the vault module was split and the injected functions now live in `extension/lib/vault-page-scripts.js`, with the helpers renamed `editableText` and `writable`. The duplication itself is unchanged.

### A7. `refIssued` / `refIsEarlier` — same shape, 44 tokens — **KEEP SEPARATE**

- `extension/lib/page-dom.js:102` and `:107`

Two four-line predicates over the same ref counter, different questions ("was this ref issued in this tab" vs "was it issued by an earlier document"). Both live inside the injected page script. A shared `isIssued(ref, boundary, comparator)` would be longer than either.
Action: none.

### A8. `call` / `callSecond` — same shape, 29 tokens — **KEEP SEPARATE**

- `scripts/smoke-vault-isolated.mjs:265` and `:360`

A concurrency scenario needs two independent clients; sharing the helper would share the state the scenario is proving. Script-only.
Confidence: shape and names; the bodies were not read line by line. Confirm before acting.

### A9. `assert` / `ensure` across the two smoke scripts — **KEEP SEPARATE**

- `scripts/smoke-real-chrome.mjs:53` `assert`
- `scripts/smoke-vault-isolated.mjs:23` `ensure`

Two standalone harnesses with their own exit codes and output style. Merging them would couple two independent smoke entry points for three lines of code.

### A10. `replacedClause` / `buildSessionId` — same shape, 15 tokens — **KEEP, coincidental**

- `extension/handlers/navigation.js:359` and `mcp-server/src/protocol.ts:28`

Different runtimes, unrelated semantics, identical token shape by accident. Recorded so nobody "fixes" it.

---

## B. Semantic duplicates (found by reading, no token match)

### B1. Origin canonicalisation and origin policy — two implementations, **one policy that already differs** — **PARAMETERISE via shared fixture**

- `mcp-server/src/vault/types.ts:12` `canonicalizeOrigin` — HTTPS only, or HTTP on a loopback list that includes `::ffff:127.0.0.1`; rejects credentials, path, query, fragment; throws `VAULT_ORIGIN_MISMATCH: …`.
- `mcp-server/src/vault/service-core.ts:180` `assertOrigin` — now a `protected` method on `VaultServiceCore`; it wraps `canonicalizeOrigin` and converts the throw into a `VaultServiceError`.
- `extension/lib/vault-exec.js:38` `canonicalOrigin` — HTTPS, or HTTP on `localhost` / `127.0.0.1` / `[::1]`; rejects credentials; **allows** path/query/hash (it returns `url.origin` anyway) and does **not** accept `::ffff:127.0.0.1`; throws `VAULT_ORIGIN_UNSUPPORTED`.

Because both return `url.origin`, the path/query difference changes validation, not output: the daemon never receives a path, because the extension sends an origin.

The real divergence is the loopback host list, and it runs the other way from what symmetry would suggest: `http://[::ffff:127.0.0.1]:8080/` is a fixture the **daemon** is willing to fill and the **extension** refuses, before any request is made. The extension reports that refusal as `VAULT_ORIGIN_UNSUPPORTED`, whose sentence is *"This page is not a supported vault target: fills work only on HTTPS sites and on loopback HTTP."* — so an origin problem reaches the model as a claim about the *target*, which is closer to the truth than the old `VAULT_TARGET_UNSAFE` wording this entry used to record, but the two runtimes still disagree on the supported set and on the failure code, with nothing to catch it: `VAULT_ORIGIN_MISMATCH` is asserted twice in `tests/`, `VAULT_ORIGIN_UNSUPPORTED` **nowhere**.

Two implementations is correct here (different trust domains, defence in depth — `C` below). What is not correct is that they disagree about the supported set and about the failure code, with nothing to catch it.

Action: one JSON fixture of origin cases with an expected verdict per runtime, consumed by a test in each, so drift fails CI. Keep the two implementations. See the wayfinder ticket *Origin policy: which side is authoritative*.
Blast radius: 2 new test files, no production change. Risk: none. Effort: half a day.

### B2. Failure-message tables — **three** maps from the same code vocabulary to different sentences — **PARAMETERISE via fixture, or accept and document**

- `extension/lib/vault-exec.js:22` `safeFailure` — code → user sentence, extension worker side (11 codes).
- `extension/vault/vault-page.js:34` `explain` — code → user sentence, extension private-UI side (17 codes).
- `mcp-server/src/vault/service-common.ts:192` `publicError` and `:166` `safeMessage` — code → sentence, daemon side.

There are now **three** tables, and the extension carries two of them. The daemon and the extension worker translate `VAULT_TARGET_UNSAFE`, `VAULT_DOCUMENT_CHANGED`, `VAULT_OUTCOME_UNKNOWN`, `VAULT_PERMISSION_DENIED` and `VAULT_RECOVERY_REQUIRED` into prose the agent reads; the private UI page carries a third copy with its own sentences. The same failure therefore reaches the model — or the person — with up to three different explanations depending on which layer caught it. That is a correctness-of-communication issue for an agent-facing tool, not just tidiness.

The two extension tables already disagree about shared codes. `VAULT_PERMISSION_DENIED` is *"The private browser action is no longer valid."* in `vault-exec.js` and *"This request or browser connection is no longer current. Refresh and review the request again."* in `vault-page.js`. `VAULT_DOCUMENT_CHANGED` is *"The page changed before the fill."* versus *"The page changed while the request was open. Start a new request from the current page."* `INVALID_ARGUMENT` is *"The private browser action is invalid."* versus *"Check the form fields and try again. A site address is a host such as example.com, or a full https:// address."* Only `VAULT_TARGET_UNSAFE` and `VAULT_OUTCOME_UNKNOWN` are worded identically in both.

**The old defect in this entry is fixed.** The register previously recorded that `extension/lib/vault.js:596` fed `VAULT_TARGET_UNSAFE` from a bare `catch`, so *every* throw in inspect and fill was announced as "no verified editable password field". The dispatcher now inspects the thrown code before speaking: `extension/lib/vault-actions.js:472-476` matches the thrown message against `/^(VAULT_[A-Z0-9_]+|INVALID_ARGUMENT)$/` and passes the real code through, and the fill path's own `catch` (`extension/lib/vault-actions.js:428-431`) returns `VAULT_OUTCOME_UNKNOWN`, not `VAULT_TARGET_UNSAFE`.

**What still remains.** Two places still fall back to `VAULT_TARGET_UNSAFE` when the injected page script returned no usable code at all: `extension/lib/vault-actions.js:422` and `:456` (`outcome?.code || 'VAULT_TARGET_UNSAFE'`). "The page script answered nothing" is still announced to the model as "the page does not have one verified editable password field". That is the narrower remainder of the old defect, not the old defect itself.

Action: if the tables are meant to say the same thing, add a fixture test asserting every shared code maps to a sentence with the same meaning (or literally the same text) across all three; if they are meant to differ (the private UI page talks to a person, the worker talks to the model), write that down in a comment in each file. Do **not** merge blindly. Either way, the residual `|| 'VAULT_TARGET_UNSAFE'` fallback should get its own code — `VAULT_OUTCOME_UNKNOWN` is already the truthful answer for it.

### B3. Wire-protocol contract — duplicated by hand across two runtimes — **PARAMETERISE / generate**

- `mcp-server/src/protocol.ts` — `PROTOCOL_VERSION`, `TOOLS_V3_CAPABILITY`, `CREDENTIAL_VAULT_CAPABILITY`, `EXTENSION_PROTOCOL_CAPABILITIES`, the validators.
- `extension/lib/protocol.js` — the same constants and the mirror-image validator, with the comment *"Keep in sync with mcp-server/src/protocol.ts (guarded by protocol tests)."*

The seam is honest (a comment plus tests), but a comment is not a constraint: adding a capability on one side is a silent failure mode that only a test catches. This is the highest-consequence duplication in the repository because it is the handshake that refuses old peers.
Action: see the **draft ADR-01 in `docs/audit/05-architecture-analysis.md`** (not a file in `docs/adr/`). Minimum viable: a test that parses both files and compares the constant lists. Better: generate `extension/lib/protocol.js` from a single JSON/TS source at build time.

### B4. The "vault" modules — one word, six files under `lib/` and two under `vault/` — **RENAME (navigability, not dedup)** — **Partly done 2026-10-31**

- `extension/lib/vault-actions.js` (478) — worker-side vault actions and document-protection state.
- `extension/lib/vault-exec.js` (118) — origin canonicalisation, failure sentences, private-tab execution.
- `extension/lib/vault-page-scripts.js` (203) — the two injected page functions (see A6).
- `extension/lib/vault-prompt.js` (114) — the approval card prompt.
- `extension/lib/vault-card.js` (126) — the card's DOM/behaviour helpers.
- `extension/vault/vault-page.js` (585) — the private UI page (DOM rendering, RPC to the worker).
- `extension/vault/vault-card.js` (437) — the card UI.
- `extension/lib/vault-connection.js` (106) — the daemon-channel wrapper used by the UI page.

Plus `extension/vault/vault.html` and `extension/vault/vault.css`. The single file `extension/lib/vault.js` (600) and `extension/vault/vault.js` (508) that this entry originally named were **split** rather than renamed, which fixed the one-name-per-directory problem and created a different one: the word "vault" now appears in eight file names across two directories, and `vault-card.js` exists twice (once under `lib/`, once under `vault/`) with different contents.
Action: the remaining navigation fix is to rename `extension/vault/vault-card.js` (the UI one) so the two `vault-card.js` files no longer collide, and to give the private page a name that is not `vault-page.js` next to a `lib/vault-page-scripts.js`. Pure rename plus import updates; no behaviour change. Verify with `npm test` (tests import these paths) and a manifest check (`web_accessible_resources` and the HTML script tags). **Owner decision required**: renaming a shipped extension's files changes the unpacked-extension workflow.

### B5. Injected page scripts — large functions that must stay self-contained — **KEEP, with a build-time answer**

- `extension/lib/page-dom.js:25` `PAGE_DOM_INSTALL` (970 lines of function body, complexity 529)
- `extension/utils/smart-selector.js:27` `PAGE_FALLBACK_INSTALL` (166) and `:36` `generateFallback` (153)
- `extension/lib/vault-page-scripts.js:11` / `:125` (the two injected functions in A6)
- `extension/lib/trusted-input.js:42` `pageLocate` (216 lines, complexity 151)

These are strings/functions handed to `chrome.scripting.executeScript`. They cannot import, cannot close over module scope, and cannot be unit-tested as modules. The 970-line function is not sloppy authorship; it is the *absence of a bundler*. See the **draft ADR-03 in `docs/audit/05-architecture-analysis.md`** (not a file in `docs/adr/`): bundle page scripts at build time, then split them.

### B6. Three tab-keyed registries with parallel lifecycle verbs — **KEEP SEPARATE**

- `extension/lib/tab-concurrency.js:16` `TabMutexMap` (serialise calls per tab)
- `:79` `TabLockMap` (exclusive ownership per session)
- `:197` `TabControlMap` (who is acting, for display; lingering)

`release`, `releaseByOwner`, `clear`, `snapshot` appear in two of the three with different semantics: `TabLockMap.releaseByOwner` returns the released ids and is authoritative; `TabControlMap.releaseByOwner` promotes the latest remaining caller and is cosmetic. A shared base class would couple an authority to a display hint — the worst possible coupling in a concurrency module.
Action: none. Add one line to the file header stating the three are deliberately separate registries over the same key space.

### B7. Duplicate-purpose lists that were already fixed — **precedent, not debt**

Two comments in the source record earlier dedup work and are the model for phases 1–2 of the plan:

- `mcp-server/src/tools/types.ts:223` `forwardHandler` exists because the forwarding body "was previously copy-pasted across nearly every tool file".
- `mcp-server/src/daemon-config.ts:388` — the hand-maintained idempotent-tool set was removed and derived from the tool registry, because it "silently drifted from the real registry".

Both were the right shape of fix: delete the second source of truth, derive it. The remaining findings in section B are the same disease in different places.

---

## C. Look-alikes that must NOT be merged

Written down so the next dedup pass does not "fix" them:

| Pair | Why not |
|---|---|
| `vault-page-scripts.js` `editableText`/`writable` (A6; was `vault.js` `collect`/`visible`) | Chrome serialises the function body; no shared scope exists. |
| *Correction (2026-10-27, `09` F8-2).* `09` says this duplication is between `PAGE_DOM_INSTALL` and `PAGE_FALLBACK_INSTALL`, and that `inspection.js` calls `D.isVisible` / `D.nameOf` rather than copying them. The calls in `inspection.js` hold. The page-script claim was not reproduced, so this row stands with a new file name: the `collect`/`visible` pair is copied in `extension/lib/vault-actions.js` (`inspectPasswordField` and `fillInspectedPassword`; the file was `vault.js` when A6 was written). Separately, `computeNth` in `PAGE_FALLBACK_INSTALL` (`extension/utils/smart-selector.js`) has its own display/visibility/opacity check that overlaps `isVisible` in `PAGE_DOM_INSTALL`. `09` section 5 is corrected to match. |
| *Updated 2026-10-31.* The vault module was split again after that correction: the two injected functions now live in `extension/lib/vault-page-scripts.js`, and the helper they duplicate is named `editableText` (in `inspectPasswordField`, `:61`) and `writable` (in `fillInspectedPassword`, `:128`) — the same two bodies, byte-identical, now one identical group of 121 tokens. `extension/lib/vault-actions.js` still exists but no longer holds the injected functions. |
| `PAGE_DOM_INSTALL` vs `PAGE_FALLBACK_INSTALL` | Two independent injected scripts with separate lifecycles and separate injection points. |
| Extension origin checks vs daemon origin checks | Different trust domains. The daemon must not trust the extension's verdict, and vice versa — this is defence in depth, and the same reasoning already governs `tools/fill.ts` and `vault/daemon-routing.ts`. |
| `Daemon` handshake vs `DaemonClient` handshake | Two sides of a wire must validate the peer independently. Only the *plumbing* may be shared (framing, pending table, backoff), never the validation. |
| `VaultServiceCore.settle` vs `TabControlMap.settle` | Same verb, unrelated concepts (request terminal state vs end of display linger). |
| `mcp-server/src/vault/protected-paths.ts` vs extension tab-protection state | One asks "is this a filesystem path inside the vault tree", the other "is this document protected". Different questions, similar words. |
| `mcp-server/src/memory/queue.ts` vs `map-queue.ts` (and the store/service/policy pairs) | **Not** a look-alike — this is A0, the fork, and it is real duplication that must be parameterised. Listed here only to mark the contrast: the entries above are resemblance without shared behaviour, A0 is shared behaviour without a shared implementation. |

---

## D. Test-side duplication (counted, not planned)

These are the largest identical groups in `tests/`. They are outside the plan because the brief is analysis-only and tests are not to be modified, but they are real: **93 identical groups / 238 members** and **37 same-shape groups / 121 members** are dominated by test helpers. Counting only groups with at least two test-side members, **86 groups carry 251 test members**; 44 groups carry 101 production members. The test side is now larger than the production side on both counts.

| Cluster | Copies | Where |
|---|---|---|
| `executeScript` fake | 9 test files | `extension-inspect`, `page-dom`, `v3-read`, `v3-target`, `wp1-find-snapshot`, `wp2a-click-actionability`, `wp2a-input-paths`, `wp2b-drag-fill`, `wpf1-controls` — one identical group, 21 tokens |
| `inputs` fake | 6 test files | `extension-dispatch-fingerprint`, `fill-kinds`, `input-aim`, `trusted-input`, `wp2a-click-actionability`, `wp2b-drag-fill` — 17 tokens |
| `text` / `textOf` fake | 5 test files | `action-safety-gate`, `action-stability`, `fill`, `session-policy`, `wait-stable` — 26 tokens |
| `sendCommand` fake | 5 test files | `trusted-input`, `wp2a-click-actionability`, `wp2a-input-paths`, `wp2b-drag-fill`, `wpf1-controls` — 17 tokens |
| `stackAt` fake | 5 test files | `extension-dispatch-fingerprint`, `fill-kinds`, `v3-input`, `wp2a-click-actionability`, `wpf1-controls` — 15 tokens |
| `flush` fake | 5 test files | `extension-native-pairing`, `extension-state-load-failure`, `v3-session-load`, `v3-tabs`, `wp6-extension-daemon-instance` — 14 tokens |
| `freePort` helper | 4 test files | `memory-admin`, `memory-daemon-integration`, `memory-daemon`, `memory-privacy` — 77 tokens (the largest test-side group by size) |
| `get` / `set` storage stub | 4 test files | `extension-evaluate`, `extension-session-roster`, `extension-shield`, `wp3-evaluate` — 33 tokens |
| `connection` fake | 4 test files | `memory-admin`, `memory-privacy`, `memory-shape-privacy` — 18 tokens |
| `flush` / `sleep` | 4 test files | `extension-fieldreport`, `extension-session-roster`, `extension-shield`, `tab-concurrency` — 14 tokens |
| `browserReply` | 2 test files | `tests/fill-kinds.test.ts:61`, `tests/v3-input.test.ts:63` |
| `httpResponse` / `response` fake | 3 test files | `extension-connection-handshake`, `extension-daemon-auth`, `extension-native-pairing` — 62 tokens |
| `clientFor` / `clientWith` / `connect` | 3 test files | `agent-friendly-params`, `session-policy`, `wp4-mcp-tools` — 81 tokens |

**Class-body duplication is not in the counts above.** The fingerprint groups *function* bodies; a class is fingerprinted as one token. `FakeElement` and `FakeDocument` are therefore re-implemented in three files and never appear as a group: `tests/helpers/fake-dom.ts` (`FakeElement` 1,165 tokens, `FakeDocument` 339), `tests/legacy-ref-registry.test.ts` (`FakeElement` 275, `FakeDocument` 99) and `tests/wp2b-overlay.test.ts` (`FakeDocument` 91, plus its own `FakeNode` 181). The largest single duplicated test body in the repository is `FakeElement` at 1,165 tokens, and the group counts understate the test-side total by that much and more.

The three largest by token count are all *setup* helpers, not assertions: `clientFor`/`clientWith`/`connect` (81 tokens), `freePort` (77) and `httpResponse`/`response` (62). The duplication is in how a test builds its world, not in what it asserts — which is why it is cheap to fix and why nobody has fixed it.

If test work is ever in scope, the shape of the fix is already visible: one `tests/helpers/chrome-fakes.ts` and one `tests/helpers/express-fakes.ts`, imported everywhere. That would remove roughly 200 duplicated test lines. Do not attempt it as part of the production remediation — it would collide with every phase below.

**Method note.** Every number in this section comes from the same fingerprint pass as section A: `node docs/audit/tools/extract2.cjs <repo-root> <out-dir>`, then grouping `dups.json` members by whether their file is under `tests/`. Test **file** count is 156 (`*.test.ts` under `tests/`) and the test **count** is 2,225 (`npx vitest list`, 2,225 lines, none of them a header).
