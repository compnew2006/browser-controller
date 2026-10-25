# Contracts: Browser Controller credential vault

## Public MCP tool: `browser_vault`

Strict operation-specific schemas; unknown keys are refused. No password, key, master password, browser ID, session ID, approval flag, script, arbitrary path, raw field value or clipboard payload is accepted.

| Action | Accepted public inputs | Safe result |
| --- | --- | --- |
| `list` | `tabId` | Approved same-origin metadata (`handle`, `label`, `identifier`, `origin`) or `user_action_required`. |
| `fill` | `tabId`, `handle` | `success`, `filled_fields`, `origin`, safe state/code; never value. |
| `save_login` | `tabId`, optional short `label` | `user_action_required`, `requestId`, verified site; later request state. |
| `status` | optional `requestId`, optional `tabId` as needed by strict schema | Locked/ready/private-request safe state only. |
| `unlock` | `tabId` | Private UI required or already unlocked; never accepts a secret/approval. |

Public unlock initiates a user operation and cannot unlock the local vault on the model's authority. Public metadata listing is origin/profile/session scoped and requires a valid grant. Tool writes are non-idempotent and never replayed automatically.

## Private extension UI RPC

Internal authenticated extension connection, separate message discriminator and request IDs. Background accepts UI messages only when `sender.id` and exact extension-owned page URL match. Daemon derives the browser scope from the authenticated connection, not a payload value. The UI page is not declared web-accessible.

Operations: safe status/list, approve/decline pending request, add/update/remove, lock/unlock, revoke grant, backup/list snapshots/restore. Only this private channel may submit credentials. Replies never reveal stored passwords; edits replace them without prefilling. Request ID + expected context + expiry are verified immediately before processing. Acknowledgments/error messages never reflect user-secret inputs.

No new public HTTP credential endpoint. No secret-bearing data in request URLs, process arguments, Chrome storage, global environment, diagnostics or public tool output.

## Internal browser actions

1. Inspection accepts tab and expected context; returns exact origin, document/frame/target identity, target suitability and one-use nonce, no values.
2. Fill accepts the daemon-resolved transient secret, expected origin/document/frame and inspection nonce. It marks protection before write, honors cancellation/locks, synchronously verifies the target and origin, then returns counts/safe state only.
3. Private UI request opens/refreshes the extension page with a non-secret request ID; no secret in URLs.

These actions are internal wire capabilities, not additional model-callable tools. Keep public manifest/drift checks explicit about that distinction. Sensitive action payloads cannot enter retry history or be re-sent on reconnect/timeouts.

## Safe errors/states

`VAULT_LOCKED`, `VAULT_USER_ACTION_REQUIRED`, `VAULT_DECLINED`, `VAULT_REQUEST_EXPIRED`, `VAULT_PERMISSION_DENIED`, `VAULT_ORIGIN_MISMATCH`, `VAULT_DOCUMENT_CHANGED`, `VAULT_TARGET_UNSAFE`, `VAULT_CONTEXT_PROTECTED`, `VAULT_RECOVERY_REQUIRED`, `VAULT_STORAGE_INVALID`, `VAULT_KEY_MISSING`, `VAULT_BUSY`, `VAULT_OUTCOME_UNKNOWN`.

Errors contain a known code and safe explanation, not exception dumps or user inputs. A timeout after dispatch reports unknown outcome and asks to inspect safe state before another explicit attempt. Cancellation removes pending grants/requests and never causes a later fill.

## Public output boundary

Daemon sanitizes all success/error/batch payloads recursively before IPC. Register literal and newline-normalized secret values before fill. Redaction covers all public text/structured content without retaining raw input in audit records. Protected documents block arbitrary evaluation, images and other raw disclosure/code injection paths before dispatch. Missing protection state fails closed. Exact-substring filtering does not claim detection of arbitrary page-side encoding.
