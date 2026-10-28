# Feature Specification: direct routing from the site map

**Feature Branch**: Not created; specification is in the current checkout.

**Created**: 2026-10-28

**Status**: Draft; the owner waived the review pauses (see Clarifications).

**Input**: User description: "المفروض يبقي في نظام routing افضل بدل ما يلف كل الصفحات دي علشان يوصلل للصفحة اللي هو عايزها"

English summary of the input: there should be a better routing system, so the agent stops going through all these pages to reach the page it wants.

**Builds on**: [004 site navigation map](../004-site-navigation-map/spec.md). Every 004 rule on scope, exclusions, profiles, masking, bounds, untrusted hints, data-changing controls, deletion and failure isolation applies unchanged unless a requirement below says otherwise.

## Evidence that motivated this feature (2026-10-28, `https://arkan-aser.odoo.com`)

The agent was asked to open the branch point of sale (`/pos/ui/1/floor`). In every attempt it walked `www.odoo.com/ar/my/databases` → `arkan-aser.odoo.com/odoo` → `/odoo/point-of-sale` → "Continue Selling". The stored map for the site afterwards held three entries: `/odoo` (no controls), `/web/login` (not addressable) and `/odoo/point-of-sale` (the "Continue Selling" control with no destination).

- **E1**: The map was off for the profile during the first run. It was enabled in the middle of the second run.
- **E2**: The click on "Continue Selling" changed the address a moment after the click's own check. The click therefore returned `EXPECTATION_FAILED`, and the map ignores every failed click that is not a locator failure, even when the action completed.
- **E3**: In an earlier attempt, the agent clicked "Continue Selling" without first reading `/odoo/point-of-sale` completely, so the click could not be attributed.
- **E4**: The agent then read `/pos/ui/1/floor` completely, but 004 records a page only when it is the root, a destination of an observed click, a page a control was used from, or a landing page. A page that was read and left creates no entry, so the target page was never remembered.
- **E5**: The site's applications are `option` entries in a list box. They are not eligible controls in 004, so `/odoo` holds no controls.
- **E6**: When the session for `arkan-aser.odoo.com` had ended, the direct address landed on `/web/login`. The owner signs in through another site (`www.odoo.com/ar/my/databases`, then the database's "Connect" control). Those controls sit inside a table, which 004 never reads, so nothing told the agent where the way in was.

## Clarifications

### Owner decisions, 2026-10-28

- Q: What may the map remember so that the agent can open the target page directly? → A: Any page that an agent read completely. A complete read of an addressable page in scope creates or refreshes a page entry with its direct address. This replaces 004's rule that a page read and left is not recorded (004 clarification "Which pages are recorded?", SC-008 for the article fixture). The map also records which other site an agent entered a site from, so that the agent knows the way in when a remembered address asks for sign-in.
- Q: Should work pause for spec and plan review? → A: No. The owner said, before going to sleep: "متوقفش تاني من دلوقتي الا لما تخلص … ولا تسأل ولا اي حاجة" (do not stop until finished; do not ask). Defaults below are chosen from the evidence and the 004 rules.

### Defaults chosen without asking

- A route is computed when a lookup is made, from the stored pages, controls and destinations. The map still stores no ordered list of steps (004 rule kept).
- Application launchers built from `option` entries (E5) stay ineligible. Options are often record data, and the direct address of the page they lead to is now remembered anyway.
- A page the tab reached through a content link, or from another site (by a click or a redirect), gets no entry from its reads until an agent opens it by address. Found during implementation: without this, 004's privacy tests fail (SC-004), because a content link's address can name the content (004 R-10, RV-01) and a sign-in flow through another origin must record that origin only (004 RV-05). On a page the map has read, a click whose target is not a stored control counts as a content click; this includes the `option` launchers of E5.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Open a page the agent read before (Priority: P1)

An agent reached `/pos/ui/1/floor` once and read it completely. Later, a new agent session is asked to open the point of sale. Its lookup for "POS" returns the address, and it opens the page with one navigation, without the home page or the application menu.

**Why this priority**: It removes the long route in the evidence. It is the owner's main request.

**Independent Test**: In a synthetic site, read a page three clicks deep by address and leave it. A lookup in a new session returns its address first, and one navigation reaches it.

**Acceptance Scenarios**:

1. **Given** an agent read an addressable in-scope page completely, **When** a lookup matches its title or path, **Then** the lookup returns the page's direct address and title.
2. **Given** a scoped, truncated, error or excluded read, **When** it ends, **Then** no new page entry is created from it.
4. **Given** the tab reached a page through a content link, or from another site, **When** the page is read completely, **Then** no new page entry is created from it until an agent opens the page by address.
3. **Given** a page whose path holds masked values or whose address had a query, **When** it is read completely, **Then** its entry is not addressable, as in 004.

---

### User Story 2 - Learn where a click led even when the page changes late (Priority: P1)

A click whose action completed is learned with its real destination, including when the site changes the address shortly after the click returns or the click's postcondition check failed.

**Why this priority**: Without it, routes inside single-page applications are lost (E2).

**Independent Test**: In a synthetic single-page site, a button changes the address 300 ms after the click. A click with a failing address expectation, followed by a complete read of the new page, records the destination.

**Acceptance Scenarios**:

1. **Given** a click returned `EXPECTATION_FAILED` and the tab is on a new same-origin address, **When** the result is captured, **Then** the click and its destination are recorded as for a completed click.
2. **Given** a click that reported no address change, **When** the same tab's next complete read within 120 seconds shows a new same-origin address and no other action ran in that tab in between, **Then** that address is recorded as the click's destination.
3. **Given** any other failed click, **When** it is captured, **Then** 004's failure rules apply unchanged.

---

### User Story 3 - Know the way in when a remembered page asks for sign-in (Priority: P2)

When the remembered address now lands on a sign-in page, the lookup says so and names the page on another site that the agent last entered this site from. After signing in there, the agent opens the remembered address directly instead of clicking through the site.

**Why this priority**: Signed-out runs otherwise fall back to the long route (E6).

**Independent Test**: In two synthetic sites, a control on site A's portal page opens site B. Later, B's remembered address lands on B's sign-in page. The lookup for B names A's portal page as the last entrance.

**Acceptance Scenarios**:

1. **Given** an agent's click on an in-scope page of site A took the tab to in-scope site B, **When** B is then read, **Then** B's map records an entrance from A's page address, whether or not the control on A was eligible.
2. **Given** site A is excluded, disabled, private or not in scope, **When** such an arrival happens, **Then** no entrance is recorded.
3. **Given** a remembered page whose last direct open landed on a sign-in page, **When** it is looked up, **Then** the lookup shows that sign-in is expected and lists the most recent entrances.

---

### User Story 4 - Get a computed route to a page without its own address (Priority: P2)

When the target page or control has no direct address, the lookup returns the shortest known route from an addressable page: open this address, then use these controls.

**Why this priority**: Some application screens can only be reached by clicks.

**Independent Test**: In a synthetic site, a non-addressable page is reached from an addressable hub through two remembered controls. The lookup returns the hub's address and the two locators in order.

**Acceptance Scenarios**:

1. **Given** recorded destinations connect an addressable page to the target, **When** the target is looked up, **Then** the lookup shows at most 4 steps, each with a ready locator.
2. **Given** a path needs a control marked as acting on data, **When** routes are computed, **Then** that path is not offered.
3. **Given** no recorded path exists, **When** the target is looked up, **Then** the lookup shows no route and keeps 004's output.

---

### User Story 5 - See the known pages on arrival (Priority: P3)

After a navigation to a site with known pages, the reminder names a few of them with their addresses, so the agent can jump without a separate lookup.

**Why this priority**: It saves one tool call per task; the lookup already covers it.

**Independent Test**: After two pages are recorded, a navigation to the site's root shows both addresses in the reminder within 004's size bound.

**Acceptance Scenarios**:

1. **Given** a site with addressable page entries, **When** an agent navigates to it, **Then** the reminder lists up to 3 of them, most recently used or seen first, within 004's 600-character bound.

### Edge Cases

- The landing page of a sign-in redirect has a query (`/web/login?redirect=…`); it stays not addressable and is never offered as a target.
- Many pages read by address in one site: 004's per-origin bound removes the least recently seen first.
- A page read in another context (public versus signed-in): one entry, contexts recorded as in 004.
- A complete read of a page at its masked form only (digits masked): recorded, not addressable.
- An entrance from a page whose path is masked: the masked path is stored and shown as not addressable.
- An entrance loop (A → B → A): each site records its own entrance; no route crosses origins.
- A late address change caused by something other than the click (a timer redirect): attributed only when no other action ran in that tab inside the window; otherwise nothing is attributed.
- A route through a control that no longer exists: route steps follow 004's ranking, so a failed control ranks lower and the route is recomputed at the next lookup.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: A complete, unscoped, untruncated read of an in-scope page with a successful status MUST create or refresh that page's entry, in addition to 004's reasons. Its direct address MUST be kept when 004 deems the page addressable. A page that the tab reached through a content link, or from another site, MUST NOT get an entry from such a read until it is opened by address (004 R-10, RV-01, RV-05). [US1]
- **FR-002**: A click that returned `EXPECTATION_FAILED` MUST be captured as a completed click, using the address the tab is on after it. [US2]
- **FR-003**: A click that reported no address change MUST stay pending for its tab for 120 seconds. The tab's next complete read on a new same-origin address MUST record that address as the click's destination, unless another action ran in that tab first. [US2]
- **FR-004**: When an agent's click on an in-scope page of one site takes the tab to another in-scope site in the same profile, the arriving site's map MUST record an entrance: the source origin, the source page's masked path, and the time. It MUST NOT store the source control's name or any content-area text. At most 5 entrances per site are kept, most recent first. [US3]
- **FR-005**: A lookup for a page whose last direct open landed on a sign-in page or another address MUST say so and list the site's entrances. [US3]
- **FR-006**: A lookup that matches a page or control MUST return the page's direct address first when it is addressable. When it is not addressable, it MUST return the shortest route of at most 4 control steps from an addressable page, computed from recorded destinations at lookup time. Routes MUST NOT include controls marked as acting on data or controls whose last use failed more recently than it worked. [US1, US4]
- **FR-007**: The navigation reminder MUST list up to 3 addressable page entries of the site with titles, most recently used or seen first, inside 004's reminder bound (SC-006). [US5]
- **FR-008**: The lookup's tool description and the agent guidance MUST tell agents to check the map before clicking through a site, to open a remembered address directly, and, when it lands on sign-in, to use the listed entrance and then reopen the address. [US1, US3]
- **FR-009**: Every new record (page entries from FR-001, entrances, pending clicks) MUST follow 004's scope gate, exclusions, masking, bounds, deletion, export, tombstones and per-profile isolation. Entrances MUST be removed when either site's entries are deleted or the site is excluded. [all]

### Key Entities *(include if feature involves data)*

- **Page entry** (004, extended): may now be created by a complete read.
- **Entrance**: a record on the arriving site of the source origin, the source page's masked path and the time an agent's click brought the tab in from that other site.
- **Route** (computed, never stored): an addressable start page and up to 4 control locators, derived from recorded destinations.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In a synthetic replay of the evidence (a hub, a menu page and a target reached through a late single-page address change), after one earlier run, a new session reaches the target with one lookup and one navigation in 100% of runs while signed in.
- **SC-002**: In the same replay while signed out, the agent's lookup names the entrance page in 100% of runs, and the target is reached without clicking through the site's own menus.
- **SC-003**: E2, E3 and E4 each have a regression test that fails before the change and passes after it.
- **SC-004**: All existing 004 privacy, scope and bound tests still pass, except the article fixture's "no entry" outcome, which this feature replaces on purpose.
- **SC-005**: The reminder stays within 600 characters, and a lookup with a route stays within 4,000 characters.

## Assumptions

- The agent still decides whether to follow a hint. Hints never authorize actions (004 FR-009).
- Sign-in itself stays the job of the owner or the credential vault ([006](../006-vault-site-approval/spec.md)); the map only remembers where the way in was.
- The owner enables the map for a profile with `browser_memory_policy {action:"map_enable"}` or the CLI, as in 004.
