import * as assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

/** Ids the webview looks up with the literal `$('…')` helper or `getElementById('…')`. */
function idsUsedByWebview(): Map<string, string[]> {
  const used = new Map<string, string[]>();
  const dir = join(root, 'webview');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    const source = readFileSync(join(dir, file), 'utf8');
    for (const m of source.matchAll(/(?:\$|getElementById)\(\s*'([^']+)'\s*\)/g)) {
      used.set(m[1], [...(used.get(m[1]) ?? []), file]);
    }
  }
  return used;
}

describe('preview shell ids', () => {
  it('has an element for every id the webview looks up by a literal', () => {
    const html = readFileSync(join(root, 'src', 'preview', 'html.ts'), 'utf8');
    const defined = new Set([...html.matchAll(/\sid="([^"$]+)"/g)].map((m) => m[1]));
    const used = idsUsedByWebview();
    // Guards the regexes: a refactor of the helper must not turn this into a vacuous pass.
    assert.ok(used.size >= 10, `found only ${used.size} ids used by the webview`);
    assert.ok(defined.size >= 10, `found only ${defined.size} ids in the shell`);
    for (const [id, files] of used) {
      assert.ok(defined.has(id), `#${id} (used in ${files.join(', ')}) is not in src/preview/html.ts`);
    }
  });
});
