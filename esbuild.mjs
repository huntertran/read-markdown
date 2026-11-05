import * as esbuild from 'esbuild';
import { copyFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const tests = process.argv.includes('--tests');

/** @type {import('esbuild').Plugin} */
const logPlugin = {
  name: 'log',
  setup(build) {
    build.onEnd((result) => {
      for (const { text, location } of result.errors) {
        console.error(`✘ [ERROR] ${text}`);
        if (location) console.error(`    ${location.file}:${location.line}:${location.column}`);
      }
      if (watch) console.log(`[watch] build finished (${build.initialOptions.outfile ?? build.initialOptions.outdir})`);
    });
  },
};

const common = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: 'silent',
  plugins: [logPlugin],
};

async function copyAssets() {
  await mkdir('dist/media', { recursive: true });
  await copyFile('node_modules/mermaid/dist/mermaid.min.js', 'dist/media/mermaid.min.js');
}

async function listTests(dir) {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith('.test.ts')).map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

async function main() {
  if (tests) {
    const unit = await listTests('test/unit');
    const integration = await listTests('test/integration');
    await Promise.all([
      esbuild.build({ ...common, entryPoints: unit, outdir: 'out/test/unit', platform: 'node', format: 'cjs', packages: 'external', sourcemap: true }),
      esbuild.build({ ...common, entryPoints: integration, outdir: 'out/test/integration', platform: 'node', format: 'cjs', packages: 'external', external: ['vscode'], sourcemap: true }),
    ]);
    return;
  }

  await copyAssets();
  const contexts = await Promise.all([
    esbuild.context({
      ...common,
      entryPoints: ['src/extension.ts'],
      outfile: 'dist/extension.js',
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      external: ['vscode'],
    }),
    esbuild.context({
      ...common,
      entryPoints: ['webview/main.ts'],
      outfile: 'dist/media/main.js',
      platform: 'browser',
      format: 'iife',
      target: 'chrome120',
    }),
  ]);

  if (watch) {
    await Promise.all(contexts.map((c) => c.watch()));
  } else {
    await Promise.all(contexts.map((c) => c.rebuild()));
    await Promise.all(contexts.map((c) => c.dispose()));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
