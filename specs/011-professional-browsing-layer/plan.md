# Implementation Plan: Professional Browsing Layer

**Branch**: `feat/professional-browsing-layer` | **Date**: 2026-11-22 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification in `spec.md` (derived from the Design section of `docs/superpowers/plans/2026-11-22-professional-browsing-layer.md`).

## Summary

Add a professional browsing layer on top of the existing browser-controller: a task engine that runs a goal as verified steps through the registered MCP tools, a session & login agent that pauses on expiry (and never mistakes an http security-warning page for a login or success page), a verifier that reads the page after every mutating step and fails loudly with evidence, an evidence report with five fixed sections, a question protocol that reaches the user through popup cards outside any blocked tab, a recovery policy with bounded retries and an immediate stop list, and a responsive popup in Operate mode (dark zinc + indigo identity preserved) with Tasks, Questions, and Evidence panels.

## Technical Context

**Language/Version**: TypeScript/JavaScript ESM; Node.js `^22.18.0 || ^24.11.0 || >=26.0.0`.

**Primary Dependencies**: Existing `@modelcontextprotocol/sdk`, `ws`, and `zod`; no dependency changes.

**Storage**: Task records and evidence reports live in daemon-local state (in-memory or local state files — to be decided in implementation; no new external service). Existing browser-scoped vault files and site knowledge (008) are untouched.

**Testing**: Vitest (`npm test`), TypeScript (`npm run typecheck`), lint/build, and the required repository CI-equivalent checks from `AGENTS.md`. Visual verification uses `impeccable shot` at the shipped sizes plus the mechanical detector once at the end.

**Target Platform**: Chrome MV3 extension paired with the local Node.js MCP daemon on supported desktop platforms; daemon bound to `127.0.0.1` only.

**Project Type**: Browser extension + local TypeScript MCP daemon.

**Performance Goals**: Verification reads (snapshot + text) happen after mutating steps only; retries are bounded (`maxAttempts: 3`, `backoffMs: [500, 1500, 4000]`); no unbounded polling or retry loops.

**Constraints**: Read-only by default — any mutating action (save/send/delete) needs explicit approval before it runs. Vault fill never clicks Submit unless a site handler explicitly chooses to. Protocol version handshake preserved; any breaking change bumps the major version. No secrets in commits; scoped Conventional Commits.

**Scale/Scope**: One task at a time per session in the first delivery; task records and evidence are local to the daemon. No new extension permission, storage directory, public MCP tool surface beyond the task tools, or schema migration beyond the task types in `mcp-server/src/tasks/types.ts`.

## Acceptance Criteria

- **AC-1**: A planned task runs its steps in order through registered MCP tools; no step advances until the current step verifies or its failure is recorded with evidence.
- **AC-2**: Session expiry mid-task pauses in `paused-login`, the user completes login by takeover, and the task resumes from the same step after the page is re-checked; an http security-warning page is classified `warning-page`, never a login page or a successful target.
- **AC-3**: After a mutating step, the verifier applies `url-contains`, `text-present`, `element-count`, and `no-error-text`; failure returns `VERIFY_FAILED` with URL, snapshot reference, and observed text, and navigation success alone never counts as success.
- **AC-4**: Every finished task produces an evidence report with the five fixed sections, literal values, sources, open items, and unverified items, as compact text + structured JSON, saved in the task record.
- **AC-5**: A question reaches the user as a popup card outside a blocked tab; the answer resumes the task from `paused-question` at the same step; the user is asked only about a choice that changes the outcome and was not fixed by the original request.
- **AC-6**: Retryable failures (`TIMEOUT`, `TAB_FROZEN`, `NETWORK`) retry at most 3 times with backoff `[500, 1500, 4000]`; `429`, rate limits, permission denial, and `TAB_LOCKED` stop immediately; an unknown-outcome action is re-checked for state before any repeat, so no double execution.
- **AC-7**: The popup adapts from `320px` to `640px` at breakpoints `320 / 380 / 500 / 640`, shows Tasks, Questions, and Evidence panels, keeps touch targets at `44px` or more, and preserves the dark zinc + indigo identity; visual checks use `impeccable shot` at shipped sizes and the mechanical detector once at the end.

## Constitution Check

- Local-only, no cloud, no tracking: the layer adds no remote listener, no external service call, and no new runtime dependency.
- Read-only by default with explicit approval for mutating actions; vault Submit rule unchanged.
- No secrets in commits; scoped Conventional Commits (e.g. `feat(tasks): ...`).
- Protocol version handshake preserved; breaking changes bump the major version.

## Open Decisions (from the spec)

- Task-record and evidence-report storage: daemon memory vs local state files — decided in implementation, no external service either way.
- What a "snapshot reference" in verification evidence contains (stored snapshot reference vs full image) — decided in implementation.
