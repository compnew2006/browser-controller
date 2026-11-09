# Data model: Chrome action activity

## Action event

An event represents one public action call that reached extension dispatch. A stable eventId deduplicates transport retries.

| Field | Type | Rule |
|---|---|---|
| kind | literal action | Distinguishes action records from batch end markers. |
| schemaVersion | integer | Starts at 1. |
| eventId | UUID string | Stable for one tool invocation across retries. |
| tabId | non-negative integer | Local tab identifier; not a credential. |
| pageVisitId | UUID string | Identifies the source top-frame document. Captured before dispatch. |
| host | hostname string | Hostname only; no scheme, port, path, query, or fragment. |
| tool | bounded tool name | Public browser tool that actually reached extension dispatch. |
| operation | bounded operation enum | Action category such as click, type, fill, drag, navigate, scroll, or dialog. |
| startedAt / endedAt | ISO timestamp | End is absent while running and set only after extension observes a terminal result. |
| executionStatus | enum | running, completed, failed, or unknown. A missing terminal response is unknown. |
| dispatchStatus | optional enum | not_sent, partially_sent, sent, or unknown for input actions. |
| inputCounts | optional object | confirmed, uncertain, and required user-visible input units; counts must satisfy confirmed + uncertain <= required. |
| targetLabel | optional bounded string | Resolved control name only when labels are enabled. No raw selector or typed value. |
| targetElementId | optional bounded string | The resolved page element's HTML `id` for a click, only when element details are enabled. No caller selector; capped at 160 characters and rendered as text. |
| siteEffect | optional object | Explicit extension observation such as navigation, dialog, or download; never inferred from dispatch alone. |
| batchRunId | optional UUID string | Present only for an actual browser_batch child call. |
| batchStepIndex | optional integer | Actual child's 1-based source index; no planned-step count is recorded. |

## Page visit

A page visit is identified by pageVisitId and carries only tabId and hostname in retained events. The popup compares retained visits with the current tab list to label them open or recently closed. It does not persist a tab title or full URL.

## Batch end marker

| Field | Type | Rule |
|---|---|---|
| kind | literal batch-finished | Small internal message from the daemon bridge. |
| schemaVersion | integer | Starts at 1. |
| batchRunId | UUID string | Matches the actual child events. |
| endedAt | ISO timestamp | Time the daemon batch invocation reached a terminal state. |
| executionStatus | enum | completed, failed, aborted, or unknown. |

The marker contains no session ID, connection ID, step list, parameters, or child result.

## Session storage envelope

One versioned key in chrome.storage.session stores:

- schema version;
- at most 500 deduplicated events;
- a bounded current-visit map for open tabs, containing only tabId, pageVisitId, and hostname;
- a global historyTruncated flag;
- bounded batchRunIds for still-visible groups whose earlier events were evicted;
- the session-scoped includeElementNames preference, which controls both targetLabel and targetElementId.

Each mutation is serialized. Clear empties events and truncation metadata. Hiding element details removes targetLabel and targetElementId from every saved event and increments a write generation so queued writes cannot restore them. A new browser session starts with an empty store and element details enabled.

## State transitions

- Event creation: absent → running.
- Known no-input refusal: running → failed with dispatchStatus not_sent.
- Fully confirmed input send: running → completed or failed according to the handler result, with dispatchStatus sent. This does not mean the site accepted the action.
- Some confirmed input units and known remaining units not attempted: terminal handler state with dispatchStatus partially_sent.
- Any started send without a reliable confirmation, lost response, or worker interruption: dispatchStatus unknown; unknown takes precedence.
- Batch group: absent → has actual child events → end marker received. Without a marker, the group is visibly unconfirmed.

## Deliberately absent data

No raw MCP parameters or selectors, text typed, form values, snapshots, page text, evaluate results, screenshots, full URL, tab title, cookies, credentials, browser IDs, client session IDs, or extension secrets are stored in the activity record. The explicitly requested resolved DOM id is the only page element identifier retained, and it is bounded and erased by the element-details control.
