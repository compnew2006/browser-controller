# Implementation Plan: Chrome action activity

**Branch**: 009-chrome-action-activity (proposed; not checked out) | **Date**: 2026-11-09 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from specs/009-chrome-action-activity/spec.md

## Summary

Add a dedicated Actions view to the existing Chrome extension popup. A bounded session-only event store will keep actual public page calls that reached the extension, group batch children by run, attach each event to its source document visit, and show confirmed/unknown dispatch separately from any observed page effect. Pair a numbered timeline with a host-only page context summary. Keep resolved element labels, clicked-element DOM ids, click counts, and history local to the current browser session, cap the store at 500 events, and never persist tool parameters or page output.

The feature evolves the existing repository at baseline 7b8c7d3e8816229d90b9fff46c867523e002cd0e. It is classified EVOLVE / CONTROLLED. The Owner reviewed the plan and authorized local implementation with “نفذ الخطة”; the reviewer-owned requirements checklist and formal acceptance remain open.

## Technical Context

**Language/Version**: TypeScript and ES modules; Node.js 22.23.1 is active.

**Primary Dependencies**: Existing Chrome MV3 APIs, WebSocket bridge, Vitest, and existing Zod tool registry. No dependency or version changes are planned.

**Storage**: chrome.storage.session, already used by extension/lib/state.js and extension/lib/vault-card.js; the extension already declares the storage permission. The new event store is isolated from chrome.storage.local and the filesystem.

**Testing**: Vitest for the bridge, extension dispatch, state store, protocol, and popup renderer. Local isolated-profile browser checks through Playwright for popup interactions and accessibility; no authenticated or normal-profile actions.

**Target Platform**: Chrome MV3 extension popup and the local MCP daemon/bridge.

**Project Type**: Existing multi-package TypeScript MCP server plus JavaScript Chrome extension.

**Performance Goals**: Event writes are bounded and queued off the browser-action critical path. The popup reads and renders no more than 500 events. A failed activity write must not change the result or timing contract of the browser action.

**Constraints**: Use a 500-event cap; bound host, tool, and element-detail sizes; retain only hostname and opaque visit identifiers; report confirmed/requested click counts per call; never persist raw tool parameters, field values, page output, full URLs, or credentials. Browser activity remains in the current browser session only.

**Scale/Scope**: One extension profile, up to 500 retained events, existing maximum browser_batch size of 50 child actions.

## Constitution Check

The root constitution.md and its Spec Kit mirror are proposed, not adopted. The mirror's recorded SHA-256 matches the root source fingerprint 2b2d4700e6364c1e898c90ddaff5923393bc977d605353286624c1d7b7f40b17. This plan uses the proposal as a risk checklist only; AGENTS.md and direct user instructions are the active project requirements.

| Check | Status | Evidence or gate |
|---|---|---|
| Mode and baseline | MET | Existing project feature; EVOLVE at the recorded baseline SHA. |
| Risk tier | CONTROLLED | Task classification: CONTROLLED because the feature records page-derived element details and changes tool/bridge behavior. |
| Direct authorization | MET FOR LOCAL WORK | Direct user message “نفذ الخطة”; scope and expiry are recorded in approvals/009-chrome-action-activity.md. |
| Machine-readable event contract | IMPLEMENTED LOCALLY | specs/contracts/chrome-action-activity.schema.json; focused event, privacy, renderer, and protocol tests pass. |
| Independent review | PENDING | Required before reporting implementation as formally accepted. |
| Spec Kit plan review | MET FOR IMPLEMENTATION | The Owner previewed the plan and then authorized implementation; the separate reviewer-owned requirements checklist remains unchecked. |
| CI/Owner acceptance | NOT FORMALLY ACCEPTED | Local implementation and checks are complete; CI, independent CONTROLLED review, and final Owner acceptance remain open. |
| External operations | OUT OF SCOPE | No fetch, install, external service call, authenticated page action, commit, push, or deploy is authorized. |

### Graph impact

- Codebase Memory MCP was refreshed for this exact root after implementation. Coverage metadata matches the relevant source files; `tests/extension-router.test.ts` has a parse-partial warning at line 24 and was read directly. See the evidence manifest for the checked generation.
- Graphify's local AST graph was refreshed with `graphify update . --no-cluster`: 6,761 nodes and 16,499 edges, with `graph.json` updated at local 08:33:59. A scoped query and `explain createInputActivity` show an EXTRACTED edge from `dispatch()` to `createInputActivity()`; the directed path is one hop. `GRAPH_REPORT.md` remains older than this checkout because the local no-clustering refresh does not semantically refresh documents; no external semantic refresh was authorized.
- Primary impact nodes/files: mcp-server/src/tools/batch.ts::runStep; mcp-server/src/tools/types.ts::ToolHost; mcp-server/src/vault/daemon-routing.ts; mcp-server/src/bridge.ts::callTool; mcp-server/src/protocol/capabilities.ts; extension/dispatch/router.js::dispatch; extension/handlers/interaction.js::handleClick; extension/lib/trusted-input.js; extension/lib/input-outcome.js; extension/events.js; extension/lib/state.js; extension/popup/popup.html and popup.js.
- The plan and its impact analysis were reviewed before implementation. Current Graphify evidence covers the checked-out source AST; verify runtime and cross-process behavior from source and tests because those edges cross the WebSocket/IPC boundary.

## Design Decisions

1. **Activity context is internal metadata, not a public tool parameter.** Create one immutable event ID per top-level page action or snapshot read and one batchRunId per browser_batch invocation. Pass a scoped context only to eligible calls actually sent to the extension. Snapshot rows store tool metadata only, never the returned page structure. Internal preflight calls, validation, waits handled entirely in the daemon, skipped steps, and unexecuted calls receive no activity context.
2. **Each actual child action is an event; the batch has only an end marker.** The extension deduplicates by eventId. Batch groups are formed from received events; there is no manifest of planned steps. The end marker contains only batchRunId, end time, and terminal batch state.
3. **Finish markers are connection-scoped.** The bridge records the exact extension connection selected for each dispatched child, keyed by the trusted IPC sessionId and batchRunId. The marker is sent only to those live connections. The participant map is bounded and expires; reconnects never inherit participants. If the bridge cannot confirm a finish, the UI retains the unconfirmed state.
4. **Input status comes from dispatch boundaries.** Instrument the existing trusted-input send path and action handlers. Do not derive dispatchStatus from MCP success, batch success, a receipt summary, or a later snapshot. An action whose attempted send lacks a confirmation is unknown. Site effects are separate evidence from extension-observed navigation/dialog/download events.
5. **The source visit is captured before dispatch.** Maintain an opaque pageVisitId per tab and top-frame document, rotate it on document commit, and leave it unchanged for SPA history updates. Persist enough bounded visit state in chrome.storage.session to survive worker restart. The event captures its source visit before navigation can change the tab.
6. **Use session-only storage with serialized mutations.** Store no more than 500 events; cap individual strings. A serialized writer applies append, trim, clear, and label erasure in order. A privacy-generation check prevents an in-flight write from restoring labels after the owner hides them. Logging failure never blocks or changes browser actions.
7. **Keep this separate from the current diagnostic logbar.** Add an Actions tab/panel and a small rendering module within the popup. Reuse the existing shell and theme; keep the existing logbar behavior unchanged.
8. **Render a numbered timeline beside safe page context.** Show tool names and sequence numbers with the host and latest outcome in a compact companion panel; never retain a page title, full URL, input value, page content, or screenshot. Derive a bounded accessible control name and DOM id from the resolved target when available; never copy the caller's selector as either value. Show confirmed clicks against the requested count for each tool call, with separate calls remaining separate rows. A single control hides and erases both labels and ids. Escape page-derived values before rendering.

## Project Structure

### Documentation

    specs/009-chrome-action-activity/
    ├── spec.md
    ├── plan.md
    ├── research.md
    ├── data-model.md
    ├── quickstart.md
    ├── tasks.md
    └── checklists/requirements.md
    specs/features/chrome-action-activity.md
    specs/contracts/chrome-action-activity.schema.json
    specs/evidence/chrome-action-activity/manifest.json
    approvals/009-chrome-action-activity.md

### Source Code and Tests (proposed scope)

    mcp-server/src/tools/batch.ts
    mcp-server/src/tools/types.ts
    mcp-server/src/bridge.ts
    mcp-server/src/protocol/capabilities.ts
    mcp-server/src/protocol/frames.ts
    extension/lib/protocol.js
    extension/dispatch/router.js
    extension/handlers/interaction.js
    extension/handlers/interaction-advanced.js
    extension/lib/trusted-input.js
    extension/lib/input-outcome.js
    extension/lib/state.js
    extension/lib/activity-log.js (new)
    extension/events.js
    extension/popup/popup.html
    extension/popup/popup.js
    extension/popup/activity-view.js (new)
    tests/tools/batch.test.ts
    tests/bridge.test.ts
    tests/extension-router.test.ts
    tests/trusted-input.test.ts
    tests/extension-activity-log.test.ts (new)
    tests/popup-activity.test.ts (new)

The Owner reviewed the plan and approved implementation; code-level impact analysis is recorded above and scoped additions were approved during execution. No new Chrome permission, dependency, or browser host permission was added. The batch-finish marker is gated by its optional internal protocol capability.

**Structure Decision**: Extend the existing batch tool, authenticated bridge, extension router, handler/input boundary, extension session state, and popup. Add focused extension activity store/view modules and tests. Do not create a second browser-action registry; derive eligibility from existing tool metadata.

## Validation Plan

1. Contract and unit tests: event schema bounds, event-ID deduplication, element-detail sanitization and privacy erasure, per-call click counts, storage queue ordering, toggle/clear races, 500-event trim and incomplete batch marking.
2. Dispatch tests: no event for daemon-only checks or non-dispatched steps; exact pageVisitId captured before a navigation; input status for confirmed, pre-send refusal, partial count, and unknown confirmation.
3. Batch/bridge tests: three separate runs with four actual click events, same event ID on retry, end-marker delivery only to actual live participant connections, and no participation after reconnect/profile change.
4. Popup tests: open/recently-closed group rendering, resolved DOM id and confirmed/requested click count, loading/empty/storage-error/truncation states, clear, hide-element-details control, English LTR and keyboard/focus.
5. Repository checks after implementation: npm run lint, npm run typecheck, npm run build, npm run test:coverage, npm run context:lint, npm run context:measure, and npm run arch:check. Run the focused suites first; do not install dependencies.
6. Local Playwright: exercise the popup against isolated fixtures and inspect keyboard flow, English LTR, narrow layout, and console/errors. Do not use an authenticated site or the Owner's normal browser profile.
7. Independent CONTROLLED review: inspect the complete diff and security boundaries; rerun any claimed checks. Record CI evidence separately. Do not run npm run security:audit without explicit external-service authorization because it contacts npm.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| A page label or DOM id contains personal data. | Disclose element details in the view, bound and store them only in session storage, provide an immediate hide-and-erase control, and never record form values or page output. |
| “Sent” is mistaken for “site accepted.” | Separate dispatchStatus from siteEffect and use explicit English wording that says the site did not confirm acceptance. |
| A timeout occurs after some input was sent. | Preserve per-action confirmed/uncertain/required counters; report unknown whenever an attempted send lacks confirmation; advise checking before retrying. |
| Activity writes race with clear or label removal. | Serialize storage updates and use a privacy generation check; test with delayed storage writes. |
| A batch marker is delivered to the wrong profile/session. | Track exact selected connection IDs per trusted IPC session and batch; never broadcast or carry participation across reconnects. |
| Activity creates a second tool policy table. | Derive capture eligibility from the current ToolDefinition metadata/category and test registry drift; do not hand-maintain an extension-side tool list. |
| Popup work degrades the existing layout or diagnostic bar. | Add a separate panel, reuse the current shell, and verify all existing popup controls after the change. |

## Complexity Tracking

No new runtime dependency, storage permission, external service, database, or package is planned. The optional bridge marker is a small internal protocol addition and remains subject to a mixed-version compatibility test.
