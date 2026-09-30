import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: 'coverage',
      // Measure the deterministic automation core. Chrome lifecycle entry
      // points, popup rendering, and native debugger plumbing require a real
      // extension runtime and are verified by integration/E2E tests instead.
      include: [
        'mcp-server/src/bridge-security.ts',
        'mcp-server/src/protocol.ts',
        'mcp-server/src/tools/meta.ts',
        'extension/lib/observation-action.js',
        'extension/lib/observation-v2.js',
        'extension/lib/protocol.js',
        'extension/lib/snapshot-registry.js',
        'extension/lib/tab-concurrency.js',
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
