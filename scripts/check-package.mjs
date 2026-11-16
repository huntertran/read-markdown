// Smoke test of the .vsix contents (CI, after `npm run package`): the files `vsce` would package must be
// exactly the expected ones, so a broken .vscodeignore (sources or tests shipped) or a missing build output
// (`dist/media/mermaid.min.js` is copied, not bundled) fails the build. Update EXPECTED when a shipped file
// is added on purpose.
import { execSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';

const EXPECTED = [
  'CHANGELOG.md',
  'LICENSE',
  'README.md',
  'dist/extension.js',
  'dist/media/main.js',
  'dist/media/mermaid.min.js',
  'media/icon-dark.svg',
  'media/icon-light.svg',
  'media/icon.png',
  'media/preview.css',
  'package.json',
];

const output = execSync('npx vsce ls', { encoding: 'utf8' });
const listed = output
  .split(/\r?\n/)
  .map((line) => line.trim().replaceAll('\\', '/'))
  .filter(Boolean);

const missing = EXPECTED.filter((file) => !listed.includes(file));
const extra = listed.filter((file) => !EXPECTED.includes(file));
const empty = EXPECTED.filter((file) => existsSync(file) && statSync(file).size === 0);

for (const file of missing) console.error(`missing from the package: ${file}`);
for (const file of extra) console.error(`unexpected file in the package: ${file}`);
for (const file of empty) console.error(`empty file in the package: ${file}`);

if (missing.length || extra.length || empty.length) process.exit(1);
console.log(`package contents ok (${listed.length} files)`);
