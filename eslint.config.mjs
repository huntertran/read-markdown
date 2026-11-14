// @ts-check
import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'out/**', 'node_modules/**', '.vscode-test/**', 'plan/**', '*.vsix'],
  },

  // TypeScript: type-aware. projectService resolves each file to its nearest tsconfig.json
  // (root: src, test/unit, test/integration; webview/; test/webview/), so files shared between
  // projects (src/protocol.ts, src/diff/*) are linted under the root project.
  {
    files: ['**/*.ts'],
    extends: [eslint.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
  {
    files: ['webview/**/*.ts', 'test/webview/**/*.ts'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['src/**/*.ts', 'test/unit/**/*.ts', 'test/integration/**/*.ts'],
    languageOptions: { globals: { ...globals.node, ...globals.mocha } },
  },
  {
    files: ['test/webview/**/*.ts'],
    languageOptions: { globals: { ...globals.node, ...globals.mocha } },
  },

  // Plain JS/MJS (build + demo scripts): not type-aware, Node globals.
  {
    files: ['**/*.mjs', '**/*.js'],
    extends: [eslint.configs.recommended],
    languageOptions: { globals: globals.node },
    rules: {
      // record.mjs matches Monaco's NBSP characters with literal ones inside regexes.
      'no-irregular-whitespace': ['error', { skipRegExps: true }],
    },
  },
  {
    // record.mjs passes functions to page.evaluate(); they run in the browser.
    files: ['scripts/demo/**/*.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
);
