# Feature Specification: form shape facts

**Feature Branch**: Not created; specification is in the current checkout.

**Created**: 2026-10-31

**Status**: Ready for planning under the defaults stated below. The clarification round of 2026-10-31 resolved the five ambiguities listed in Clarifications; a source check the same day found three places where the spec could not work as written (C6, C7, C8) and corrected them. Two owner decisions (OD-1, OD-2) remain open and change FR-004 and SC-003 only. The proposed vocabulary is in [contracts/interaction-vocabulary.json](contracts/interaction-vocabulary.json) for owner review; nothing is implemented until it is approved.

**Phase outputs**: [research.md](research.md) (the findings R-01..R-18 and the rules D-01..D-10), [data-model.md](data-model.md), [quickstart.md](quickstart.md), [plan.md](plan.md), [tasks.md](tasks.md), and the review checklist [checklists/form-shape-quality.md](checklists/form-shape-quality.md).

**Input**: User description: "أكتب المواصفة كاملة (spec + plan + tasks + قائمة المفردات المقترحة) قبل أي سطر كود"

English summary of the input: write the full specification (spec, plan, tasks and the proposed vocabulary list) before any line of code.

**Builds on**: [003 website memory](../003-website-agent-memory/spec.md). Every 003 rule on the fact store, the reviewed vocabulary, the anonymity gate, the untrusted-hints label, the per-site bounds, the deletion, the export and the local-only rule applies unchanged unless a requirement below says otherwise. The site map ([004](../004-site-navigation-map/spec.md), [005](../005-direct-site-routing/spec.md)) is not touched by this feature.

**Baseline**: `972de04` on `main` (website memory 003, site map 004/005, and the browser improvements of `67dde6b`).

**Risk tier**: CONTROLLED — it changes what is stored and adds a fact kind, so it needs approved contracts, acceptance tests and an independent review before merge.

## Evidence that motivated this feature (2026-10-31)

Measured live against the running Browser Controller 3.1.1 (MCP → daemon → extension) in Chrome profile `7cd0f4d8a153`:

- **E1**: On `https://demo.playwright.dev/todomvc` a todo's checkbox is drawn with `opacity: 0`. `browser_click {target: ".todo-list input.toggle"}` fails with `ELEMENT_HIDDEN: .todo-list input.toggle matches only hidden elements`. The action has to be redone with `browser_evaluate` — on every visit. The control is invisible, so it never appears in a snapshot, so neither the website memory nor the site map can hold it. The same failure was measured twice, in two independent runs.
- **E2**: The same site keeps its todos in `localStorage`, so the anonymity probe reports it as not anonymous. Its website-memory entry holds only `visits: 2` and no facts at all — including no hint that its primary control is invisible. Under 003's gate, an app-like site is exactly the site that gets the least help.
- **E3**: Two guesses about a form's fields are made from the markup, and the site's own structure is part of neither. The credential vault's sign-in fill "writes the saved username into the one username field of the same form, then the password. With several fields that look like a username, the password goes alone" (`browser_vault`'s fill). The agent's own `browser_fill` takes the targets it is given (`fields: [{target, value}]`) and picks them from the names the snapshot shows, so a field the snapshot never shows is not in its plan at all. The site knows the answer; the agent does not.
- **E4**: In benchmark v2 a false `EXPECTATION_FAILED` cost 41 seconds of retry. A wrong guess about a form is the same class of cost.
- **E5**: The tools show the agent what it cannot otherwise know: a snapshot lists controls with their roles and names, but not whether a field is required, whether it is a password field, whether it is visible, or how the form commits. `siteContext` reports `passwordField` as a page-level boolean and nothing else about forms.

## Clarifications

### Owner decisions, still open

- **OD-1 — How far do the new facts reach?** The anonymity gate (003) keeps every fact out of a site that looks signed-in. The shape fact carries no names, no values and no labels, only counts and closed-vocabulary words.
  - Option 1 (**recommended for the first slice**): the gate applies to the **shape fact** as well. The feature then helps the sites 003 already describes (cookie-free public sites) and the app-like site of E2 waits for a later decision. The hidden-control counter is outside the gate either way (C6): it holds no page content and counts one profile's own failures, so it is the one part of this feature that still reaches the sites where agents actually fail.
  - Option 2 (needs an explicit owner approval, a separate privacy test and a line in `SECURITY.md`): the shape fact is stored for every in-scope site, and the gate keeps protecting only the named facts (`ui.control` names, `ui.search` name, `ui.login` path). The cost is that the shape of a signed-in site's forms (how many fields, whether one is a password) becomes readable by the agent.
  - This specification is written for **Option 1**. Option 2 changes FR-004 and SC-003 and nothing else.
- **OD-2 — When the shape becomes available.** The shape of a form cannot be read from a snapshot; it needs the extension's own probe, which means the extension in the profile must be updated and reloaded by the owner. Until then, only the daemon-side fact (FR-003) exists. The feature is therefore specified to work **partially from the start**: an extension that does not send the new block produces no shape fact and no error.

### Clarification round, 2026-10-31 (`speckit.clarify 007`)

The spec was scanned for ambiguity and five points were put to the owner. The answers are binding on the requirements below.

- **C1 — Who reads the shape fact**: the **agent** reads it, from the navigate reminder and from `browser_memory`. No tool changes its behaviour: `browser_fill` keeps its own heuristics, and no tool becomes dependent on stored state.
- **C2 — The hidden-control counter's scope**: **per browser profile**, next to the visit counter, not among the shared facts. It counts a profile's own activity, and one profile's failures never appear in another profile's record.
- **C3 — Which form is measured**: the form **inside the `main` landmark** only. A form in the header, the sidebar or the footer is not measured, so a small search box never stands in for the page's real form.
- **C4 — The commit mode**: **observed, never inferred from the markup**. The extension does not report it; the daemon learns it from what an action actually did on that path, and it stays `unknown` until it is seen. A guessed commit mode could send the agent's Enter into a form that needed a button, and lose what it typed.
- **C5 — Staleness**: **no new marker**. The facts keep their observation times as in 003; this feature adds no "may be outdated" label and no expiry. A staleness marker stays a separate, later decision.

### Corrections found by reading the source (2026-10-31, binding)

The five answers above were given against the spec. Reading the code behind them found three places where the spec as written could not work, or would work against its own purpose. These three are corrections, not new choices, and they bind the requirements below.

- **C6 — The hidden-control counter is not behind the anonymity gate.** The gate is applied where facts are collected: `mcp-server/src/memory/service.ts` returns unless `scope.anonymous === true`, while a visit is enqueued *before* that check. A site that keeps anything in `localStorage` or `sessionStorage` reports `anonymous: false` (the extension's probe in `extension/lib/site-context.js`), so under the gate such a site holds no facts at all — the site of E1 and E2 among them. If the counter were gated like a fact, it could never rise there, and User Story 2 would be dead on the one site that was measured. The counter therefore follows the **visit** rule: it counts one profile's own failed actions, holds no page content, and 003 already stores a per-profile counter (the visits) on exactly those sites. The anonymity gate still decides the **shape fact** (OD-1).
- **C7 — A failed action is attributed through the last observed read of its tab.** A failed call carries no `siteContext` and no observation: `mcp-server/src/vault/daemon-routing.ts` returns an observation only for a successful call, and the memory service's capture path needs one. The daemon cannot ask the page which site was hit. The site map already answers this question with a tab cache of its own and a 120-second window (`mcp-server/src/memory/map-capture.ts`); the memory service needs the same kind of cache, filled by its own successful reads. Without it a counter has no origin to be counted against.
- **C8 — The commit mode is read from what the action's result already says.** The extension's click and type handlers report a navigation when the address changed inside their settle window (`extension/handlers/interaction.js` puts `navigated` in the tool result), so the daemon can read the commit from the result it already has — no new capability and no new observation. What a write did *not* move proves nothing: a rejected value, an inline error and a commit without a navigation all look the same. The mode is therefore a **positive observation or nothing**, and `none` is not a value: the vocabulary is `unknown`, `enter`, `button`.

### Defaults chosen without asking

- The shape is stored **per page path**, and only when every segment of the path is on the reviewed `pathSegments` list (003's rule for `ui.login`). A site-wide number would be misleading, so a page whose path is not allowlisted gets no shape fact.
- The shape is stored per origin, not per profile, like every other 003 fact: it describes the site, not the reader. The verification time and the profile that verified it are shown as in 003. The hidden-control counter is the exception (C2), because it counts activity.
- The hidden-control counter counts **occurrences**, not distinct controls: the daemon never stores the target of a failed action, so it cannot deduplicate by target.
- At most 8 shape facts per site; the site's 64-fact bound and 64 KiB file bound apply unchanged.
- The agent-facing wording is fixed words only, in English and Arabic, like the rest of 003's output.
- The hidden-control counter follows the visit rule, not the fact rule: it is counted for a site whose probe reports `anonymous: false` (C6), and it goes with the origin like every other record.
- The commit mode is one of `unknown`, `enter`, `button` (C8). `none` is not a value: nothing observed proves that a form never commits.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Know a site's form before filling it (Priority: P1)

An agent opens a site's sign-in page. The site's memory says the form has three fields, one of them a password field, one required, and it commits on Enter. The agent fills it in one attempt instead of typing into the wrong field and reading the page again.

**Why this priority**: It removes a guessing round-trip per form, and the guessing is what costs calls and wrong actions (E3, E4).

**Independent Test**: In a synthetic site with a three-field form (one required, one password, one visually hidden), read the page once; then a new session's lookup of the site returns one shape fact that names the field count, the required count, the password field and the hidden field, and no label or value.

**Acceptance Scenarios**:

1. **Given** an in-scope page with a form inside `main` and an extension that reports its shape, **When** the page is read completely, **Then** the site's memory holds one shape fact for that path, the agent's lookup shows it, and the fact's commit mode is `unknown` until a write is observed.
2. **Given** a page whose path holds a segment that is not on the reviewed path list, **When** it is read completely, **Then** no shape fact is stored for it.
3. **Given** a page with no form inside `main` (a form only in the header, the sidebar or the footer), **When** it is read completely, **Then** no shape fact is stored.
4. **Given** a page read in a scoped, truncated, failed or excluded read, **When** the read ends, **Then** no shape fact is stored.
5. **Given** an extension that does not report a shape, **When** the page is read, **Then** the read succeeds and no shape fact is stored.
6. **Given** the agent wrote to the measured form with Enter and the address changed, **When** the site's memory is read again, **Then** the path's shape fact reports the commit mode `enter`, and it reports nothing about which action was used.

---

### User Story 2 - Know that a control on this site cannot be seen (Priority: P1)

An agent clicks a control on a site and the click is refused because the control is not visible. Later, on that same site, the agent's lookup says that some controls there are not visible and that they are to be acted on with `browser_evaluate`, so it does not repeat the failing click.

**Why this priority**: It removes a failed call per visit on exactly the sites that fail hardest (E1), and the failure is invisible to every store that exists today.

**Independent Test**: In a synthetic site, click a hidden control (the call fails `ELEMENT_HIDDEN`), then read the site; a later lookup of the site shows the hidden-control counter in the acting profile's state.

**Acceptance Scenarios**:

1. **Given** an action on an in-scope origin that failed with `ELEMENT_HIDDEN` or `ELEMENT_COVERED`, **When** the failure is observed on a tab that was read inside the attribution window, **Then** the acting profile's state holds one hidden-control counter with the occurrence count.
2. **Given** a failure on any other code, **When** it is observed, **Then** no hidden-control counter is raised.
3. **Given** a hidden-control counter exists, **When** the site is looked up, **Then** the answer says that some controls there are not visible and how to act on them, and names no control.
4. **Given** the same failure happens again on the same site, **When** it is observed, **Then** the occurrence count rises and no second counter is created.
5. **Given** the same failure happens in another browser profile, **When** that profile looks the site up, **Then** its own counter is unchanged by the other profile's failure.
6. **Given** a failed action on a tab the daemon never observed, **When** it fails, **Then** no counter is raised, because no origin is known for it (C7).

---

### User Story 3 - Never store what a form contains (Priority: P1)

An owner reads what the feature stores and finds no label, no value, no placeholder and no text of any kind from the site's forms.

**Why this priority**: The whole value of website memory is that it can be read back by an agent without becoming a copy of what the user did.

**Independent Test**: A synthetic form with distinctive labels, values and placeholders is read; the stored record is compared byte for byte with a fixture that contains none of them.

**Acceptance Scenarios**:

1. **Given** a page whose form has labels, values, placeholders and help text, **When** the shape is stored, **Then** the stored bytes contain none of them, only counts and words from the reviewed vocabulary.
2. **Given** a field whose type is not in the reviewed list, **When** the shape is stored, **Then** the field is counted as `other` and its type is not guessed.
3. **Given** a form that asks for a person's name, an address or a card number, **When** the shape is stored, **Then** the count of fields is stored and no field's purpose is inferred.

---

### User Story 4 - The owner decides how far the facts reach (Priority: P2)

The owner turns the memory off, excludes a site, or deletes a site, and the new facts go with it, and the export shows exactly what is held.

**Why this priority**: The feature adds stored data, so the owner's controls over stored data must cover it completely.

**Independent Test**: Enable, inspect, export and delete a site that holds the new facts; the export lists them and the delete removes every trace.

**Acceptance Scenarios**:

1. **Given** a site with the new facts, **When** the owner deletes the site, **Then** no shape fact of that site and no hidden-control counter of that site remain, in any profile.
2. **Given** a site with the new facts, **When** the owner excludes the origin, **Then** the facts stop being collected and the old ones are removed.
3. **Given** a site with the new facts, **When** the owner exports the memory, **Then** the export contains the new facts in the documented shape.

### Edge Cases

- A page with several forms: only the one inside `main` is measured; a form in the header, the sidebar or the footer is not (C3), so a small search box never stands in for the page's real form.
- A page with no `main` landmark: no form is measured at all, and no shape fact is stored.
- A form inside an iframe: the top document's `main` is measured; a same-origin frame's form is not counted twice.
- A page that changes its form between two reads: the newer shape replaces the older one, and the fact keeps its first observation time.
- A form whose commit is not yet observed: the commit mode is `unknown` (C4) — never guessed from the markup.
- A path written to with a click on a button whose address did not change: the commit mode stays `unknown`, because nothing was observed and nothing proves how it is committed (C8).
- A site whose controls are hidden only sometimes (a responsive layout): the counter counts occurrences, so it stays true while the count rises; the count never falls.
- A site with a hidden-control counter whose controls become visible later: the counter stays (it is a hint with a date); the agent's own click either works or fails, and the failure stops rising.
- A read of a page whose path holds a query: the query is never part of the path, so the path rule applies to the path alone.
- A site that is later excluded, then included again: the facts start over, as with every other 003 fact; a profile's counter starts over with the profile's state.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The extension MUST report, for an in-scope page, a bounded shape block for the page's **only measured form: the one inside the `main` landmark** (C3): the number of fields, the number of required fields, each field's type taken from the reviewed list (any other type counted as `other`), and whether any field is visually hidden. It MUST NOT report the commit mode (C4), a label, a name, a value, a placeholder, a help text, an id, a class or any other string from the page. A page with no `main` landmark, or with no form inside it, MUST report no shape at all. [US1, US3]
- **FR-002**: The daemon MUST store one shape fact per page path, and MUST NOT store it when any segment of the path is not on the reviewed path list (003's rule for `ui.login`), **except the root path `/`, which is kept because it names no topic** (D-06). A page without a form MUST NOT get a shape fact. [US1]
- **FR-003**: The daemon MUST keep, **in the acting profile's own state**, one hidden-control counter for an origin when an action on that origin failed with `ELEMENT_HIDDEN` or `ELEMENT_COVERED`, holding the number of occurrences. The origin MUST come from the last observed read of that tab inside the attribution window (C7); a failed action on a tab that was never read raises nothing, because no origin is known for it. The counter MUST NOT be shared between profiles (C2), MUST NOT be behind the anonymity gate (C6), and MUST NOT store the target, the role, the name or any other part of the failed action. [US2, US3]
- **FR-004**: The **shape fact** MUST pass 003's scope gate, its anonymity gate (unless OD-1's Option 2 is approved), its normalisation, its untrusted-hints label, its per-site bound (at most 8 shape facts per site), its deletion, its exclusion and its export. The **hidden-control counter** MUST pass the scope gate, the exclusion, the deletion and the export, and MUST NOT pass the anonymity gate (C6); it is bounded like the site's other stored data and goes with its profile's state. [US3, US4]
- **FR-005**: The navigate reminder and `browser_memory` MUST show the new facts with fixed words only, in the existing format, within 003's bounds of 8 lines and 600 characters. The shape line MUST say that it describes the form's structure and not its content. The hidden-control counter is a profile counter, like a visit: it MUST appear under `all` and under `visits`, and MUST NOT appear under `facts`. [US1, US2, US3]
- **FR-006**: The agent guidance of `browser_memory` and the tool description MUST tell the agent that a shape fact is a hint about a form's structure, that it never carries what was typed or what the page says, and that a hidden-control counter means that this profile's invisible controls are to be acted on with `browser_evaluate`. [US1, US2]
- **FR-007**: The store schema MUST accept the new fact kinds and their identities, and every store file written before this change MUST stay valid and readable. [US4]
- **FR-008**: The reviewed vocabulary MUST be a closed list in a versioned contract; a drift test MUST fail when the vocabulary changes without a version bump. [US3]
- **FR-009**: The extension's shape block MUST be optional. An extension that does not send it MUST produce no shape fact, no error and no change in any other result. [US1]
- **FR-010**: Every new fact MUST be removable by the owner's controls: `disable`, `exclude`, `delete <origin>`, `delete --all`, and the tombstones that keep deleted origins deleted. The hidden-control counter MUST go with its profile's state. [US4]
- **FR-011**: The commit mode of a measured path MUST be learned from what an action did on that path, and MUST NOT be inferred from the markup (C4). The observation needs no new capability: the action's own result says when the address changed. A write is a **commit candidate** when the address changed — `browser_type` that pressed Enter gives `enter`, and a `browser_click` on a control the last snapshot marked `button` gives `button`. A candidate whose address did not change proves nothing, so the mode stays `unknown`; `none` is not a value (C8). The candidate MUST be held against the path the write ran on and applied at the **next observed read of that path**, where the anonymity gate is evaluated as in 003; a path that was never written to stays `unknown`. The mode MUST be part of that path's shape fact, MUST NOT be reported by the extension, and MUST NOT record the action's tool, target, tab or time — only the mode. [US1, US3]

### Key Entities *(include if feature involves data)*

- **Shape fact** (new): per origin and per allowlisted path, the measured form's field count, required count, field types from the reviewed list, whether a field is visually hidden, and the commit mode learned from observed actions — `unknown`, `enter` or `button` (FR-011).
- **Hidden-control counter** (new): per origin **and per profile**, the number of observed actions that were refused because a control was not visible or covered.
- **Reviewed vocabulary** (new contract): the field types, the commit modes and the fixed words the feature may store.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In a synthetic site with a three-field form (one required, one password, one visually hidden) inside `main`, one complete read produces exactly one shape fact, and after one refused click on that tab exactly one hidden-control counter, in 100% of runs. The shape's commit mode is `unknown` until a write is observed.
- **SC-002**: The stored bytes for that site contain none of the form's labels, values, placeholders or help texts; a test compares the record against a fixture that carries them.
- **SC-003**: Under OD-1 Option 1, a site that looks signed-in holds no shape fact (its hidden-control counter is still counted, because the counter is not behind the gate — C6); under Option 2 it holds the shape fact and no name, value or path outside the reviewed list. The privacy test covers the chosen option.
- **SC-004**: The owner can delete every trace of the new facts for an origin with one `delete <origin>`, and `delete --all` leaves no new fact in any file; the export lists the new facts in the documented shape.
- **SC-005**: The reminder stays within 8 lines and 600 characters with the new facts present, and `browser_memory` stays within its documented bounds.
- **SC-006**: The drift test fails when a vocabulary entry is added or removed without a version bump of the reviewed vocabulary.
- **SC-007**: Every existing 003 test still passes unchanged, including the privacy, boundary, scope and store tests.
- **SC-008**: A hidden-control counter raised in one profile never appears in another profile's record for the same origin, in 100% of runs.
- **SC-009**: A path written to once with Enter, whose address changed, reports `enter` at the next read of that path; a path written to with a click on a control the last snapshot marked `button`, whose address changed, reports `button`; a path whose write moved nothing, and a path never written to, report `unknown`; no shape fact ever carries a commit mode that the markup alone suggested.

## Assumptions

- The agent still decides whether to follow a hint. Hints never authorize an action (003 FR-009).
- The shape is read by the agent (C1), so the feature's value depends on the agent reading the reminder or `browser_memory` before it fills a form; no tool is changed to act on the fact by itself.
- The commit mode is learned from real writes on that path (C4), so a path the agent never fills keeps `unknown`.
- The hidden-control counter belongs to a profile (C2), so its value describes one profile's activity and is never shown in another profile.
- The extension's probe already runs on the same pages and under the same budget as today's; the shape is one more reading inside that budget, and the budget is never extended for it.
- The owner reloads the extension in a profile when the owner wants the shape there; the feature does not require a reload to be useful (FR-003 works without it).
- Sign-in itself stays the job of the owner or the credential vault ([006](../006-vault-site-approval/spec.md)); this feature only describes the form.
- The site's own words about its fields stay unreadable to the agent, as today.
