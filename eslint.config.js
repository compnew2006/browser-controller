import babelParser from '@babel/eslint-parser';
import js from '@eslint/js';
import globals from 'globals';

const recommendedRules = js.configs.recommended.rules;

export default [
  {
    ignores: [
      '**/node_modules/**',
      'coverage/**',
      'graphify-out/**',
      'mcp-server/dist/**',
      '.agents/**',
    ],
  },
  {
    files: ['mcp-server/src/**/*.ts', 'tests/**/*.ts', 'vitest.config.ts'],
    languageOptions: {
      parser: babelParser,
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.es2022,
        ...globals.node,
      },
      parserOptions: {
        requireConfigFile: false,
        babelOptions: {
          // Babel 8 always allows `declare` fields (the option was removed).
          presets: ['@babel/preset-typescript'],
        },
      },
    },
    rules: {
      ...recommendedRules,
      // The TypeScript compiler owns symbol and type validation. Babel is used
      // here only as a TypeScript 7-compatible ESLint parser.
      'no-undef': 'off',
      'no-unused-vars': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  // Architectural boundaries (audit 5.3).
  //
  // The layering used to be an agreement nobody enforced: a wrong import
  // passed review because nothing checked it. These rules turn the agreement
  // into build gates, so a crossing import fails `npm run lint`.
  //
  // Two deliberate choices:
  // - Every override is scoped to ONE directory, so a rule never fires on the
  //   wrong files (a tools file may import core; a core file may not).
  // - Every target is a PATTERN, not a list of file names, so a new file in a
  //   forbidden directory is caught as well. The one exception uses the
  //   ignore-style re-inclusion (`!path`) so the allowed module stays allowed.
  //
  // The same boundaries are proven against the real import graph by
  // tests/architecture.test.ts (`npm run arch:check`), which also covers the
  // src-root modules that the patterns below cannot name exhaustively.
  {
    // Boundary 1: core/ is the neutral base layer. It holds the shared
    // mechanics (type guard, error codes, JSON store, bounded queue, logger),
    // so it may depend on node builtins and core/ siblings only.
    files: ['mcp-server/src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: [
            '../tools/**',
            '../memory/**',
            '../vault/**',
            '../protocol/**',
            '../bridge*',
            '../daemon*',
            '../ipc-*',
            '../lock-file*',
            '../register-tools*',
            '../index*',
            '../native-host*',
          ],
          message: 'core/ is the neutral base layer: it may depend on node builtins and core/ siblings only. tools/, memory/, vault/, protocol/ and the transport modules all sit above it and must not be pulled in from below.',
        }],
      }],
    },
  },
  {
    // Boundary 4: protocol/ is the wire contract (capabilities, frames, auth,
    // wire tools, the generated tool names). The transport must not know the
    // tools layer, so the dependency can never point back at it.
    files: ['mcp-server/src/protocol/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['../tools/**', '../memory/**', '../vault/**'],
          message: 'protocol/ is the wire contract: the transport must not know the tools, memory or vault layers. The generated tool names live here so that nothing has to import the registry.',
        }],
      }],
    },
  },
  {
    // Boundary 5: the tools layer describes WHAT a tool does, not HOW a frame
    // travels, so it must not reach into the wire/transport layer.
    files: ['mcp-server/src/tools/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['../protocol/**', '../bridge*', '../daemon*'],
          message: 'The tools layer describes WHAT a tool does, not HOW a frame travels: it must not import the wire/transport layer (protocol/, bridge*, daemon*).',
        }],
      }],
    },
  },
  {
    // Boundaries 3 and 6: memory/ must not depend on the vault, and the
    // dependency between memory/ and tools/ points the other way (tools call
    // memory). The one allowed crossing is the daemon route module, which is
    // shared plumbing between the daemon and the subsystems it routes to.
    files: ['mcp-server/src/memory/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          {
            group: ['../vault/**', '!../vault/daemon-routing.js'],
            message: 'The memory layer must not depend on the vault. The single documented exception is ../vault/daemon-routing.js (shared daemon plumbing); everything else in vault/ is off limits.',
          },
          {
            group: ['../tools/**'],
            message: 'The dependency points the other way: the tools layer calls memory. memory/ must not import tools/.',
          },
        ],
      }],
    },
  },
  {
    // Boundaries 2 and 6: the vault must not depend on the memory layer (the
    // guard move removed that direction), and the vault is called BY the tools
    // layer, never the other way round.
    files: ['mcp-server/src/vault/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          {
            group: ['../memory/**'],
            message: 'The vault must not depend on the memory layer: the guard move removed that direction, and the two subsystems share core/ instead.',
          },
          {
            group: ['../tools/**'],
            message: 'The dependency points the other way: the tools layer calls the vault. vault/ must not import tools/.',
          },
        ],
      }],
    },
  },
  {
    files: ['extension/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        chrome: 'readonly',
      },
    },
    rules: {
      ...recommendedRules,
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        caughtErrors: 'none',
        varsIgnorePattern: '^_',
      }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
];
