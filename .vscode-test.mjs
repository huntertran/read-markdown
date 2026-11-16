import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  // CI also runs the declared minimum (`engines.vscode`) by setting VSCODE_TEST_VERSION; default: stable.
  version: process.env.VSCODE_TEST_VERSION || 'stable',
  files: 'out/test/integration/**/*.test.js',
  workspaceFolder: './test/fixtures',
  mocha: { ui: 'bdd', timeout: 20000 },
});
