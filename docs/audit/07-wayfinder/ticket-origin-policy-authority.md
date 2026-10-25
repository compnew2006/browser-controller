# Origin policy: which side is authoritative

`wayfinder:grilling` · Blocked by: none · Unblocks: phase 6 step 3 of the route.

## Question

Two runtimes decide "is this a site the vault may act on", and they do not agree. Which list wins, and
does an origin refusal get its own failure code?

## The divergence, exactly as read

`mcp-server/src/vault/types.ts:11` `canonicalizeOrigin`:

- rejects credentials, **and** any path, query or fragment (`url.pathname !== '/' || url.search || url.hash`);
- allows `https:`, or `http:` on `localhost` / `127.0.0.1` / `::1` / **`::ffff:127.0.0.1`** (brackets stripped,
  lowercased);
- throws `VAULT_ORIGIN_MISMATCH: …`.

`extension/lib/vault.js:47` `canonicalOrigin`:

- rejects credentials only — **accepts** a path, query or fragment and returns `url.origin`;
- allows `https:`, or `http:` on `localhost` / `127.0.0.1` / `[::1]` — **not** `::ffff:127.0.0.1`;
- throws `VAULT_TARGET_UNSAFE`, which `handleVaultAction` (`:596`) also uses as the catch-all for *every*
  throw in inspect and fill.

Both return `url.origin`, so the path/query tolerance changes validation, not output: the daemon never
receives a path, because the extension sends an origin. That difference is harmless.

The loopback difference is not. `http://[::ffff:127.0.0.1]:8080/` is a legitimate IPv4-mapped loopback
fixture the **daemon** is willing to fill, and the **extension** refuses before the request is even made.
Because the refusal is reported as `VAULT_TARGET_UNSAFE`, the agent is told *"The page does not have one
verified editable password field"* — a wrong diagnosis for an origin problem. See `05` F13.

## What a session needs to settle

1. Is `::ffff:127.0.0.1` meant to be supported? The daemon says yes explicitly; the extension's list
   simply omits it, which reads like an oversight rather than a policy. Recommendation in the audit:
   add it to the extension, because the daemon's list *is* the vault's security boundary and a page it
   will fill should not be refused earlier by a shorter list. If instead the answer is "no, refuse it
   everywhere", the daemon list shrinks — either way it is one list, written down once.
2. Does an origin refusal get `VAULT_ORIGIN_MISMATCH` on the extension side, so the catch-all stops
   lying? This is the part that matters to the model, not to the security: an agent that is told "no
   password field" will try to type into the page instead of reporting the origin problem.
3. Does the fixture become the contract? The proposal is one JSON list of
   `{origin, acceptedByDaemon, acceptedByExtension, why}` with a test in each runtime reading it, so the
   two implementations stay separate (they must — different trust domains, `04` C) but cannot drift.
   Cases to include: `https://example.com`, `https://example.com/path`, `https://user:pass@example.com`,
   `http://localhost`, `http://127.0.0.1`, `http://[::1]`, `http://[::ffff:127.0.0.1]`, `ftp://…`,
   `about:blank`, `''`.
4. Is the extension allowed to be *more* permissive than the daemon anywhere? Today it is, on paths. If
   that stays, the fixture records it as intentional so the next reader does not "fix" it.

## Trade-off to state in the answer

Agreeing on one list removes a class of wrong diagnoses and costs one fixture file plus one test per
runtime. Forcing literal sameness (one shared implementation) would remove defence in depth and is ruled
out in `04` C — the answer must be "same policy, two implementations, one fixture", not "one function".

## Resolution

<!-- fill on close: the loopback list, the code for origin refusals, the fixture location -->
