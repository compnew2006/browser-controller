# Research: Chrome action activity

**Baseline**: 7b8c7d3e8816229d90b9fff46c867523e002cd0e

This research is limited to the checked-out repository and local indexes. No external service or authenticated browser session was contacted.

## Decisions

### Session-only activity storage

- **Decision**: Use chrome.storage.session with a 500-event cap and bounded fields.
- **Evidence**: extension/lib/state.js persists locks and selector fallbacks in chrome.storage.session; extension/lib/vault-card.js also restores transient card state there. extension/manifest.json already declares the storage permission.
- **Rationale**: The Owner wants history to survive tab closure. Session storage survives extension worker recycling and tab closure, then ends with the browser session.
- **Alternatives considered**: chrome.storage.local would extend retention beyond the browser session and could retain page-derived labels longer than requested; in-memory maps would lose the history after a service-worker restart.

### Separate Actions view

- **Decision**: Add a dedicated Actions tab/view in the existing popup and leave the diagnostic logbar intact.
- **Evidence**: extension/popup/popup.js owns a three-tab shell and a separate 50-entry diagnostic logbar; extension/popup/popup.html contains the current popup markup and styles.
- **Rationale**: Browser action history has page groups, status, privacy controls, and recently closed visits that do not fit the transient diagnostic log.
- **Alternatives considered**: Replacing the logbar risks removing diagnostic behavior; a separate extension page or side panel is unnecessary for this request.

### Capture at the extension dispatch/input boundary

- **Decision**: Create an event only for a public page-action call that reaches extension dispatch, and record explicit input-send state at the handler boundary.
- **Evidence**: extension/dispatch/router.js dispatches registered tools to handlers. extension/handlers/interaction.js::handleClick resolves the target, calls cdpClickAt, inspects input outcome, and separately observes navigation/dialog state. extension/lib/input-outcome.js observes page input events but currently does not provide the complete multi-action dispatch contract required by this feature.
- **Rationale**: MCP or batch success does not prove an input reached the page or that the site accepted it. The event must reflect what the extension can actually confirm.
- **Alternatives considered**: Inferring status from a result's success flag or summary can misreport partial sends; observing the page after the fact can accidentally attribute unrelated page changes.

### Batch event grouping and finish signal

- **Decision**: Pass an internal batchRunId and per-child eventId out of band; record actual child calls as events and send one small end marker to exact participating connections.
- **Evidence**: mcp-server/src/tools/batch.ts::runStep executes each child through the tool handler and applies a per-step deadline. mcp-server/src/bridge.ts::callTool selects the extension connection and sendToolCall owns retries. mcp-server/src/vault/daemon-routing.ts forwards public tools with the trusted IPC sessionId.
- **Rationale**: The extension does not receive a browser_batch manifest, and the batch's completion happens after child calls. A targeted marker can close the group without revealing planned or skipped steps.
- **Alternatives considered**: Storing a manifest would expose unexecuted steps and planned targets; broadcasting completion could cross profile/session boundaries; inferring completion from the last child fails on timeout or disconnect.

### Stable page visit identity

- **Decision**: Capture an opaque pageVisitId before each action, create a new one on top-frame document commits, and keep it for SPA history changes.
- **Evidence**: extension/events.js handles top-frame webNavigation.onCommitted and tab removal; extension/lib/state.js centralizes service-worker state restoration.
- **Rationale**: A click may navigate the tab. The event belongs to the document that received the click, not the page loaded afterward.
- **Alternatives considered**: A tabId alone conflates successive documents; storing full URLs or titles risks exposing path/query data and page-derived personal information.

### Privacy, click counts, and honest status

- **Decision**: Show a bounded resolved control label and clicked-element DOM id by default, with one control that erases both. Show the confirmed click count against the requested count for each tool call. Do not retain raw inputs, results, snapshots, full URLs, or page bodies. Use dispatchStatus and siteEffect as separate fields.
- **Evidence**: extension/handlers/interaction.js reports target text and input details; extension/lib/input-outcome.js explicitly avoids returning sensitive field values in some cases, but generic handler result text can still include user data. The new event store must not persist these result strings.
- **Rationale**: The Owner requested the clicked element id and how many times it was clicked, while event history must not become a parallel page-content or credential log. Capture the id from the resolved page element, never from the caller's locator. Count confirmed mouse presses against that call's requested click count; repeated tool calls remain separate action rows.
- **Alternatives considered**: Storing whole MCP receipts or result text would be convenient but can include values, URLs, filenames, or page content. Hiding all element details by default would make the requested button-level activity harder to understand.

## Local implementation findings

- The popup's existing debug log is transient and capped at 50 rows; it is not persisted browser activity.
- The extension already has a storage.session permission and patterns for loading state before handling calls.
- browser_batch can finish without an extension call (for example, a daemon-only delay, preflight rejection, or a step skipped at the deadline). Such work must not be shown as a page action.
- The batch tool's internal retry for a per-session rate limit happens before a child call is dispatched; the bridge separately retries only tools marked idempotent. Event IDs must remain stable across transport retry.
- Graphify's source edges identify the extension dispatch-to-click relation with an inferred indirect-call hop. The runtime bridge relation crosses WebSocket messages and must be verified from source and tests, not inferred from the graph.

## Remaining acceptance checks

- Run the complete three-batch/four-click walkthrough with the loaded extension in an isolated Chrome profile; the current Playwright run exercised a mocked popup harness only.
- Obtain the independent CONTROLLED review and record CI and final Owner acceptance.
- Verify browser-session restart, tab close, and persisted `chrome.storage.session` behavior in the isolated extension profile; unit tests cover the store contract.

## Local implementation evidence

- Batch child metadata is scoped to action calls and the bridge sends the completion marker only to live, capability-enabled participant connections.
- Click rows receive the resolved control label and DOM id when available, plus confirmed/requested click counts. Labels never fall back to contenteditable or generic page text; hiding details erases both labels and ids.
- Source, unit tests, and the isolated popup fixture are the evidence for these changes; no authenticated site, normal Chrome profile, or external service was used.
