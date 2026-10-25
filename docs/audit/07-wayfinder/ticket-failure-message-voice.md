# Failure messages: one voice or two

`wayfinder:grilling` · Blocked by: none · Unblocks: phase 6 step 4 of the route.

## Question

Two tables turn the same `VAULT_*` vocabulary into English for the model. Are they meant to say the same
thing, or are they deliberately layered — and how does that get pinned so it stops being an accident?

## The two tables, as read

`extension/lib/vault.js:33` `safeFailure(code)` — 8 codes, short declarative sentences, extension-side
wording ("The page changed before the fill."). Unknown codes fall back to "The private browser action
could not be completed safely."

`mcp-server/src/vault/service-common.ts` `publicError` / `safeMessage` — the daemon-side wording for a
larger vocabulary, including the same `VAULT_TARGET_UNSAFE`, `VAULT_DOCUMENT_CHANGED`,
`VAULT_OUTCOME_UNKNOWN`, `VAULT_PERMISSION_DENIED`, `VAULT_RECOVERY_REQUIRED`, `INVALID_ARGUMENT`.

Consequence: the same failure reaches the model with two different explanations depending on which layer
caught it first. For an agent-facing tool that is a correctness problem, not tidiness — the model's next
action is chosen from that sentence.

## The sharper part of this ticket

The extension's catch-all (`:596`) reports *every* throw as `VAULT_TARGET_UNSAFE`, whose sentence is
"The page does not have one verified editable password field." So a tab-read failure, an origin refusal,
or a wedged-tab timeout all arrive as a claim about the page's fields. That is not a wording difference;
it is a wrong statement of fact, and it is `05` F13.

So this ticket has two halves, and the second is a prerequisite for the first: **fix the mapping, then
decide the voice.**

## What a session needs to settle

1. Which throws should keep a specific code? Minimum: origin refusal → `VAULT_ORIGIN_MISMATCH`;
   a wedged/timeout tab → its own code or `VAULT_PERMISSION_DENIED`, never "no password field".
2. For the codes the two layers share: same text, or deliberately different? Same text is simplest and
   testable. Deliberately different is defensible (extension text says "reload the page", daemon text says
   "ask the user") — but then say it in a comment in both files, because a future reader will otherwise
   merge them and change what the model reads.
3. Does the parity check belong in code or in prose? A fixture test over the shared codes is cheap; a
   comment is free but unenforced. The audit's recommendation is the test for the text, the comment for
   the intent.

## Trade-off to state in the answer

One voice: fewer ways to be misled, but the text loses the layer-specific advice that is sometimes the
useful part. Two voices: keeps layer context, at the cost of the model seeing two stories about one
failure — which only stays safe if the difference is written down in both files.

## Resolution

<!-- fill on close: the corrected mapping, the shared-code verdict, where the check lives -->
