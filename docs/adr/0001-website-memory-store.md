# ADR-0001: Dependency-free JSON record store for website memory

- **Status**: proposed
- **Date**: 2026-10-27
- **Related**: [specs/003-website-agent-memory/plan.md](../../specs/003-website-agent-memory/plan.md), [specs/003-website-agent-memory/research.md](../../specs/003-website-agent-memory/research.md) R-01, R-02

## Context

Spec 003 gives Browser Controller a small, local, owner-controlled memory per website: a bounded visit count per (profile, origin), and a handful of allowlisted structural facts per origin (language, search box, login path, control names). Every read is keyed by `(origin, profile)` and returns a short, bounded list. Every write touches one origin. No requirement needs full-text search, semantic ranking, or free-text storage, because fact values come only from a fixed lexicon (R-08).

Mnemon was raised in an earlier discussion as a candidate memory engine. Its entry point starts its own MCP server and opens a database through a native, synchronous SQLite driver (per the outline, unverified), which the outline also says must not be imported directly. Adopting it would add a second process lifecycle, a native module to build and ship on macOS, Windows and Linux, and a free-text memory model that does not match allowlisted structured facts.

## Decision

Ship a dependency-free JSON record store owned by the daemon: `policy.json` plus one file per origin (`memory/sites/<sha256(origin)>.json`), each replaced atomically (temp file → fsync → rename → directory fsync), with one writer in the daemon process. The store sits behind a `MemoryStore` interface (`mcp-server/src/memory/store.ts`).

Per the 2026-10-27 spec clarification (FR-013), Mnemon is not rejected outright. It stays in scope as an optional, separately authorized experiment: a second `MemoryStore` implementation, `mcp-server/src/memory/mnemon-store.ts`, selected only via `BC_MEMORY_STORE=mnemon`. It must pass the exact same test suite as the default store before the owner compares it against the default on the R-18 workload (tasks.md Phase 7). The feature works fully without it either way.

## Consequences

- No new npm dependency, no native build, no supply-chain review for the default path (constitution Art. 21).
- Startup stays lazy: only `policy.json` is read at daemon start.
- A corrupt or crash-interrupted write affects at most one origin's file, never the whole store.
- The `MemoryStore` interface is the only coupling point; a future storage engine (Mnemon or otherwise) can be added without touching `queue.ts`, `scope.ts` or the MCP tool layer.
- If the Mnemon comparison is never authorized, `mnemon-store.ts` stays unused dead code behind the env var, with no runtime cost to the shipped path.
