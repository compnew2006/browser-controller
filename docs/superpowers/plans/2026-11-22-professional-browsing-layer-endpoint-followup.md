# Daemon → popup task endpoint — follow-up design note

Status: **parked** (final review, 2026-11-22). This note records the decided
design so the endpoint can be built later without re-litigating it. Nothing
in this note is implemented: the popup today shows only tasks waiting on a
question and only what the popup session has seen (see
`extension/popup/task-panels-view.js`), and FR-018 is recorded as a
documented limitation in `specs/011-professional-browsing-layer/spec.md`
until this endpoint lands.

## Problem

FR-018 requires the popup **Tasks** panel to show state AND steps and the
**Evidence** panel to show the report summary. The daemon never sends the
popup a task list or an evidence report — the status payload carries only
the pending questions — so the panels cannot show either, and the shipped
copy says so honestly ("No task waiting for an answer",
"Evidence · this popup session") instead of overclaiming.

## Decided wire: the daemon reads task files on each push

- **No new wire action.** The task files under the local tasks dir are
  already the source of truth. On each push the daemon reads them with
  `listTasks` plus the per-task report (the `report` already persisted on
  each settled/paused record by `saveTaskWithReport`), and sends the
  result down the existing daemon↔extension channel.
- Pushes happen only on pause, resume, settle, and (re)connect — so the
  read cost is negligible, and there is no polling of the task files.
- The MCP process does **not** notify the daemon: the daemon is the
  process that owns the bridge, and it re-reads at the moments above.

## Visibility rule: the popup is the browser owner's view

- The popup shows **all tasks in the local tasks dir**, most-recent-first,
  capped at e.g. 20 — regardless of `sessionId`. The popup is the view of
  the person who owns the browser, showing what agents are doing in their
  browser.
- `sessionId` stays on the task record for a different job: choosing the
  daemon-side resume host — a resume acts as the session that opened the
  task's tabs, so its tabs stay actable instead of `TAB_LOCKED`.

## The `taskStatus` control message

- New control message type `taskStatus`, sent with `bridge.sendControl`
  on the same channel as `taskQuestion`.
- Payload field (new): `tasks` — one entry per task, most-recent-first,
  capped at 20, each `{ id, goal, state, steps: [{ step, tool, status }],
  report? }` where `report` is the persisted evidence report
  (`{ text, json }`) when the task has settled or paused, and the steps
  carry the same per-step status the `browser_task_status` tool returns.
- The background worker forwards the latest `taskStatus` payload in its
  `getStatus` response (same shape as `taskQuestions` today), so the
  popup polls nothing new.

## Extension store: the `task-questions.js` pattern

- A small store module next to `task-questions.js` holds the latest
  `taskStatus` payload, keyed by task id, and re-renders on change.
- Rendering is guarded by a signature (the `taskPanelsSignature` pattern):
  skip re-rendering when the payload is unchanged, so the 2 s poll does
  not flicker the panels.
- The store keeps the last payload across popup reopens in memory only —
  like the question store, it is rehydrated from the next `getStatus`.

## Panel rendering from the new payload field

- **Tasks** renders each entry from `tasks`: state badge, goal, and its
  steps with per-step status — a running task is visible with its steps,
  not only a task waiting on a question.
- **Evidence** renders the selected task's report summary (`report.text`,
  falling back to the structured `report.json` sections) instead of the
  popup-session Q&A. The session Q&A list stays as a secondary view only
  if the panel keeps it — it must not be labelled as the report.
- The empty states change with the payload: "No tasks yet" when the list
  is empty, and "No report yet" for a task that has never settled.

## Tests

- **Bridge e2e**: the daemon pushes `taskStatus` on pause, on resume, on
  settle, and on (re)connect, with the task list most-recent-first and
  capped at 20; a task that settles after the push is reflected in the
  next push.
- **Popup rendering tests** (Node, on the `task-panels-view.js` pattern):
  a task with steps renders state + steps; the Evidence panel renders the
  report summary; the 20-task cap and most-recent-first order hold; an
  empty list renders the new empty state.

## Out of scope for this note

- No resume button in the popup is decided here: if one is added, it
  triggers the daemon-side resume for that task's session (the same
  `resumeAfterLogin` + `runTaskWithReport` path `browser_task_resume`
  drives from the MCP side), it does not invent a second resume path.
- No change to the task file format, the report shape, or the
  `browser_task_*` tools.
