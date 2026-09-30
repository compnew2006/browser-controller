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
