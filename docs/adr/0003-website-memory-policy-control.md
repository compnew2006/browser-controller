# ADR-0003: Owner CLI plus owner-confirmed agent requests for memory policy

- **Status**: proposed
- **Date**: 2026-10-27
- **Related**: [specs/003-website-agent-memory/plan.md](../../specs/003-website-agent-memory/plan.md), [specs/003-website-agent-memory/research.md](../../specs/003-website-agent-memory/research.md) R-13, [specs/003-website-agent-memory/spec.md](../../specs/003-website-agent-memory/spec.md) FR-004, AC-32

## Context

Memory policy (`policy.json`: enabled/disabled, excluded origins, deletion tombstones) must change only on the owner's intent (FR-004). The original design gave the owner exactly one channel: a local CLI (`npm run memory -- <command>`) talking to the daemon over IPC, with no MCP tool able to touch policy at all — closing off the risk that a prompt-injected agent could enable memory or remove an exclusion by itself.

The 2026-10-27 spec clarification changed the requirement: an agent may *request* any policy change, but the request takes effect only after the owner confirms it in their own agent client (FR-004, AC-32). This is a narrower, not a looser, design than "no MCP tool at all" — the owner is still the one who makes every change effective, whether by typing a CLI command or by answering a prompt their own client shows them.

Two implementation shapes were considered for the agent-facing side:
- **Extend `browser_memory`** with policy actions: rejected, because a client that auto-allows the read-only tool (a common configuration) would then also auto-allow policy changes without the client ever knowing it needed to prompt.
- **A separate tool, `browser_memory_policy`**: kept apart from `browser_memory` precisely so a client's allow-list can treat reads and policy changes differently, and so a policy call is always recognizable as the one that needs a human answer.

## Decision

Two channels change policy, both ending in the same `MemoryService.admin` call so there is exactly one code path for every transition:

1. **Owner CLI** (`scripts/memory.mjs`, IPC kind `memory-admin`): `status`, `enable`, `disable`, `exclude`, `include`, `inspect`, `export`, `delete`.
2. **Agent-requested, owner-confirmed** (`browser_memory_policy` MCP tool): the MCP server process asks the owner through MCP form elicitation — reusing the `registerTools` confirmation path in `mcp-server/src/register-tools.ts` — with a message built only from the action and the canonical origin (`Allow <action> of website memory for <origin|all sites>?`), never from agent or page text. Only a confirmation the owner actually gave sets an internal `ownerConfirmed` field before the daemon call; any value the agent supplies for that field is dropped, following the same pattern as `expectFingerprints` in `mcp-server/src/tools/action-support.ts`. When the client cannot elicit (`CLIENT_CONFIRMATION_UNAVAILABLE`) or the owner declines or does not answer (`ACTION_NOT_CONFIRMED`), nothing changes.

## Consequences

- No policy change is possible without either the owner's own CLI command or the owner's own confirmation click — a prompt-injected agent can ask, but cannot act alone.
- **Residual risk, approval fatigue**: an agent can request a change on every call. This is tracked as a known gap (analyze finding A1): no cooldown or rate limit is enforced yet beyond the daemon's existing per-session call limit. A future revision may add a dedicated cooldown between repeated requests for the same action/origin.
- **Residual risk, shell access**: an agent with OS shell access on the same machine can still run the CLI or edit `policy.json` directly, bypassing both channels. This is the same boundary already accepted for the vault and the daemon token, and is recorded in SECURITY.md rather than solved by this feature.
- `browser_memory_policy` is a new MCP tool surface; clients that distinguish read vs. write tools in their own allow-lists can keep auto-allowing `browser_memory` while still prompting on `browser_memory_policy`.
