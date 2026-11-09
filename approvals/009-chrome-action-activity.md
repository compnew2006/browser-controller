# Authorization record: 009-chrome-action-activity

- **Approval-Ref**: APPROVAL-2026-11-09-CHROME-ACTION-ACTIVITY
- **Task ID**: 009-chrome-action-activity
- **Mode / risk**: EVOLVE / CONTROLLED
- **Plan**: specs/009-chrome-action-activity/plan.md
- **Specification**: specs/009-chrome-action-activity/spec.md
- **Approved environment**: Local repository, isolated extension test profile, local fixtures and local test services only.
- **Authorized actions**: Prepare the feature artifacts, then implement and locally verify the Actions view, bounded session-only event store, page-visit attribution, batch grouping/end markers, dispatch-status reporting, privacy controls, and focused tests inside the file scope below.
- **Direct authorization text**: “نفذ الخطة”
- **Authorization date**: 2026-11-09
- **Expires**: 2026-11-16
- **Status**: The Owner previewed and approved the implementation plan. Local work is authorized; the reviewer-owned requirements checklist, independent review, and formal acceptance remain open. This record does not declare the feature accepted.
- **Authorized follow-up**: On 2026-11-09, the Owner requested that click rows show the resolved page element's DOM id and the number of clicks. The change is bounded to 160 characters, uses the existing element-details privacy control, and does not retain locator parameters.

## File scope

- mcp-server/src/tools/batch.ts
- mcp-server/src/tools/types.ts
- mcp-server/src/index.ts
- mcp-server/src/daemon.ts
- mcp-server/src/daemon-config.ts
- mcp-server/src/ipc-frame-validation.ts
- mcp-server/src/vault/daemon-routing.ts
- mcp-server/src/bridge.ts
- mcp-server/src/protocol/capabilities.ts
- mcp-server/src/protocol/frames.ts
- extension/lib/protocol.js
- extension/lib/generated-contract.js (generated from the approved capability addition)
- extension/dispatch/router.js
- extension/handlers/interaction.js
- extension/handlers/interaction-advanced.js
- extension/lib/trusted-input.js
- extension/lib/input-outcome.js
- extension/lib/state.js
- extension/lib/activity-log.js (new)
- extension/events.js
- extension/popup/popup.html
- extension/popup/popup.js
- extension/popup/activity-view.js (new)
- tests/tools/batch.test.ts
- tests/daemon-ipc-validation.test.ts
- tests/bridge.test.ts
- tests/extension-router.test.ts
- tests/trusted-input.test.ts
- tests/input-aim.test.ts (authorized follow-up regression for resolved DOM id capture)
- tests/extension-activity-log.test.ts (new)
- tests/popup-activity.test.ts (new)
- specs/009-chrome-action-activity/
- specs/features/chrome-action-activity.md
- specs/features/README.md
- specs/contracts/chrome-action-activity.schema.json
- specs/contracts/README.md
- specs/evidence/chrome-action-activity/
- approvals/009-chrome-action-activity.md

## Explicit limits

No installs/upgrades, secret access, remote branch fetch, external service call, authenticated website action, normal-profile Chrome smoke, commit, push, deploy, data migration, or unrelated file change is authorized. Any new permission, dependency, or materially wider file scope requires the Owner's direct authorization.
