# Research: خزنة تسجيل الدخول بطريقة Hermes

**Date**: 2026-10-25. Sources are primary documents and code inspected during this conversation. Remote `main` links can change; record an exact upstream revision before porting source code, retain required licenses/attribution, and do not import upstream secrets or user state.

## Decision 1: Copy Hermes's interaction and trust boundaries

**Decision**: One model-facing handle-based vault tool, private credential entry, server-side secret resolution, exact-origin checks before resolution and immediately before write, and sanitized metadata results. Username is permitted metadata after user grant. V1 is local logins only.

**Rationale**: Matches the requested Hermes method and avoids asking the model to put passwords in generic typing arguments.

**Alternatives considered**: Plain password arguments in `browser_fill` (exposes values in MCP inputs); only hiding the fill result (other tools can echo the value); importing Chrome passwords (not requested and requires access to existing credentials).

**Sources**: [browser_vault_tool.py](https://github.com/NousResearch/hermes-agent/blob/main/tools/browser_vault_tool.py), [credential-vault.md](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/credential-vault.md).

## Decision 2: Native authenticated encryption, protected local key

**Decision**: Versioned AES-256-GCM envelope using Node's maintained built-in `crypto`; random key stored separately with owner-only permissions. Keep the Hermes local encrypted-file/local-key protection model without binary file compatibility. OS-key storage is a later adapter.

**Rationale**: User chose Hermes's local-vault method; native AEAD avoids inventing crypto or adding a Fernet dependency solely for an unrequested interoperability goal. A key beside ciphertext protects against casual disclosure/other users, not a same-user process or copied pair.

**Alternatives considered**: Exact Python/Fernet file compatibility (extra dependency/format obligation without user need); Keychain-only default (does not follow requested default); password hashing (cannot supply the password to the site).

**Sources**: [Hermes vault limits](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/credential-vault.md), [OWASP secrets management](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html), [Node crypto](https://nodejs.org/api/crypto.html), [Apple keychain](https://developer.apple.com/documentation/security/keychain-services).

## Decision 3: Daemon owns storage and resolution

**Decision**: Public MCP messages contain handles; a dedicated daemon service resolves secrets and dispatches an internal one-shot fill to the selected extension. Redact public responses before they cross IPC. Add private UI RPC on the existing authenticated WebSocket, bound to the actual connection.

**Rationale**: Current `index.ts:287` serializes tool parameters into IPC; `bridge.ts:546` retains parameters for pending calls and `:553` sends them to the extension. Passing secrets as ordinary `browser_fill` parameters would spread them across the generic pipeline. Existing daemon owns routing at `daemon.ts:366`, sends replies at `:430`, and gets the profile from `ExtensionConnections.forSession`.

**Alternatives considered**: Resolving inside MCP tool handlers (secrets reach generic IPC parameters); a new unauthenticated HTTP endpoint (unnecessary exposure); extending the pairing native host (currently deliberately limited to pairing, additional installer/protocol burden).

## Decision 4: Extension-owned private entry

**Decision**: Secret-entry/management page belongs to the extension; verify exact sender and never store secrets in Chrome storage. Public tool initiates a bounded asynchronous request and returns a safe state.

**Rationale**: Existing MCP form elicitation in `register-tools.ts:168` is suitable for non-secret confirmation only. A masked UI alone does not keep values out of MCP client transport/history. The MCP spec explicitly prohibits requesting passwords via form elicitation.

**Alternatives considered**: Generic MCP form elicitation (prohibited for secrets); asking for password in chat (breaks requirement); holding a browser mutex while a human types (blocks independent work and exceeds transport budgets).

**Source**: [MCP elicitation 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation).

## Decision 5: Redaction plus conservative execution gates

**Decision**: Register literal/normalized secrets before injection; redact all public results/errors per browser namespace. Block general evaluation, screenshots, response mocks and raw network/log disclosures on protected documents; preserve taint across lifecycle events and fail closed when reconstruction is uncertain.

**Rationale**: Hermes exact-value registry is useful but exact matching does not detect arbitrary transformations or pixels. Current `evaluate.js:28` returns raw values and `screenshot.js:231` captures the visible page. Current field/text masking (`input-outcome.js:71`, `page-dom.js:895`) remains useful but is not a complete output boundary.

**Alternatives considered**: Block evaluate only (screenshots/reveals remain); redact exact strings only (encoded output/side effects remain); clear state on any URL change (SPA and BFCache can preserve sensitive documents).

**Sources**: [Hermes redactor](https://github.com/NousResearch/hermes-agent/blob/main/agent/redact.py), [Hermes file guard](https://github.com/NousResearch/hermes-agent/blob/main/agent/file_safety.py), local sources cited above.

## Decision 6: Explicit session grants and checked identity

**Decision**: Grants are created only by the private user UI, bind account/site/browser/session, and are revoked on session end or profile change. Default list is origin-scoped after grant. Duplicate/uncertain active browser identity refuses vault access until resolved.

**Rationale**: Knowing a handle or matching a domain is not permission to use every account. Tab IDs belong to one browser; existing `bridge-connections.ts:33` documents session pinning and `forSession` enforces it.

**Alternatives considered**: Global reusable handles as authority (cross-session misuse); page text as authorization (prompt injection); browser label or caller-supplied browser/session ID as authority (untrusted routing input).

## Decision 7: Honest verification

**Decision**: Isolated synthetic fixture and private browser; no production credentials or current live browser restart. Measure actual MCP calls and preserve test evidence/limitations. Existing secret files and pre-existing `.codebase-memory` changes are not edited.

**Rationale**: The user authorized implementation and asked for correctness; test isolation allows proving paths without affecting real accounts. All SC numbers remain targets until actually observed.
