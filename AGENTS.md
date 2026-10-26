# Repository Guidelines

## Project Structure

- `mcp-server/src/` contains the TypeScript MCP server, local daemon and bridge, tool registration, and credential vault.
- `extension/` is the Chrome Manifest V3 extension: background modules wire browser events; `dispatch/` routes calls, `lib/` holds shared state/helpers, and handler modules implement page behavior.
- `tests/` contains Vitest suites and Chrome API mocks. `scripts/` holds daemon, pairing, and smoke-test utilities; `scripts/pages/` contains fixtures.
- `agent-config/` has editor setup; `specs/` designs; `docs/` project and audit material; `deploy/` supervisor examples.

## Architecture and Security

MCP clients communicate with one local daemon, which validates and routes calls over authenticated WebSockets to the paired extension. Keep tool schemas and registration in `mcp-server/src/tools/` and `register-tools.ts`; implement browser behavior in the matching handler. Preserve timeouts, tab ownership, and credential boundaries. Never commit secrets or place them in fixtures/logs. The vault may fill credentials but must not submit forms.

## Build, Test, and Development

- `npm ci` installs locked dependencies (Node.js 20+); `npm run dev` watches TypeScript; `npm run build` writes `mcp-server/dist/`.
- `npm test` runs Vitest; focus a suite with `npm test -- tests/tools/fill.test.ts`.
- CI checks `npm run lint`, `npm run typecheck`, `npm run build`, `npm run test:coverage`, `npm run security:audit`, and `npm run context:lint` on Node 20 and 22.
- `npm run smoke:real-chrome` requires a built server and an enrolled, running Chrome extension.

## Style and Testing

Use ES modules, two-space indentation, semicolons, and nearby naming patterns. Keep tools and handlers focused; name Vitest files `*.test.ts`. Add regression tests for protocol, tab ownership, timeouts, and credential redaction. Prefer isolated tests; use real-Chrome smoke checks when needed.

## Evidence and Agent Workflow

Requirements and specs describe intended behavior; the checkout defines what is implemented. Tests and runtime checks cover only exercised paths and environments. Treat graph, index, and memory as navigation aids; verify claims against source. `constitution.md` is proposed, not binding until adopted. Scope delegated work clearly; its output is evidence, not approval. Keep review independent when behavior or security contracts change.

## Commits and Pull Requests

Use scoped Conventional Commit subjects, e.g. `refactor(extension): ...` or `docs(audit): ...`. In pull requests, explain behavior, affected boundaries, and checks; call out protocol/security changes, include popup/UI screenshots, and link relevant issues. Open an issue first for larger changes, as `README.md` requests.


## Architecture and policy

Graphify and codebase-memory indexes help locate modules and relationships; they are derived maps, not proof. Confirm important findings against the current source, build configuration, and tests, especially for dynamic plugin behavior. The root `constitution.md` identifies itself as a proposal; do not treat it as adopted policy unless its stated approval gates have passed. Never commit credentials or private configuration. Report security issues through the channels in `SECURITY.md`.