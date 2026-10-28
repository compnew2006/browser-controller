# Feature Specification: site navigation map for browser agents

**Feature Branch**: Not created; specification is in the current checkout.

**Created**: 2026-10-28

**Status**: Draft — owner review required before the formal implementation plan.

**Input**: User description: "اعمل speckit.specify جديد علشان يقوم بتذكر سلوك التصفح الاخير زي اماكن الازرار والروابط اللي بتوصلك للخاصية الفلانية او الصفحة الفلانية مش إجراءات متعددة الخطوات انما مقادير الطبخة والغرض من كدة بدل ما يعيد تصفح الموقع من جديد هيقوم بمعرفه هيكلية كل الصفحات والعناصر اللي زارها لو المستخدم قالة افتح البروفايل بتاعي مثلا من هيروح www.example.com ويبدأ يفهم الصفحة ولكن هيروح علي www.example.com\profilev2.php ويضغط في المكان المناسب علي طول لانه عارفه علشان زارة قبل كدة"

English summary of the input: remember recent browsing structure — where the buttons and links that lead to a feature or page are. Not multi-step procedures, but the "ingredients of the recipe". Instead of exploring a site again, the agent knows the structure of the pages and elements it visited. If the user says "open my profile", the agent goes straight to `www.example.com/profilev2.php` and uses the right control there, because it visited it before.

**Classification**: `EVOLVE / CRITICAL` proposed, because the map stores the structure of public and signed-in pages from the user's real browser profile. The root constitution is proposed, not adopted; current repository instructions apply.

**Builds on**: [003 website memory](../003-website-agent-memory/spec.md). This feature reuses 003's owner policy, scope verification, site exclusions, owner confirmation of agent requests, local-only storage and failure isolation. It differs from 003 in one deliberate way: map entries come from public and signed-in pages alike, so they are never shared across browser profiles (FR-005).

## Clarifications

### Defaults chosen from the request, 2026-10-28 (the owner may change any of them at spec review)

- Q: What does the map remember? → A: The ingredients only: pages an agent visited (address and title), controls seen on them (role, visible name and page area), the menu or dialog a control was inside, and where a control led when that was observed. It never stores an ordered list of steps; the agent composes its own route from these entries.
- Q: Whose browsing is remembered? → A: Only pages that agents reached and read through their own tool calls ("because it visited it before"). The user's manual browsing and other tabs are not collected, as in 003.
- Q: Which pages are recorded? → A: Structural pages of every eligible site, whether or not the user is signed in: the origin's root, pages reached through an eligible control, pages from which an agent used an eligible control, and the page where a direct open of a remembered page landed. Login state does not decide eligibility; scope does (map and website memory enabled, site not excluded, not private, not vault-protected, verified profile). A page opened by address, read and left, such as an article, is not recorded; 003 still records the visit. Signed-in pages are included because the request's example, the user's profile, is one; map entries therefore stay in the browser profile that observed them and are never shared with another profile.
- Q: Can the agent use the map before it visits the site? → A: Yes. Within the same verified profile, it can look up a site's map before navigating, so it can open a remembered address directly.
- Q: How is the map switched on? → A: It is off initially and is enabled separately from website memory, after owner confirmation. It requires website memory to be enabled and follows its site exclusions.

### Review, 2026-10-28

- Q: Does "signed-in pages are included" mean that only signed-in pages are recorded? → A: No. Structural pages are recorded whether or not the user is signed in (see "Which pages are recorded?" above).
- Q: How does the map keep the signed-out and signed-in views of one page apart? → A: By read context, taken from 003's anonymity verdict: verified public, not verified public, or unknown. It is never presented as a login state, because a signed-out page can be not verified public (observed on ar.wikipedia.org). A control is marked not seen only after a complete read in the same context.
- Q: What happens when a remembered address now needs sign-in? → A: The page entry records where its last direct open landed, and lookups show it, so the agent can expect a sign-in step.
- Q: How does the map relate to 003's shared facts in the navigation reminder? → A: The reminder shows 003's shared facts first and adds only the map controls they do not already contain, for the navigated tab's origin only.
- Q: What does the enable prompt say? → A: That the map records the addresses of pages agents visit in this profile, including signed-in pages.
- Q: Who updates the map when the site changes? → A: The agent, through its normal browsing. When a remembered hint does not match the site, the agent makes a complete read of the current page and continues by the new route; those observations update the map. Agents cannot write entries directly, so a hostile page cannot plant false entries through an agent.

### Owner additions, 2026-10-28

- Q: How does the agent use a remembered control with the fewest steps? → A: The lookup gives the control's role and name as a ready locator and its expected destination. The agent uses the control in one step that finds it on the current page, fails without acting if it is missing or ambiguous, and reports when the page reached differs from the expected destination. No separate verifying read is needed.
- Q: Does the map learn from using a hint? → A: Yes. A successful use refreshes the entry. A failed use is recorded and ranks the entry lower, without waiting for a complete read; only a complete read marks an entry not seen.
- Q: How are controls that change data handled? → A: Controls whose names match a reviewed English and Arabic vocabulary of data-changing actions are marked as acting on data. They never appear in the automatic reminder, and a lookup shows them with a notice to confirm with the user first.
- Q: How are results ranked? → A: Entries that work come first, then the most used in this profile, then the most recently seen. A lookup without words returns a short outline of at most 10 pages.
- Q: Can the owner remove less than a whole site? → A: Yes. The owner can delete a single page entry and exclude path prefixes within an origin.
- Q: How is the saving shown? → A: Local aggregate counters of lookups, hints that worked or failed, and estimated page loads and characters saved. They contain no addresses, titles, names or origins.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Open a remembered page directly (Priority: P1)

Earlier, an agent reached a page through several clicks: from the example.com home page, through the account menu, to `/profilev2.php`. Later, the user asks the agent to open their profile. The agent looks up the site's map, finds the remembered profile page and its address, and opens that address directly instead of exploring the home page again.

**Why this priority**: This is the purpose of the feature: fewer exploratory page loads and tool calls for places the agent already knows.

**Independent Test**: A synthetic site has a target page three clicks away from its home page. Agent A reaches the target through clicks. After a service restart, agent B on the same profile looks up the target by a word from its title and reaches it with one navigation.

**Acceptance Scenarios**:

1. **AC-01**: Given the map is enabled and an agent successfully read a page in scope, when that page is the origin's root, was reached through an eligible control (AC-06, AC-08), is a page from which the agent then used an eligible control, or is the same-origin page where a direct open of a remembered page landed (AC-19), then the map records the page for that profile and origin: its address without query or fragment, its title, its language, its read context and its last-seen time. This applies whether or not the user is signed in. A page already in the map is refreshed when it is read again by any route.
2. **AC-02**: Given a recorded page, when an agent in the same profile looks up the origin with a word that appears in the page's title, its address, or the name of a control that leads to it, then the lookup returns the page with its address, the control and page that led to it last time, its freshness, and a label stating that it is an untrusted hint. Matching ignores letter case and Arabic diacritics.
3. **AC-03**: Given a lookup result for a directly addressable page, when the agent opens that address, then it reaches the page in one navigation if the site still serves it to the current session. The map itself never navigates or clicks.
4. **AC-04**: Given a page whose address contained masked parts, or which was reached through an address with a query or fragment, when it is looked up, then it is reported as not directly addressable, and the control and page that led to it are returned instead.
5. **AC-05**: Given the agent has no tab on the origin, when it looks up that origin, then the lookup answers within the session's verified profile. When the map or website memory is disabled, the site is excluded, or the profile cannot be verified, the lookup returns no entries and says why.
6. **AC-27**: Given an agent opens 100 article pages of one origin by address, reads them and uses no eligible control on them, when the map is inspected, then none of those pages has a page entry, and website memory still records the visits.
7. **AC-33**: Given an origin has many remembered pages, when an agent looks it up without words, then it receives an outline of at most 10 pages, one line each. Entries whose last use worked and that are not marked not seen come first, ranked by how often agents used them in this profile and then by last seen; entries marked not seen or whose last use failed come after.

---

### User Story 2 - Use the right control on a known page (Priority: P1)

On a remembered page, the agent knows which controls exist and where they lead. For example, the "Edit profile" button in the main area of `/profilev2.php` leads to `/profile/edit.php`, and the "Profile" link is inside the menu opened by the account button in the header. The agent uses the control in one step that also confirms it is still there and that it leads where it used to.

**Why this priority**: Knowing the page address is only half of the request; the user also asked for the agent to "click the right place" without re-reading the whole site.

**Independent Test**: A synthetic page has a header menu, main-area buttons and footer links. Agent A opens the menu and clicks two controls. Agent B looks up the page and finds both controls with their page areas, the menu that contains one of them, and their destinations.

**Acceptance Scenarios**:

1. **AC-06**: Given a successful read of an eligible page, when the page has controls in its navigation areas (header, navigation menus, sidebars and footer) or buttons, tabs and menu items in its main area, then the map records each control's role, visible name and page area, up to the per-page limit.
2. **AC-07**: Given an agent's successful click on a control is followed by the same tab loading another page of the same origin, when both pages are eligible, then the map records that the control on the first page leads to the second page. A destination on another origin is recorded as that origin only, without its path.
3. **AC-08**: Given an agent's successful click opens a menu or dialog without loading a page, when the agent then reads the page, then controls inside that menu or dialog are recorded with the control that opened it. This is a single relation per control, not a sequence of steps.
4. **AC-09**: Given a remembered control, when an agent looks it up, then it receives the control's role and name as a ready locator and its expected destination when known. Using that locator finds the control on the current page in the same step as the use: the step fails without acting if the control is missing, hidden, disabled, covered or ambiguous, and it reports a mismatch if the page reached differs from the expected destination. No separate verifying read is required. The map never offers screen coordinates as the only way to find a control and never acts on its own.
5. **AC-10**: Given the same control on the same page is observed again, when the map updates, then the existing entry is refreshed and no duplicate is added.
6. **AC-26**: Given an agent successfully navigates to an eligible page that has map entries, when the navigation result is returned, then it includes a bounded, untrusted-labeled reminder of that page's remembered controls that are not already among 003's shared facts for that page, and the number of known pages for the origin, without hiding or replacing the navigation result. The reminder contains no entry of any other origin and no control marked as acting on data (AC-32).
7. **AC-31**: Given an agent uses a remembered control or opens a remembered address, when the use succeeds, then the entry is refreshed and its use count grows. When the control is not found, the step is ambiguous, or the page reached differs from the expected destination, then the entry records that its last use failed and when, and lookups list it after entries that work, without waiting for a complete read. A failed use alone never marks an entry not seen.
8. **AC-32**: Given a control whose name matches the reviewed vocabulary of data-changing actions (for example delete, remove, pay, purchase, transfer, sign out and unsubscribe, and in Arabic حذف، إزالة، دفع، شراء، تحويل، تسجيل الخروج and إلغاء الاشتراك), when it is returned, then it is marked as acting on data, it never appears in the automatic reminder, and an explicit lookup shows it with a notice that the agent must confirm with the user before using it.

---

### User Story 3 - Keep the map private and under the owner's control (Priority: P1)

Signed-in pages show personal data. The map stores structure, not content. It stays in the profile that observed it, and the owner can inspect, export, disable and delete it.

**Why this priority**: The map also reads signed-in pages in the user's real browser, and even public page addresses can reveal sensitive topics, so a privacy failure is worse than a missing hint.

**Independent Test**: Use synthetic signed-in pages that contain planted markers in messages, tables, search results, form values, query strings, fragments, page titles and control names (email addresses, phone numbers, long numbers and tokens). Run the fixtures in two profiles, a private tab and a vault-protected page, then inspect every stored record, lookup, reminder and export.

**Acceptance Scenarios**:

1. **AC-11**: Given the map is disabled (its initial state), website memory is disabled, or the site is excluded, when agents browse, then no map entry is created or refreshed, including from work queued before the change.
2. **AC-12**: Given profile A has map entries for an origin, when an agent connected to profile B looks up that origin or navigates to it, then it receives none of profile A's entries.
3. **AC-13**: Given a private tab, a vault-protected or uncertain vault context, or a scope that cannot be verified, when a tool is used there, then nothing from that context enters the map.
4. **AC-14**: Given a page contains user content (messages, posts, documents, comments, search results, table rows, record lists and notifications) and form values, when the page is read, then no text from that content and no form value is stored. Only the controls described in AC-06 and AC-08 are considered. A page reached only through a control in a content area, such as one message or one record, is not recorded. A page whose path contains a placeholder is recorded without its title.
5. **AC-15**: Given an address, title or control name contains an email address, a phone number, a run of four or more digits, or a long random-looking identifier or token, when it is stored, then that part is replaced with a placeholder before storage. Query strings, fragments and credentials in addresses are never stored.
6. **AC-16**: Given the owner inspects, exports or deletes the map for one page entry, one site or all sites, directly or by confirming an agent's request, when the action completes, then exactly that action has taken effect. Deleted entries do not return after a restart or from queued work.
7. **AC-17**: Given an agent requests that the map be enabled or disabled, when the owner confirms a prompt that states the exact change and, for enabling, that the map records the addresses of pages agents visit in this profile, including signed-in pages, then the change applies. When the owner declines, does not answer, or cannot be asked, nothing changes and the request fails with a distinguishable result.
8. **AC-34**: Given the owner excludes a path prefix for an origin, such as `/health`, when agents browse pages under it, then no page or control entry is created for them, existing entries under it are deleted, no control destination under it is stored, and lookups never return them. Pages outside the prefix are recorded as before.
9. **AC-35**: Given the map is in use, when the owner checks its status, then they see aggregate counts for the profile: lookups, hint uses that worked, hint uses that failed, and estimated page loads and returned characters saved, labeled as estimates. The counts contain no addresses, titles, names or origins, and they are reset when the owner deletes all map data.

---

### User Story 4 - Stay correct when the site changes (Priority: P2)

Sites change, sessions expire and page text can be hostile. The map must not present old structure as current or turn site text into instructions.

**Why this priority**: A wrong hint costs a failed click; a hint treated as authority could cause a wrong action.

**Independent Test**: Rename, move and remove controls in a synthetic site between two agent sessions. Expire the synthetic session so that a remembered address redirects to a sign-in page. Put instruction-like text in a control name.

**Acceptance Scenarios**:

1. **AC-18**: Given a remembered control is absent from a later complete read of the same page in the same read context, when the map updates, then the control is marked as not seen in that context and is not presented as current for it. It becomes current again when it is seen again. A read in another context, or with an unknown context, does not mark it.
2. **AC-19**: Given a direct navigation to a remembered address ends on another page, such as a sign-in or error page, when the map updates, then the remembered page is not deleted, and its only change is a record of where that direct open landed (a masked same-origin path or another origin) and when. Lookups show this record, so the agent can expect a sign-in step. The remembered page's last-seen time is not refreshed. A same-origin landing page is recorded as a page entry, so a page the site moved appears under its new address.
3. **AC-20**: Given a control is observed leading to a different page than before in the same read context, when the map updates, then the newer destination replaces the older one for that context, with its own time. A destination observed in another context, such as a sign-in page reached while signed out, does not replace it.
4. **AC-21**: Given a stored name contains instructions, such as asking to ignore previous instructions or to delete an account, when it is returned, then it is labeled untrusted site data, is bounded in length, and does not change permissions or cause any action.
5. **AC-22**: Given entries of any age, when they are returned, then each shows when it was last seen. Elapsed time alone neither deletes an entry nor makes it current again.
6. **AC-28**: Given a page whose account menu appears only after sign-in, when an agent completes a read while signed out (verified public) and then a read while signed in (not verified public), in either order and repeatedly, then the account-menu controls are never marked not seen because of the signed-out reads, and no output describes either context as signed in or signed out.
7. **AC-29**: Given a direct open of a remembered address is answered by the site as not found, when the map updates, then the page entry records that result and its time, its last-seen time is not refreshed, and lookups show the result. The entry is not deleted; it is current again if the page is seen again.
8. **AC-30**: Given the site moved the remembered profile page from `/profilev2.php` to `/profile` and renamed its menu link from "Profile" to "My account", when an agent opens the remembered address, lands on the site's home page instead, makes a complete read and reaches the page through the new link, then the map holds the new control, its new destination and the new page; the old page records that its last direct open landed elsewhere; the old control is marked not seen in that read context; and the next lookup for the page lists `/profile` before `/profilev2.php`. No entry was written by the agent directly.

---

### User Story 5 - Browsing continues when the map fails (Priority: P2)

Agents keep using the browser tools normally when the map is slow, full, damaged or unavailable.

**Why this priority**: The map is an aid; it must never weaken the primary browser service.

**Independent Test**: Inject map timeouts, storage failure, concurrent writes and restarts while using synthetic browser tools.

**Acceptance Scenarios**:

1. **AC-23**: Given the map is slow, unavailable, full or damaged, when a browser operation succeeds, then its result and timeout are unchanged, and the map failure is reported separately without page content.
2. **AC-24**: Given several agents read pages of the same site at the same time, when their observations are applied, then no entry is duplicated or partially written, and a retried read is applied at most once.
3. **AC-25**: Given an origin reaches its page or control limit, when new entries arrive, then the least recently seen entries are removed first and the limit is never exceeded.

### Edge Cases

- A single-page application changes its address without a page load: the page is recorded by its path. A view that exists only in a fragment (`#/settings`) is not directly addressable (AC-04).
- One path serves different content per account or state, or several accounts are used in one profile: they share one map, and every entry remains a hint to be checked on the current page. Signed-out and signed-in views of one page are kept apart only by read context (AC-28).
- 003 cannot determine whether a page is public (its verdict is unknown): the read can add or refresh entries with an unknown context, but it cannot mark anything as not seen.
- A sign-in flow goes through another origin, or a click opens a new tab or a cross-origin frame: only the destination origin is recorded, never its path, and nothing is attributed to an unverified page.
- A control has no visible name (an icon only): it is not recorded.
- Many identical controls share a name on one page (for example ten "Edit" buttons in a list): they come from a content area and are not recorded. In a navigation area they are stored once.
- A control deletes data, pays or signs out: it is recorded and marked as acting on data (AC-32). The map never acts, and the agent's normal confirmation rules still apply. A harmless control whose name matches the vocabulary, such as "Remove filter", is only kept out of the reminder.
- A ready locator matches several controls on the current page: the step fails as ambiguous without acting, and the failed use is recorded (AC-31).
- A sign-in page or a page with a password field: its structure is recorded; no input value is ever read into the map.
- A read is scoped to part of the page or cut short: it can add or refresh entries, but it cannot mark anything as not seen (AC-18).
- The clock changes, the service restarts, or the owner deletes a site while observations are queued: deleted entries do not return.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST keep a site map for each verified browser profile and origin, consisting of page entries and control entries. A page entry holds its masked path, title, language and direction, whether it is directly addressable, the control and page that led to it last, the result of its last direct open (where it landed if elsewhere, or that the site answered not found) and when, first-seen and last-seen times, the last time it was seen in each read context, and how often agents used it in this profile. A control entry holds its page, role, visible name, page area, the control whose menu or dialog contains it (if any), its observed destination (a masked same-origin path or another origin), whether it acts on data, first-seen and last-seen times, the result and time of its last use, how often agents used it in this profile, and, for each read context, the last time it was seen and whether it was seen at the last complete read. A read context is 003's anonymity verdict at read time: verified public, not verified public, or unknown. It MUST NOT be part of an entry's identity and MUST NOT be presented as a login state. The map MUST NOT store ordered multi-step procedures, MUST NOT generate, edit or load agent skills, and MUST NOT be loaded as instructions. [AC-01, AC-06–AC-08, AC-19, AC-28]
- **FR-002**: The map MUST be built only from successful tool-mediated navigations, page reads and clicks performed by agents, including eligible batch steps. Failed or skipped steps MUST record nothing. The system MUST NOT collect from tabs or browsing that an agent did not perform, and MUST NOT schedule visits. A page MUST be recorded only when it is the origin's root, the destination of an eligible control, a page from which an agent used an eligible control, or the same-origin page where a direct open of a remembered page landed; whether the user is signed in MUST NOT decide this. Agents MUST NOT add, edit or remove entries directly; the map changes only through observations of agents' browsing and through owner-confirmed deletion. [AC-01, AC-07, AC-24, AC-27, AC-30]
- **FR-003**: The system MUST NOT store text from content areas, form values, query strings, fragments, credentials, cookies, storage values, screenshots or request and response bodies. Only controls in navigation areas, main-area buttons, tabs and menu items, and controls inside a menu or dialog an agent opened are eligible. A page reached only through a content-area control MUST NOT be recorded, and a page whose path contains a placeholder MUST be recorded without its title. Selection by page area and control role is the primary protection; masking is defense in depth. [AC-14]
- **FR-004**: Before storage, the system MUST replace email addresses, phone numbers, runs of four or more digits, and long random-looking identifiers or tokens with placeholders in paths, titles and names, and MUST bound their length (provisionally 80 characters for a name, 120 for a title and 200 for a path; confirmed in the plan). A path with a placeholder, or one reached through a query or fragment, MUST be marked not directly addressable. [AC-04, AC-15]
- **FR-005**: The system MUST verify profile, origin and private-browsing state independently of caller-supplied labels, using 003's scope rules, and MUST fail closed when they cannot be verified. Map entries MUST stay in the profile that observed them and MUST NOT be shared with or returned to another profile. This deliberately differs from 003 FR-005, which forbids saving account-specific facts without reliable account separation: for map entries, the browser profile is the separation boundary. This difference requires owner approval at spec review. [AC-12, AC-13]
- **FR-006**: The map MUST be disabled initially and enabled separately from website memory, and it MUST require website memory to be enabled. It MUST follow 003's site exclusions. Disabling website memory or the map, or excluding a site, MUST stop collection, including queued work. The owner MUST be able to inspect, export and delete the map for one page entry (with its controls), one site or all sites, and to exclude path prefixes within an origin. An excluded prefix MUST stop recording pages under it, delete existing entries under it, and keep destinations under it out of the map. An agent MAY request any of these changes; a change MUST apply only after the owner confirms a prompt that states the exact change. A prompt to enable the map MUST state that it records the addresses of pages agents visit in this profile, including signed-in pages. If the owner declines, does not answer or cannot be asked, nothing changes and the request fails distinguishably. [AC-11, AC-16, AC-17, AC-34]
- **FR-007**: A dedicated lookup MUST return map entries for the origin of the agent's tab or for an origin the agent names, within the session's verified profile. It MUST accept optional words and match them against titles, paths and control names, ignoring letter case and Arabic diacritics. Results MUST be bounded and paged. Entries that are not marked not seen and whose last use did not fail MUST come first; entries marked not seen or whose last use failed, including a direct open that landed elsewhere or was not found, MUST come after. Within each group, entries used more often in this profile MUST come first, then more recently seen ones, so a page or control the site replaced is listed after its replacement. A lookup without words MUST return an outline of at most 10 pages, one line each. Each control in a result MUST carry its ready locator and expected destination (FR-009). Lookup MUST NOT use an external service or model-based search. When scope or policy does not allow it, the lookup MUST return no entries and a distinguishable reason. [AC-02, AC-05, AC-30, AC-31, AC-33]
- **FR-008**: After a successful navigation to an eligible page that has map entries, the existing website-memory reminder MUST show 003's shared facts first and then add only the page's remembered controls that those facts do not already contain, and the number of known pages for the origin. Every line MUST show its source and freshness. The reminder MUST stay within a fixed size bound, be labeled untrusted, contain only entries for the navigated tab's origin, contain no control marked as acting on data, and not hide or replace the navigation result. [AC-26, AC-32, SC-006]
- **FR-009**: Map entries MUST be presented as untrusted hints with their freshness. They MUST NOT authorize actions, grant tab access, bypass confirmations, or be treated as proof that a page is unchanged. Each remembered control MUST be offered with its role and name as a ready locator and with its expected destination when known, so that the agent finds, uses and checks the control in one step: the step MUST fail without acting if the control is missing, hidden, disabled, covered or ambiguous, and MUST report a mismatch if the page reached differs from the expected destination. No separate verifying read is required. Coordinates MUST NOT be the only locator offered. The map itself MUST NOT navigate or click. Lookup and reminder output MUST tell the agent that when a remembered page or control does not match the current page, a complete read of the current page updates the map. [AC-03, AC-09, AC-21, AC-30, SC-003]
- **FR-010**: The system MUST reconcile entries by stable identity: a page by its masked path, a control by its page, area, role and name. Re-observation MUST refresh an entry without creating a duplicate. A control absent from a complete read MUST be marked not seen for that read's context only; a read in another context or with an unknown context, and a scoped or truncated read, MUST NOT mark anything as not seen. A newer observed destination MUST replace the older one for the same read context only. A redirect or a not-found answer MUST NOT delete the page that was requested or refresh its last-seen time; it only records the result of that direct open. A successful use of a remembered control or address MUST refresh its entry and count the use; a failed use MUST be recorded as the entry's last-use result and lower its rank, but MUST NOT mark it not seen. Entries MUST NOT expire because of elapsed time alone. [AC-10, AC-18–AC-20, AC-22, AC-28, AC-29, AC-31]
- **FR-011**: The system MUST bound the map for each profile and origin and remove the least recently seen entries first. Provisional limits are 500 pages per origin and 60 controls per page; the plan confirms them after measurement. [AC-25]
- **FR-012**: Map failures MUST be bounded and reported separately. They MUST NOT replace or hide browser outcomes, tab ownership, timeouts or retry behavior. Each observation MUST be applied at most once per operation identity. [AC-23, AC-24]
- **FR-013**: All map data MUST stay on the local machine. No page-derived data may be sent to an external service, and no external memory engine or model-based extraction is used. [AC-14, AC-15]
- **FR-014**: The feature MUST support deterministic tests with synthetic sites and isolated data. The tests cover multi-hop navigation, menus, privacy markers, profile isolation, staleness, redirects, injection, limits, concurrency, failure, structural-page selection, read contexts, site changes, ready locators, use feedback, data-changing controls, ranking, path exclusions and counters. [AC-01–AC-35]
- **FR-015**: The system MUST mark controls whose names match a reviewed vocabulary of data-changing actions, in English and Arabic, as acting on data; matching ignores letter case and Arabic diacritics, and the vocabulary is reviewed in the plan. Such controls MUST NOT appear in the automatic reminder, and lookups MUST return them only with a notice that the agent must confirm with the user before using them. A control without the mark MUST NOT be treated as safe to use without the agent's normal confirmation rules. [AC-32]
- **FR-016**: The system MUST keep local aggregate counters for each profile: lookups, hint uses that worked, hint uses that failed, and estimated page loads and returned characters saved. The counters MUST NOT contain addresses, titles, control names or origins, MUST be visible to the owner and labeled as estimates where they are estimates, and MUST be reset when the owner deletes all map data. The estimate method is defined in the plan. [AC-35]

### Key Entities *(include if feature involves data)*

- **Site map**: all entries for one verified browser profile and one origin. It is never shared across profiles.
- **Page entry**: a structural page an agent visited: the origin's root, a page reached through an eligible control, a page from which an agent used one, or the page where a direct open of a remembered page landed. It holds the masked path, title, language, addressability, the control and page that last led to it, the result of its last direct open (landed elsewhere, or not found), its use count, and its freshness per read context.
- **Control entry**: a control on a page. It holds its role, visible name (which with the role forms its ready locator), page area, the control that opens its menu or dialog (if any), its observed destination, whether it acts on data, its last-use result and use count, and its freshness and seen status per read context. It describes a single location or relation, never a sequence.
- **Read context**: 003's verdict on whether a page was verified public when it was read: verified public, not verified public, or unknown. It separates views of one page for not-seen decisions only; it is not a login state.
- **Map policy**: the owner's choice to enable or disable the map and the path prefixes excluded within each origin, layered on website memory's policy and site exclusions. It is changed by the owner, or by an agent request that the owner confirms.
- **Map counters**: aggregate numbers for one profile (lookups, hint uses that worked or failed, estimated savings). They hold no addresses, titles, names or origins.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: All AC-01–AC-35 pass in repeatable isolated acceptance tests with synthetic content, and each test reports its evidence.
- **SC-002**: In a synthetic site whose target page is three clicks from the home page, after one earlier visit, an agent with the map reaches the target with one page load in 100% of runs where the target is directly addressable. Page loads to reach the target drop by at least 50% compared with the same task without the map.
- **SC-003**: On a remembered page of the synthetic site, the agent uses the intended remembered control in one step, with no separate verifying read, and reaches its expected destination in 100% of runs where the control is unchanged. Where the control was removed or renamed, that step fails without clicking in 100% of runs; where its destination changed, the mismatch is reported in 100% of runs.
- **SC-004**: In the privacy fixture, zero planted markers appear in stored records, lookups, reminders, exports or diagnostics. Zero entries cross profiles, and zero entries come from disabled, excluded, private, vault-protected or unverified contexts.
- **SC-005**: Measured against map-off on the same synthetic workload, enabling the map keeps the combined website-memory overhead within 003's SC-005 limits (p95 at most 25 ms for navigation and 30 ms for a page read), and a lookup on an origin at its limits answers within 50 ms at p95. These limits are provisional; the owner confirms them after the first baseline run.
- **SC-006**: The map adds at most 600 characters to a navigation result. One lookup page returns at most 20 entries and at most 4,000 characters, and an outline (AC-33) at most 10 lines and 1,000 characters.
- **SC-007**: In the change fixture, every renamed, moved or removed control is marked not seen after the next complete read in the same read context in 100% of runs, and no such control is presented as current.
- **SC-008**: In the article fixture (AC-27) and the read-context fixture (AC-28), zero non-structural page entries are created and zero controls are falsely marked not seen, in 100% of runs.
- **SC-009**: In the site-change fixture (AC-30), after one failed hint and the agent's recovery through the new route, the next lookup lists the new address and control before the old ones in 100% of runs, and a later agent reaches the moved page with one page load.
- **SC-010**: In the fixtures, the counters (AC-35) equal the actual numbers of lookups and of hint uses that worked and failed in 100% of runs, and contain zero addresses, titles, names or origins.
- **SC-011**: In the data-changing fixture (AC-32), zero controls marked as acting on data appear in automatic reminders, and 100% of lookups that return one carry the confirm-with-user notice.

## Assumptions

- The feature extends 003 website memory and reuses its owner policy, scope verification, exclusions, owner confirmation, local storage, owner inspection tools and failure isolation. 003's rules for verified public facts are unchanged; map entries are a separate, profile-only kind of record.
- Only agents' own tool-mediated browsing is observed. Collecting the user's manual browsing would need a separate decision and specification.
- The browser profile is the boundary for account-specific structure. Several accounts used in one profile share one map. Personal names cannot be detected reliably, so a name such as the user's own name on an account-menu button may be stored. Such entries stay local in that profile and can be inspected and deleted by the owner. This residual risk is accepted only if the owner approves it at spec review.
- Addresses of public pages can reveal sensitive topics (for example health or debt), and masking does not detect them. The risk is limited because only structural pages are recorded, only agents' own browsing is observed, the enable prompt states that page addresses are recorded, and the owner can exclude sites and delete entries. This residual risk is accepted only if the owner approves it at spec review.
- A complete read is an unscoped page read that was not cut short. Its read context is 003's anonymity verdict for that read. Destinations are learned from a click followed by a page load in the same tab; how this is observed is decided in the plan.
- Limits on lengths, entry counts, reminder size and timing are provisional and confirmed in the plan after measurement, as in 003.
- The data-changing vocabulary (FR-015) and the savings estimate method (FR-016) are reviewed in the plan. The vocabulary can only over-match into a harmless loss of a reminder line; it is not a safety guarantee, and agents keep their normal confirmation rules for every control.
- No git branch is created; the specification lives in the current checkout. Formal planning follows the repository's spec review gate.
