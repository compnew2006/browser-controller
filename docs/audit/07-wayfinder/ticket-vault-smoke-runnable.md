# Can the vault smoke run here

`wayfinder:task` · Blocked by: none · Unblocks: the phase 3 acceptance gate.

## Question

Does `npm run smoke:vault-isolated` actually run in this checkout, and if not, what replaces it as
evidence that a vault refactor changed nothing?

This is a task ticket, not a decision: nothing to grill, but the vault-composition decision is standing
on an answer that nobody has verified. The audit read code; it never executed a browser.

## What to do

1. `npm run smoke:vault-isolated` — record the exact outcome: passes, fails, or needs a Chrome instance
   that is not present. Capture the first 20 lines of output either way.
2. `npm run smoke:real-chrome` — same.
3. `npm run daemon:start && npm run daemon:status && npm run daemon:stop` — confirm the daemon round-trip
   works, because phase 4 uses it as its gate.
4. Note the Chrome/Node versions the smoke needs, so the next session does not rediscover them.

## Answer format

For each of the three: works / needs X / does not work, plus the command output that proves it. Then one
line: if the vault smoke cannot run, the manual vault path in the *Vault service* ticket becomes the only
gate for phase 3, and that must be written into the phase before it starts.

## Resolution

<!-- fill on close: what ran, what it printed, what the gate becomes -->
