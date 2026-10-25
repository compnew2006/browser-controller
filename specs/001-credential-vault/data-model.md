# Data model: خزنة تسجيل الدخول بطريقة Hermes

## Stored login

- `id`: opaque random handle, no secret/username encoded in it.
- `kind`: `login` for V1 only.
- `label`, `identifier`: bounded user text; encrypted at rest, authorized metadata in results.
- `password`: bounded non-empty secret; encrypted at rest, never model-facing.
- `origin`: canonical exact origin, explicit HTTPS or loopback fixture HTTP.
- `browserScope`: namespace derived from a verified browser connection identity.
- `createdAt`, `updatedAt`: timestamps; no secret-derived values.
- Validation rejects unknown fields/kinds, invalid origins and oversized records/envelopes.

## Encrypted store

Versioned envelope: authenticated version + namespace, fresh nonce, ciphertext, authentication tag. Separate random key; no plaintext metadata file. Directory and files have owner-only permissions and validated ownership/type. First initialization is allowed only when no existing vault state requires recovery. Store lock and atomic replacement preserve committed writes.

## Grant

`grantId`, `sessionId`, `browserScope`, `origin`, optional selected `credentialId`, purpose (`list`/`fill`), creation/expiry, revocation state. The session ID stays in memory only; the durable audit records a daemon-ephemeral HMAC pseudonym instead. Created from a genuine private user action only; never from page text or a tool boolean. Session end/profile change invalidates it. A session grant does not unlock other profiles.

## Private request

`requestId`, purpose (`approve`/`save`/`unlock`), bound caller session, connection/browser, tab, document/frame identity and origin, optional label, creation and five-minute expiry, state, safe outcome.

Transitions: `pending -> accepted | declined | cancelled | expired`. Terminal transitions are immutable. Secret submission is processed transiently then discarded; it is never a stored field of the pending request. Save & fill consumes the request and revalidates all page bindings; no duplicate execution on polling/reconnect.

## Fill inspection

Verified browser/tab, expected origin, frame/document identity, short-lived nonce, stamped target identity and suitability. No field values. A new inspection is required after document/target changes. Auto-rebinding or using focus alone is prohibited.

## Protected document

Non-secret document identity and taint state (`active`/`recovery_required`), browser/tab/frame scope, creation reason and safe generation. Session-persisted extension metadata survives worker recycle without saving secret bytes. Literal/normalized redaction values exist only in daemon memory, scoped to browser and retained while needed; do not evict a still-live secret merely because a fixed queue filled.

Transitions: `clean -> active` before injection; `active -> recovery_required` if protection cannot be restored; `active/recovery_required -> clean` only after the old sensitive context is verified discarded or protection safely re-established. Hash changes do not transition to clean; BFCache restoration must reapply protection.

## Audit and backups

Audit event contains operation, safe IDs/site scope, a one-way pseudonymous session reference, timestamp and result/error code only. The pseudonym key is memory-only, so durable audit rows cannot be correlated across daemon restarts. No raw session ID, password, secret hash, raw payload, or user form contents. Backup snapshot contains the encrypted store and key material needed for restoration, stored owner-only and treated as a whole credential. Restore validates before swap, preserves prior complete state, and is initiated/confirmed only from private UI.
