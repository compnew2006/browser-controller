# Feature Specification: Chrome action activity

**Feature Branch**: 009-chrome-action-activity (proposed; not checked out)
**Created**: 2026-11-09
**Status**: Draft — Spec Kit review pending
**Input**: Show a numbered timeline of browser-agent steps in the extension popup beside a privacy-safe summary of the page, including browser_batch runs, clicked elements, and what the extension can confirm.
**Mode**: EVOLVE
**Risk tier**: CONTROLLED (per task classification; independent review and formal acceptance pending)
**Baseline**: 7b8c7d3e8816229d90b9fff46c867523e002cd0e

**Authorization**: The Owner wrote “نفذ الخطة” in the direct conversation on 2026-11-09. This authorizes local implementation and verification inside the recorded scope. It does not authorize commit, push, deploy, external services, authenticated-site actions, or use of the Owner's normal Chrome profile.

## User Scenarios & Testing

### User Story 1 — See the agent's page actions (Priority: P1)

As the browser owner, I want to open the extension popup and see the actions the agent actually sent to each page, grouped by browser_batch run, so I can tell which buttons it tried and whether the extension observed the input.

**Why this priority**: This is the requested feature and provides its main value.

**Independent Test**: In an isolated browser profile, run three batches that perform four button clicks in total. The popup shows three distinct batch groups and exactly four performed click rows, with the resolved button label where available. Internal checks, delays, unexecuted steps, and retries do not appear as extra actions.

**Acceptance Scenarios**:

1. **Given** a batch with four dispatched button clicks, **When** the owner opens the Actions view, **Then** each click appears once under that batch run and carries its own tool, page visit, and observed dispatch state.
2. **Given** three separate browser_batch calls on the same page, **When** the owner views the history, **Then** the three calls remain separate groups.
3. **Given** a batch stopped before a step reached the extension, **When** the owner views history, **Then** that unexecuted step is not presented as an action.
4. **Given** the same child call is retried by transport, **When** the popup refreshes, **Then** its stable event identity prevents a duplicate row.

### User Story 2 — Find activity for open and recently closed tabs (Priority: P2)

As the browser owner, I want activity to remain available after a tab closes and to be grouped by the page visit that received the action.

**Why this priority**: Closing a tab must not erase the evidence the owner opened the popup to inspect.

**Independent Test**: Perform an action, close the tab, reopen the popup, and verify the action remains under its host and local tab/visit label until the browser session ends.

**Acceptance Scenarios**:

1. **Given** an action followed by a top-frame document navigation, **When** the history is viewed, **Then** the action stays on the source visit and later actions use the new visit.
2. **Given** an SPA history change without a new document, **When** the history is viewed, **Then** it remains on the same visit.
3. **Given** the source tab is closed, **When** the owner opens the popup, **Then** the recorded visit and its actions remain available for the current browser session.
4. **Given** the browser session ends, **When** a new session begins, **Then** the previous activity is absent.

### User Story 3 — Understand status without exposing page data (Priority: P3)

As the browser owner, I want clear, honest statuses and a way to remove page-derived labels, without saving typed values or page contents.

**Why this priority**: A misleading “done” status or stored form value would make the activity feed unsafe and untrustworthy.

**Independent Test**: Exercise a confirmed click, a click rejected before input, a two-click operation interrupted after one confirmed click, and a send whose result is unknown. Verify the status wording and inspect the session store for excluded data.

**Acceptance Scenarios**:

1. **Given** an input command was sent, **When** its handler returns, **Then** the feed says the input was sent and does not claim that the site accepted it.
2. **Given** an input started but no confirmation arrived, **When** the feed is viewed, **Then** it says the outcome is unknown and advises checking the page before retrying.
3. **Given** a click count of two has one confirmed click and the next click was not started, **When** the feed is viewed, **Then** it reports one confirmed click and one not sent.
4. **Given** element details are hidden, **When** the setting is changed, **Then** future labels and clicked-element DOM ids are not recorded and old details are removed from stored events.
5. **Given** the event cap removes history, **When** a batch is only partly retained, **Then** the UI marks that group as incomplete.
6. **Given** the owner clears activity, **When** the popup refreshes, **Then** events and truncation markers are gone.

## Edge Cases

- The extension worker restarts while an event or batch is still in progress. Persist only the bounded record; an event without a terminal confirmation remains unknown, and a batch without its end marker is labelled unconfirmed.
- Chrome disconnects or changes the selected profile between child calls. A finish marker is sent only to live extension connections that received a child call for that batch; a new connection never inherits participation.
- A page navigation races an action. Capture the current pageVisitId before dispatch so the action stays attached to the page that received it.
- The event storage write fails. The page action still completes or fails normally; the UI reports that history is unavailable or incomplete.
- A page label or DOM id is too long, contains markup, or may include personal data. Bound it, render it as text, and let the owner hide and erase element details.
- The history limit removes an event from a still-visible batch. Mark the group incomplete instead of implying that all actions remain.
- A batch uses a delay, validation, safety probe, or another operation that never reaches extension dispatch. Do not record it as a performed page action.

## Requirements

### Functional Requirements

- **FR-001**: The extension MUST expose a dedicated Actions view in the existing popup while preserving existing tabs and the diagnostic log.
- **FR-002**: The system MUST record bounded metadata for public page-action calls and `browser_snapshot` calls that actually reach extension dispatch for a page. A snapshot row MUST contain only the tool/operation, page visit, and bounded timestamps/status; it MUST NOT retain snapshot output. The system MUST NOT create rows for daemon-only preflight, validation, delays, skipped steps, or retries of an event already recorded.
- **FR-003**: The system MUST group actual `browser_batch` child calls that have activity metadata by a stable batchRunId and show separate groups for separate batch calls. It MUST NOT store or display an unexecuted-step manifest.
- **FR-004**: Each action event MUST carry a stable eventId, the tool and operation, a pageVisitId, a hostname-only page label, a bounded start/end time, and an explicit execution status. When element details are enabled, a click event MAY carry a bounded resolved control label and the resolved target's DOM id; it MUST NOT copy the caller's selector.
- **FR-005**: The system MUST capture pageVisitId before dispatch. A top-frame document navigation creates a new visit; SPA history changes stay in the current visit.
- **FR-006**: The event feed MUST distinguish input dispatch from site acceptance. For input actions, dispatchStatus MUST distinguish not_sent, partially_sent, sent, and unknown; unknown takes precedence whenever an attempted send lacks confirmation. Counts MUST distinguish confirmed, uncertain, and required input units. Each click row MUST show confirmed clicks against the requested count. English copy MUST say “Click sent; the site did not confirm acceptance” for a confirmed send without a site effect and “The click may or may not have been sent—check the page before retrying” when delivery is unknown.
- **FR-007**: The system MUST report site effects only when the extension observed evidence such as navigation, a dialog, or a download. A tool result, batch result, or input dispatch alone MUST NOT be described as site acceptance.
- **FR-008**: The extension MUST retain the bounded activity through tab closure and service-worker restarts for the current Chrome browser session, and clear it when that session ends. The owner MUST be able to clear it manually.
- **FR-009**: The event history MUST contain no raw tool parameters, typed values, form values, page snapshots/text, evaluation output, screenshots, full URLs, URL paths, query strings, or browser/session credentials.
- **FR-010**: Element details MUST be shown by default and rendered as text. Details include resolved control labels and a click target's DOM id when present; each value MUST be bounded. Labels MUST come from a resolved control's accessible/control name and MUST NOT fall back to contenteditable text, generic page text, or field values. A single control MUST hide details, erase saved labels and DOM ids, and prevent in-flight writes from restoring them.
- **FR-011**: The history MUST be capped at 500 events. The UI MUST disclose truncation and mark a still-visible batch group incomplete when one of its events was evicted.
- **FR-012**: A batch-end marker MUST contain only the run ID, end time, and terminal batch status. The bridge MUST send it only to live extension connections that received a child action for that exact trusted IPC session and run. It MUST NOT broadcast the marker or carry participation across reconnects.
- **FR-013**: The Actions view MUST match the existing English LTR popup, show numbered tool names beside a page-context summary containing only the host and latest outcome, provide loading, empty, storage-error, and truncated states, and remain keyboard-accessible.
- **FR-014**: The Actions view MUST organize recorded visits under open pages or recently closed pages while retaining only hostname and local tab/visit labels.

### Acceptance Criteria

- **AC-1**: Top-frame document visits and SPA history changes produce the attribution described in FR-005.
- **AC-2**: Three batch runs containing four actually dispatched button clicks produce three distinct groups and four action rows; internal probes, skipped steps, and retries produce no extra row.
- **AC-3**: Input dispatch states and counters follow FR-006, including a two-click sequence interrupted after its first confirmed click; site acceptance is never inferred.
- **AC-4**: Hiding element details removes existing saved labels and DOM ids and prevents a queued write from restoring either; no raw inputs, outputs, selectors, or page content appear in the session store.
- **AC-5**: Activity survives tab close and service-worker restart, is cleared with the browser session or the manual Clear action, and obeys the 500-event cap and truncation indication.
- **AC-6**: Batch end markers reach only live connections that actually participated for the matching trusted session and run, including disconnect and profile-switch cases.
- **AC-7**: The popup view organizes open and recently closed visits and passes English LTR, keyboard/focus, loading/empty/error, narrow stacked layout, and wide timeline-plus-page-context layout checks without breaking the existing popup.
- **AC-8**: Each click row shows the resolved DOM id (or states that no id was available) and the confirmed/requested click count. Hiding element details removes labels and ids from display and storage.

### Key Entities

- **Action event**: A bounded record of a public browser action that reached extension dispatch.
- **Page visit**: An opaque identifier for one top-frame document, labelled only by hostname and local tab/visit markers.
- **Batch run**: An opaque identifier grouping only browser_batch child calls actually delivered to the extension.
- **Activity settings**: Session-scoped element-detail visibility and history-clear state.

## Success Criteria

### Measurable Outcomes

- **SC-001**: The isolated-profile scenario in AC-2 yields exactly three batch groups and four click records.
- **SC-002**: Across all status-state tests, every input action reports the correct dispatch state and counters, with zero claims of site acceptance based only on dispatch.
- **SC-003**: A serialized activity store contains none of the excluded fields in FR-009, and the element-detail-hide test leaves zero stored target labels or DOM ids.
- **SC-004**: After closing the action tab and restarting the extension worker, every retained event remains available until the browser session ends or the owner clears it.
- **SC-005**: The store contains at most 500 events and visibly reports evicted history.
- **SC-006**: Batch-finish routing tests prove no marker is delivered to a non-participating connection or a reconnecting connection.
- **SC-007**: A click with a resolved DOM id and a multi-click count renders both accurately; hidden element details leave no labels or ids in retained events.

## Assumptions

- The existing extension popup is the intended surface; the new Actions view is separate from the popup's diagnostic log.
- “Keep after tab close” means until the Chrome browser session ends. Activity does not persist across browser sessions and is not exported or synced.
- The owner wants button/control names visible by default, with an immediate privacy control that removes old labels.
- The requested identifier is the resolved page element's HTML `id`, not the locator string supplied to the tool. Click totals are shown per tool call; repeated calls remain separate action rows in their batch.
- A hostname and local tab/visit marker are enough to identify a page without retaining its title or URL path.
- This version records only calls routed to the extension; daemon-only work is not represented as browser activity.
- Private credential-vault workflows and authenticated live-site verification remain separate security surfaces and are out of scope for the first version.
