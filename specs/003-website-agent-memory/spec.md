# Feature Specification: shared website memory for browser agents

**Feature Branch**: Not created; specification is in the current checkout.

**Created**: 2026-10-27

**Status**: Draft — owner review required before the formal implementation plan.

**Input**: Remember useful, permitted website knowledge across agents using Browser Controller, and update it on subsequent tool-mediated visits or new observations. Evaluate Mnemon for integration without assuming its prototype has passed.

**Classification**: `EVOLVE / CRITICAL` proposed for the feature because it can persist authenticated browsing information and affect authorization boundaries. This document is not an implementation or a statement of formal acceptance. The root constitution is proposed, not adopted; current repository instructions apply.

## Clarifications

### Session 2026-10-27

- Q: How is memory enabled across visited sites? → A: Disabled initially; the owner enables it once for all eligible sites and can exclude individual sites. Private, vault and uncertain contexts remain excluded.
- Q: What information is automatically remembered? → A: Permitted non-personal navigation, interface and procedure details plus short non-personal facts from public pages already read by the tool. Do not save a fact when its public status or safety cannot be verified. (Narrowed by the later answer on procedures: single facts only.)
- Q: When does a remembered fact expire? → A: It does not expire automatically; the owner can delete it, or a later permitted observation from another agent can update the current fact.
- Q: How does an agent retrieve site memory? → A: It receives a short automatic reminder when visiting an eligible site and can request additional details through a dedicated tool.
- Q: What is shared across browser profiles? → A: Only verified public, non-personal site facts are shared across profiles to improve browsing; visit data remains separate for each profile.
- Q: Does website memory store procedures (multi-step task instructions) or only single facts? → A: Single facts only: site language, search control, login location and allowlisted control names. No procedures; memory never generates, edits or loads agent skills. Procedure skills are out of scope (a possible separate future spec).
- Q: Who can enable, disable, exclude, export or delete memory? → A: The agent may request any of these changes, and the change applies only after the owner confirms it in the agent client. Without a confirmation, nothing changes.
- Q: When is a page public enough for its facts to be stored? → A: Only when the browser confirms that its origin has no cookies, web storage or IndexedDB except reviewed consent and analytics names (names only, never values). This adds an owner-approved cookie permission to the extension. Otherwise only the visit is recorded.
- Q: Does this feature include an external memory engine or LLM-based extraction? → A: Keep the Mnemon prototype as an optional experiment in this feature. Other external memory engines (Mem0, Letta, Zep) and LLM-based extraction are out of scope.
- Q: How much added delay and resource use is acceptable with memory on? → A: The plan's limits: p95 overhead ≤ 25 ms for navigate and ≤ 30 ms for snapshot, commit p95 ≤ 50 ms, start overhead ≤ 50 ms, idle RSS growth ≤ 10 MiB, and zero queue drops with 4 clients. The owner confirms them after the first baseline run.

## User Scenarios & Testing

### User Story 1 - Share and update website knowledge (Priority: P1)

An owner enables memory globally, and a site is not excluded. One authorized agent visits it and observes permitted, useful information. A later authorized agent can retrieve permitted public, non-personal facts for the same origin across approved profiles. Each profile keeps its visit data separate.

**Why this priority**: Cross-agent continuity is the reason for the feature.

**Independent Test**: Use two isolated test clients, a synthetic site and the same test profile. Store an allowlisted observation through the first client; disconnect it; retrieve it through the second and after a service restart.

**Acceptance Scenarios**:

1. **AC-01**: Given memory is enabled globally and a test site is not excluded, when agent A successfully visits it, then a visit observation is recorded for the verified profile and origin; no page content is invented if none was read.
2. **AC-02**: Given agent A reads an eligible synthetic page and obtains a permitted non-personal navigation detail or short fact from a verified public page, when agent B later requests memory for the same profile and origin, then B receives the observation with its source and last-observed time, even after A disconnects and the service restarts.
3. **AC-03**: Given a later permitted observation replaces an earlier fact with the same stable identity, when another agent reads the current fact, then it sees the newer fact and its time; an unchanged observation updates freshness without creating a duplicate current fact.
4. **AC-04**: Given a navigation or read fails, when memory is queried, then that failure has not created a successful visit or changed a prior verified fact.
5. **AC-05**: Given navigation and reads run inside a batch, when an eligible step succeeds, then its memory effects match the same standalone step; failed or skipped steps create no successful observations.
6. **AC-25**: Given memory is enabled and an authorized agent successfully navigates to an eligible non-excluded site with existing scoped observations, when the navigation result is returned, then it contains a bounded reminder relevant to that site, labeled as untrusted and accompanied by source and freshness information.
7. **AC-26**: Given an authorized agent is working with an eligible site, when it requests more memory through the dedicated tool, then it receives bounded additional observations for that verified profile and origin, with scope-appropriate provenance and freshness, without exposing another profile's visit data or facts from another origin.
8. **AC-27**: Given an eligible navigation step within a batch has matching scoped memory, when the batch returns, then a bounded site-labeled reminder for that step is available in the batch result without hiding or replacing existing step results or receipts.
9. **AC-28**: Given memory is disabled, the site is excluded, authorization is absent or the scope is unknown, when navigation or a detail request occurs, then no remembered observations are returned automatically or through the detail tool.

### User Story 2 - Control what is remembered and shared (Priority: P1)

The owner can enable memory intentionally, inspect what is stored for a site, disable collection, and delete a site's stored observations. Verified public, non-personal facts may be shared across profiles for the same origin; visit data remains profile-specific and private browsing is excluded.

**Why this priority**: The browser may contain private and authenticated data.

**Independent Test**: Use synthetic profiles, normal and private tabs, and deliberately planted non-secret markers; inspect stored and returned data after each action.

**Acceptance Scenarios**:

1. **AC-06**: Given memory is disabled initially or the owner excluded a site, when an agent visits or reads that site, then no persistent site observation is created. Once the owner enables memory globally, subsequent eligible visits and reads on every non-excluded site may be recorded; past visits are not backfilled.
2. **AC-07**: Given one profile has a saved visit observation, when an agent on another profile asks for site memory, then that visit observation is not returned. Verified public, non-personal facts may be shared only for the same origin; different schemes and ports are distinct origins.
3. **AC-08**: Given account identity cannot be reliably determined or separated, when a page could contain account-specific information, then no account-specific fact is persisted or shared; the system does not guess identity from an agent-provided label.
4. **AC-09**: Given a private tab, vault page, protected or uncertain vault context, or unknown privacy state, when a tool is used, then no observation from that context is persisted or exposed through website memory.
5. **AC-10**: Given a synthetic page contains planted password, cookie, token, input-value and personal-data markers, when it is read or processed, then those markers and raw page contents do not appear in memory, search results, diagnostics or exported memory. Allowlisting is primary; redaction is defense in depth.
6. **AC-11**: Given the owner disables memory globally or excludes a site, when later visits and reads occur, then no new observation or freshness update is recorded, including from work queued before disablement. Given the owner deletes that site's memory, when agents query or export it, then its deleted records are absent and do not reappear after restart or from queued work. Deletion is logical; it makes no unverified secure-erasure claim for backups or storage remnants.
7. **AC-12**: Given one agent owns a tab, when another agent reads shared memory, then tab ownership and all existing browser action permissions remain unchanged; memory does not grant access to that tab.
8. **AC-21**: Given memory is enabled for an eligible site and a successful tool read of a synthetic page with verified public status, when it exposes an allowlisted non-personal fact and navigation detail, then the short fact and detail are stored with provenance; the raw page and excluded markers are not stored.
9. **AC-22**: Given a page's public status or the safety of a fact cannot be verified, when the page is read, then no page-content fact from it is persisted. A visit observation may be recorded only if its existing privacy and scope checks pass.
10. **AC-29**: Given profile A has an eligible verified-public non-personal fact and a visit observation, when an authorized agent on profile B accesses the same origin, then B can retrieve the shared fact but cannot retrieve A's visit observation. An agent accessing a different origin receives neither.
11. **AC-30**: Given a navigation or interface detail is not verified as public and non-personal, when a different profile accesses the site, then the detail is not shared; account-specific and private information remains excluded.
12. **AC-31**: Given a public fact originated in profile A, when profile B retrieves it, then its provenance identifies the public site origin but does not disclose A's profile identity, individual visit history, page path, or exact observation timestamp. If B has not independently verified the fact, it is marked as not verified in B's profile.
13. **AC-32**: Given an agent requests a memory policy change (enable, disable, exclude, include, inspect, export or delete), when the owner confirms it in the agent client, then exactly the confirmed change applies. When the client cannot ask the owner, or the owner declines or does not answer, then nothing changes and the request fails with a distinguishable result.

### User Story 3 - Trust freshness without trusting website instructions (Priority: P1)

An agent can use a memory as a hint while recognizing that websites change and their content may be hostile.

**Why this priority**: Persistent stale or malicious information can affect later actions across agents.

**Independent Test**: Replace a synthetic page element and inject hostile instructions into a fixture, then retrieve the saved observation and attempt to act.

**Acceptance Scenarios**:

1. **AC-13**: Given a stored locator or description no longer matches the current page, when an agent uses it, then the current page must be inspected or resolved again; a stale memory cannot authorize or silently perform an action.
2. **AC-14**: Given site content contains instructions to reveal data, change permissions, or ignore user instructions, when it is observed and later retrieved, then it is treated as untrusted site data and does not change permissions or cause an action.
3. **AC-15**: Given a remembered item has a source and observation time, when returned within its source profile, then both are visible to the agent and old information is not represented as currently verified without a new successful observation. Cross-profile retrieval uses the privacy-preserving provenance and freshness rules in AC-31.
4. **AC-23**: Given a committed current fact and no deletion or later replacement, when a controlled clock advances ten years and the service restarts, then the fact remains retrievable with its original observation time; elapsed time alone does not renew verification or delete it.
5. **AC-24**: Given agent A stored a fact, when agent B later makes a successful, authorized and permitted observation of a changed fact with the same identity, then the new observation becomes the current fact with its own provenance and observation time in the observing profile; the old value is not returned as current. Cross-profile output follows AC-31.

### User Story 4 - Continue browsing when memory fails (Priority: P1)

Agents can keep using existing browser tools if memory is slow, unavailable, damaged, or disabled.

**Why this priority**: Website memory must not weaken the primary browser service.

**Independent Test**: Inject memory timeout, process failure, concurrent writes, and storage restart while using synthetic browser tools.

**Acceptance Scenarios**:

1. **AC-16**: Given memory is unavailable or times out, when an existing browser operation succeeds, then its existing success result remains available within its established timeout; memory failure is distinguishable without revealing page contents.
2. **AC-17**: Given concurrent eligible observations for the same site, when writes finish or are interrupted and recovery completes, then committed observations remain readable, the current fact is not partially written, and repeated retries do not produce duplicate current facts.
3. **AC-18**: Given the memory service restarts after a committed observation, when an authorized agent queries it, then the committed observation remains available; a failed or incomplete write is not reported as committed.
4. **AC-19**: Given an eligible read may be retried after a transport timeout, when the final result is processed, then its observation is applied at most once per operation identity; click, type and other non-idempotent browser actions retain existing retry behavior.
5. **AC-20**: Given no separate external-service authorization, when memory capture, search and recovery run against synthetic fixtures, then no page-derived data leaves the local machine; a test network sink observes no outbound page-derived payload.

### Edge Cases

- Redirects, cross-origin frames, same-origin frames, dynamic pages, inaccessible pages and tabs closed mid-call must not cause a fact to be attributed to an unverified origin or context.
- Profile selection changes, disconnected profiles, unknown incognito state and concurrent sessions must fail closed for capture and retrieval where identity is uncertain.
- Query strings, fragments, credentials embedded in URLs, form values, screenshots, request or response bodies, cookies and vault data are excluded from automatic persistent capture.
- Repeated observations, conflicting facts, stale locators, multiple accounts within one profile, and changed permissions must not silently leak data or turn guesses into current facts.
- Declined, unanswered or repeated agent requests for a policy change leave the policy unchanged; repeating a request never bypasses the owner's confirmation.
- Queue saturation, cancellation, process crash, full disk, corrupt storage and memory shutdown must be visible as bounded memory failures without replaying browser actions or silently losing a claimed committed write.
- The feature creates no scheduled visits, background news monitoring, collection from unrelated tabs, external uploads, stored multi-step procedures, or agent skills.

## Requirements

### Functional Requirements

- **FR-001**: The system MUST provide persistent website memory to authorized agents. Verified public, non-personal site facts MUST be available across verified browser profiles for the same origin; visit observations MUST remain profile-specific. Memory MUST survive agent disconnection and service restart. [AC-01, AC-02, AC-18, AC-29–AC-31]
- **FR-002**: The system MUST record eligible successful tool-mediated visits and permitted non-personal navigation and interface observations obtained from successful reads, including eligible batch steps. It MUST also capture permitted short non-personal facts from verified public pages already read by the tool, and MUST NOT persist page-content facts when public status or safety is unverified. Failed or skipped steps MUST NOT be represented as successful. A visit without a read MUST NOT invent page content. [AC-01, AC-04, AC-05, AC-21, AC-22]
- **FR-003**: The system MUST reconcile an observation by stable fact identity, preserve provenance and last-observed time, and avoid duplicate current facts on repeated observations or read retries. Current facts MUST NOT expire merely because time passes; they remain until the owner deletes them or a later authorized and permitted browsing observation replaces them. Superseded facts MUST NOT be presented as current. [AC-03, AC-15, AC-17, AC-19, AC-23, AC-24]
- **FR-004**: Memory MUST be disabled initially. Once the owner enables it globally, the system MUST allow eligible observations for all non-excluded sites. The owner MUST be able to exclude sites, disable memory globally, inspect site memory and logically delete it. Disabling or excluding stops collection, including queued work; deletion removes records from future reads and exports. An agent MAY request any of these policy changes through a dedicated tool. The change MUST apply only after the owner confirms it in the agent client, in a confirmation that states the exact change and origin. If the client cannot ask the owner, or the owner declines or does not answer, nothing changes and the request fails distinguishably. Data returned to an agent this way MUST follow the scope rules in FR-007 and FR-011. [AC-06, AC-11, AC-32]
- **FR-005**: The system MUST verify profile, origin and privacy state independently of caller-supplied labels, and MUST fail closed when those cannot be verified. Only verified public, non-personal facts for the same origin may be shared across profiles. Visit data MUST remain profile-specific; cross-origin sharing is excluded. Account-specific facts MUST NOT be saved or shared without reliable account separation. [AC-07, AC-08, AC-09, AC-29–AC-31]
- **FR-006**: The system MUST exclude private browsing, vault and protected or uncertain contexts, credentials, cookies, tokens, form inputs, query strings, raw page bodies, screenshots and network bodies from automatic persistent capture. It MUST use an explicit allowlist for permitted observations, including public-page facts, and treat redaction as defense in depth. A page is verified public only when the browser confirms that its origin has no cookies, web storage keys or IndexedDB databases other than reviewed consent and analytics names. Only names are checked, never values. This check MAY use a browser cookie permission that the owner has approved. If any check fails or is unavailable, the page is unverified and only a visit observation may be recorded. The check MUST NOT add page visits. [AC-09, AC-10, AC-21, AC-22]
- **FR-007**: Retrieved memories MUST be labeled as untrusted observations with scope-appropriate provenance and freshness. Cross-profile output MUST identify the public site origin without revealing the originating profile, individual visit history, page path or exact observation time; it MUST mark verification as unknown for the receiving profile until that profile verifies it. Memories MUST NOT grant access, authorize actions, override higher-priority instructions, or be treated as proof that a page remains unchanged. [AC-12, AC-13, AC-14, AC-15, AC-31]
- **FR-008**: Memory failures MUST be bounded and separately reportable; they MUST NOT replace or hide existing browser outcomes, ownership, timeouts, or retry semantics. Successful navigation MAY add the bounded, labeled reminder required by FR-011 without changing the underlying browser outcome. Memory persistence MUST distinguish committed from failed or unknown writes. [AC-16–AC-19, AC-25, AC-27]
- **FR-009**: Memory operations MUST be local by default; no page-derived information may be sent to an external service without separate explicit owner authorization. No scheduled collection is included. [AC-06, AC-10, AC-20]
- **FR-010**: The feature MUST support deterministic tests using synthetic pages and isolated data for privacy, account/profile/origin isolation, authorization, restart, concurrent writes, failure and injection behavior. [AC-01–AC-32]
- **FR-011**: After successful navigation to an eligible, non-excluded site, an authorized agent MUST automatically receive a bounded reminder of relevant observations for the verified profile and origin, including permitted shared public facts for that origin, also when navigation is a batch step. A dedicated tool MUST let the authorized agent request bounded additional details for that scope. Output MUST follow the provenance, freshness and cross-profile privacy rules in FR-007; no other profile's visit data or another origin's facts may be exposed. When scope or authorization is unavailable, no observation is returned. [AC-02, AC-07, AC-15, AC-25–AC-31]
- **FR-012**: Website memory MUST store single facts only. It MUST NOT store multi-step procedures, and it MUST NOT generate, edit or load agent skills. Memory content MUST NOT be loaded as instructions. [AC-13, AC-14]
- **FR-013**: A Mnemon prototype MAY be evaluated as an optional experiment. It MUST run locally, MUST meet the same scope, allowlist and privacy rules, and MUST pass the same acceptance criteria as the default store. It is adopted only after the SC-005 measurements and owner approval. The feature MUST work without it. Other external memory engines and LLM-based extraction are out of scope. [AC-10, AC-20, SC-005]

### Key Entities

- **Site scope**: verified browser profile and origin subject to global owner enablement and per-site exclusions. Visit observations are profile-specific; verified public, non-personal site facts may be shared across profiles for the same origin.
- **Visit observation**: successful tool-mediated visit, verified profile and site origin, observation time and source; it need not contain page content and is not shared across profiles.
- **Site fact**: one permitted, non-sensitive navigation or interface detail or short fact from an already-read verified public page, with stable identity, source, last verification time and current or superseded status. A site fact is never a multi-step procedure.
- **Memory policy**: owner choice for collection, inspection, sharing and deletion, changed by the owner or by an agent request that the owner confirms; unknown policy or identity means no capture.

## Success Criteria

### Measurable Outcomes

- **SC-001**: All AC-01–AC-32 pass in repeatable isolated acceptance tests; every test uses synthetic content and reports its evidence.
- **SC-002**: In the acceptance fixture with an operational memory service and acknowledged writes, 100% of successful eligible standalone and batch observations for non-excluded sites when memory is globally enabled are visible to the authorized later agent; failed and skipped operations create zero successful observations.
- **SC-003**: In the privacy fixture, zero planted sensitive markers are found in memory reads, exports, diagnostics or persistent records; no private, disabled, unauthorized or not-verified-public observation is shared across profiles, and no profile exposes another profile's visit data.
- **SC-004**: In failure and recovery tests, all acknowledged committed observations survive restart, no partial observation is returned as committed, and existing browser operations retain their documented outcomes and timeouts.
- **SC-005**: Measure memory off (baseline) and memory on, on the same synthetic workload and supported runtimes, including time, resource usage and returned context size. With memory on, compared with the baseline:
  - p95 overhead is at most 25 ms for navigate and at most 30 ms for snapshot;
  - p95 commit time is at most 50 ms;
  - daemon start overhead is at most 50 ms;
  - idle RSS growth is at most 10 MiB;
  - there are zero queue drops with 4 concurrent clients.

  The owner confirms these limits after the first baseline run. No improvement is assumed from this document.

## Assumptions

- The owner enables memory once globally; eligible subsequent visits are included unless the site is excluded. Memory starts disabled and existing visits are not backfilled.
- A permitted fact is selected from a narrow, reviewed non-sensitive allowlist; short facts from already-read pages are included only when public status and safety are verified. Raw page content and account data are not automatically persisted. Public status is verified by checking cookie, web storage and IndexedDB names, never values (FR-006). The detailed allowlist, including the reviewed consent and analytics names, and the test fixtures belong in the reviewed plan and contract.
- A verified origin is scheme, host and effective port. Profile identity must remain stable enough for scoped storage without using mutable agent labels. Cross-profile sharing is limited to verified public, non-personal facts for the same origin; shared output does not include visit-identifying metadata.
- Current observations have no automatic time-based expiration. The owner may delete them, and later authorized and permitted browsing observations may replace their current values; historical-version storage and backup handling remain subject to the reviewed plan. Logical deletion applies to active records and retrieval/export and makes no secure-erasure claim.
- Apart from the SC-005 limits, no specific latency, cost, token reduction, model, external service, database driver or integration approach is accepted without the documented prototype and owner review.
- This is a draft for specification review. The Mnemon prototype is an optional experiment within this feature (FR-013). Its proposed delivery sequence is in [implementation-outline.md](implementation-outline.md), which is not an approved Spec Kit plan.
