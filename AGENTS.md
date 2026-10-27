# Repository Guidelines

## Project Structure

- `mcp-server/src/` holds the TypeScript MCP server, daemon/bridge, tools, and credential vault.
- `extension/` is Chrome MV3: background modules wire events; `dispatch/` routes calls, `lib/` holds shared state, handlers implement browser behavior.
- `tests/` has Vitest suites and Chrome mocks; `scripts/` has daemon, pairing, and smoke utilities; `scripts/pages/` has fixtures.
- `agent-config/`, `specs/`, `docs/`, and `deploy/` contain editor setup, feature designs, project/audit docs, and supervisor examples.

## Architecture and Security

MCP clients connect to a local daemon that validates calls and routes them over authenticated WebSockets to the paired extension. Keep schemas under `mcp-server/src/tools/`, registration in `mcp-server/src/tools/registry.ts`, and browser behavior in matching handlers. Preserve timeouts and tab ownership. Pairing grants trusted clients powerful, unsandboxed browser control. Never commit secrets/private configuration; report vulnerabilities through `SECURITY.md`. Vault fill never clicks Submit, though site handlers may submit on input.

## Build, Test, and Development

- `npm ci` installs locked dependencies (Node.js 20+); `npm run dev` watches TypeScript; `npm run build` compiles to `mcp-server/dist/`.
- `npm test` runs Vitest; focus one with `npm test -- tests/v3-mock.test.ts`.
- CI runs `npm run lint`, `npm run typecheck`, `npm run build`, `npm run test:coverage`, `npm run security:audit`, and `npm run context:lint` on Node 20 and 22.
- `npm run smoke:real-chrome` requires a built server and enrolled extension; it restarts the daemon and uses the normal Chrome profile.
- Code-graph indexes are machine-local output: `.codebase-memory/` and `graphify-out/` stay uncommitted, and a clone that still tracks the former clears it once with `rm -rf .codebase-memory` before pulling past `8777e78`. The tool rebuilds the index on the next run.
- A release is an annotated tag `vX.Y.Z` on the commit that sets that version, with notes read from the tagged tree's `CHANGELOG.md` section, never from the working tree.

## Style and Testing

Use ES modules, two spaces, semicolons, and nearby naming. Keep tools and handlers focused; Vitest files end in `*.test.ts`. Add regressions for protocol, tab ownership, timeouts, and credential redaction; prefer isolated tests. Use real-Chrome smoke checks when needed.

## Spec Kit, Evidence, and Agent Workflow

Spec Kit is configured under `.specify/`; Codex skills are under `.agents/skills/`. Use `$speckit-specify`, `$speckit-plan`, `$speckit-tasks`, and `$speckit-implement`; the workflow pauses for spec and plan review. Root `constitution.md` is proposed pending gates A–D and token tests; `.specify/memory/constitution.md` mirrors that proposal and is not adopted policy. Check the mirror's source fingerprint against the root file before relying on it. Requirements define intended behavior; source shows current implementation; tests/runtime cover exercised paths. Treat Graphify and codebase-memory as maps; verify claims against source, configuration, and tests. Scope delegated work; findings are evidence, not approval; independently review behavior/security changes.

## Commits and Pull Requests

Use scoped Conventional Commits, e.g. `refactor(vault): ...` or `docs(audit): ...`. PRs describe behavior, scope, and checks; note protocol/security changes, include UI screenshots, and link issues. Open an issue before larger changes, as `README.md` requests.
