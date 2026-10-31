import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: 'coverage',
      // Vitest skips the coverage report AND the threshold check entirely when
      // any test fails, unless reportOnFailure is set. This suite has
      // environment-bound failures (a named pipe already held by a running
      // daemon, POSIX-only permission branches), so without this flag the gate
      // would silently switch itself off exactly when it matters most.
      reportOnFailure: true,
      // Measure the whole production surface, not a hand-picked subset. The
      // previous list covered 4 files (~2.4% of production lines) while the
      // thresholds claimed 80%, so the gate could never fail. Chrome lifecycle
      // entry points, popup rendering, and native debugger plumbing still
      // require a real extension runtime and are verified by integration/E2E
      // tests instead of unit coverage.
      include: [
        'mcp-server/src/**/*.ts',
        'extension/**/*.js',
      ],
      // Build output, generated types, and the coverage report itself are not
      // production source, so they must not enter the measured denominator.
      exclude: [
        'node_modules/**',
        'mcp-server/dist/**',
        'coverage/**',
        '**/*.d.ts',
        '**/*.test.ts',
        '**/*.test.js',
      ],
      // Every value below is the floor of the coverage this tree actually
      // reaches today, measured with `npx vitest run --coverage` over the
      // scope above (167 files). They are a ratchet on reality, not a target:
      // the audit's aspirational 70% global / 85% on vault+memory (audit Q-4)
      // is now met with a wide margin — 81.8% global, 94.89% on the memory
      // sources and 87.65% on the vault — so the owner's answer to Q-4 can
      // only lower these floors, never raise them above what the tree
      // reaches. Vitest checks the global thresholds against every measured
      // file and each glob against the aggregate of the files it matches.
      thresholds: {
        // Measured 81.80% lines / 81.79% functions / 75.70% branches /
        // 78.32% statements across all 167 measured production files.
        lines: 81,
        functions: 81,
        branches: 75,
        statements: 78,

        // Measured 86.08% / 86.77% / 79.19% / 82.45% over the 109 server
        // sources: the daemon, bridge, vault, memory and tool layers.
        'mcp-server/src/**/*.ts': {
          lines: 86,
          functions: 86,
          branches: 79,
          statements: 82,
        },

        // Measured 94.89% / 96.36% / 85.16% / 90.54% over the 32 memory
        // sources: the capture, policy and queue paths are well exercised.
        'mcp-server/src/memory/**/*.ts': {
          lines: 94,
          functions: 96,
          branches: 85,
          statements: 90,
        },

        // Measured 87.65% / 86.77% / 74.94% / 81.36% over the 18 vault
        // sources. The vault's own rule used to compare POSIX mode bits on
        // win32, which that platform does not have, so every vault test
        // failed there and the secret-handling code was measured at 58%.
        // The rule now applies only where the bits exist, and the tests run.
        'mcp-server/src/vault/**/*.ts': {
          lines: 87,
          functions: 86,
          branches: 74,
          statements: 81,
        },

        // Measured 89.79% / 89.41% / 78.53% / 86.50% over the 31 tool
        // schemas and handlers.
        'mcp-server/src/tools/**/*.ts': {
          lines: 89,
          functions: 89,
          branches: 78,
          statements: 86,
        },

        // Measured 77.01% / 75.95% / 72.43% / 73.92% over the 58 extension
        // sources: the service worker, handlers, popup and injected scripts.
        'extension/**/*.js': {
          lines: 77,
          functions: 75,
          branches: 72,
          statements: 73,
        },

        // Measured 88.39% / 86.62% / 78.36% / 83.63% over the 35 shared
        // extension libraries.
        'extension/lib/**/*.js': {
          lines: 88,
          functions: 86,
          branches: 78,
          statements: 83,
        },

        // Measured 92.45% / 89.12% / 79.62% / 87.39% over the 13 browser
        // action handlers.
        'extension/handlers/**/*.js': {
          lines: 92,
          functions: 89,
          branches: 79,
          statements: 87,
        },

        // The wire contract keeps its documented 80% floor. The protocol
        // package replaced the single protocol.ts file, so the glob follows
        // the package.
        // Measured 94.89% / 88.18% / 96.42% / 95.29% (mcp-server/src/protocol/**).
        'mcp-server/src/protocol/**': {
          lines: 80,
          functions: 80,
          branches: 80,
          statements: 80,
        },

        // Measured 100% / 100% / 93.75% / 95.65% (bridge-security.ts).
        'mcp-server/src/bridge-security.ts': {
          lines: 80,
          functions: 80,
          branches: 80,
          statements: 80,
        },

        // Measured 91.30% / 100% / 92.50% / 91.66% (extension/lib/protocol.js).
        'extension/lib/protocol.js': {
          lines: 80,
          functions: 80,
          branches: 80,
          statements: 80,
        },

        // Measured 100% / 100% / 98.61% / 99.04% (tab-concurrency.js).
        'extension/lib/tab-concurrency.js': {
          lines: 80,
          functions: 80,
          branches: 80,
          statements: 80,
        },
      },
    },
  },
});
