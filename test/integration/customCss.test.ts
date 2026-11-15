import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CustomCssProvider } from '../../src/config/customCss';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const INLINE_HEADER = '/* readMarkdown.customCss.inline */';

describe('CustomCssProvider', () => {
  let dir = '';
  let providers: CustomCssProvider[] = [];
  let savedHome: string | undefined;
  let savedProfile: string | undefined;

  function make(): CustomCssProvider {
    const provider = new CustomCssProvider();
    providers.push(provider);
    return provider;
  }

  function css(name: string, content: string): string {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  }

  /** Counts the `onDidChange` events a provider has fired so far (they are fired synchronously). */
  function countChanges(provider: CustomCssProvider): () => number {
    let n = 0;
    // Disposed with the provider's emitter in afterEach.
    provider.onDidChange(() => {
      n++;
    });
    return () => n;
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-css-'));
    savedHome = process.env.HOME;
    savedProfile = process.env.USERPROFILE;
  });

  afterEach(() => {
    for (const p of providers) p.dispose();
    providers = [];
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedProfile;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  describe('path resolution and content', () => {
    it('uses an absolute path as is and prefixes the content with the file name', async () => {
      const file = css('abs.css', 'a { color: red; }\n');
      const provider = make();
      provider.configure([file], '');
      assert.equal(await provider.get(), '/* abs.css */\na { color: red; }\n');
    });

    it('trims the entry and skips empty and blank entries', async () => {
      const file = css('trim.css', 'b{}');
      const provider = make();
      provider.configure(['', '   ', `  ${file}  `, '\t'], '');
      assert.equal(await provider.get(), '/* trim.css */\nb{}');

      const none = make();
      none.configure(['', '  '], '');
      assert.equal(await none.get(), '');
    });

    it('joins several files, then the inline CSS, with a blank line', async () => {
      const a = css('a.css', 'A');
      const b = css('b.css', 'B');
      const provider = make();
      provider.configure([a, b], 'p { margin: 0; }');
      assert.equal(await provider.get(), `/* a.css */\nA\n\n/* b.css */\nB\n\n${INLINE_HEADER}\np { margin: 0; }`);
    });

    it('appends only non-blank inline CSS', async () => {
      const file = css('only.css', 'X');
      const provider = make();
      provider.configure([file], '  \n\t ');
      assert.equal(await provider.get(), '/* only.css */\nX', 'blank inline adds no header');

      const inlineOnly = make();
      inlineOnly.configure([], 'h1 { color: blue; }');
      assert.equal(await inlineOnly.get(), `${INLINE_HEADER}\nh1 { color: blue; }`);

      const empty = make();
      empty.configure([], '');
      assert.equal(await empty.get(), '');
    });

    it('resolves "~" against HOME', async () => {
      const file = css(path.join('home', 'theme.css'), 'H');
      process.env.HOME = path.join(dir, 'home');
      process.env.USERPROFILE = path.join(dir, 'not-this-one');
      const provider = make();
      provider.configure(['~/theme.css'], '');
      assert.equal(await provider.get(), `/* theme.css */\nH`);
      assert.ok(fs.existsSync(file));
    });

    it('resolves "~" against USERPROFILE when HOME is not set', async () => {
      css(path.join('profile', 'theme.css'), 'U');
      delete process.env.HOME;
      process.env.USERPROFILE = path.join(dir, 'profile');
      const provider = make();
      provider.configure(['~/theme.css'], '');
      assert.equal(await provider.get(), `/* theme.css */\nU`);
    });

    it('resolves a relative path against the first workspace folder', async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      assert.ok(folder, 'fixture workspace must be open');
      const name = `rm-css-relative-${process.pid}-${Date.now()}.css`;
      const file = path.join(folder.uri.fsPath, name);
      fs.writeFileSync(file, 'R');
      try {
        const provider = make();
        provider.configure([name], '');
        assert.equal(await provider.get(), `/* ${name} */\nR`);
      } finally {
        fs.rmSync(file, { force: true, maxRetries: 5 });
      }
    });

    it('reports an unreadable file with its full path and keeps the other parts', async () => {
      const missing = path.join(dir, 'missing.css');
      const ok = css('ok.css', 'OK');
      const relative = 'rm-css-no-such-file.css';
      const folder = vscode.workspace.workspaceFolders?.[0];
      assert.ok(folder);
      const provider = make();
      provider.configure([missing, ok, relative], 'i{}');
      assert.equal(
        await provider.get(),
        [
          `/* Read Markdown: could not read ${vscode.Uri.file(missing).fsPath} */`,
          '/* ok.css */\nOK',
          `/* Read Markdown: could not read ${vscode.Uri.joinPath(folder.uri, relative).fsPath} */`,
          `${INLINE_HEADER}\ni{}`,
        ].join('\n\n'),
      );
    });

    it('reports a directory as unreadable', async () => {
      const provider = make();
      provider.configure([dir], '');
      assert.equal(await provider.get(), `/* Read Markdown: could not read ${vscode.Uri.file(dir).fsPath} */`);
    });
  });

  describe('configure', () => {
    it('does nothing, and keeps the loaded result, when files and inline are unchanged', async () => {
      const file = css('same.css', 'S');
      const provider = make();
      const changes = countChanges(provider);
      provider.configure([file], 'x{}');
      assert.equal(changes(), 1, 'the first configure fires');
      const first = provider.get();
      await first;

      // Events fire synchronously, so no watcher event can blur these checks.
      provider.configure([file], 'x{}');
      provider.configure([`  ${file} `, ''], 'x{}');
      assert.equal(changes(), 1, 'no change event');
      assert.equal(provider.get(), first, 'the loaded result is reused, not reloaded');
    });

    it('fires and reloads when the inline CSS changes', async () => {
      const file = css('inline.css', 'S');
      const provider = make();
      provider.configure([file], 'x{}');
      const before = await provider.get();
      const changes = countChanges(provider);

      provider.configure([file], 'y{}');
      assert.equal(changes(), 1);
      const after = await provider.get();
      assert.notEqual(after, before);
      assert.ok(after.endsWith(`${INLINE_HEADER}\ny{}`), after);
    });

    it('fires and reloads when the file list changes', async () => {
      const a = css('one.css', 'A');
      const b = css('two.css', 'B');
      const provider = make();
      provider.configure([a], '');
      assert.equal(await provider.get(), '/* one.css */\nA');
      const changes = countChanges(provider);

      provider.configure([a, b], '');
      assert.equal(changes(), 1);
      assert.equal(await provider.get(), '/* one.css */\nA\n\n/* two.css */\nB');

      provider.configure([b, a], '');
      assert.equal(changes(), 2, 'a different order is a different configuration');
      assert.equal(await provider.get(), '/* two.css */\nB\n\n/* one.css */\nA');
    });

    it('does nothing when only blank entries are added: they resolve to no file', async () => {
      const file = css('blank.css', 'S');
      const provider = make();
      provider.configure([file], '');
      await provider.get();
      const changes = countChanges(provider);
      provider.configure([file, '', '   '], '');
      assert.equal(changes(), 0);
    });
  });

  describe('watching files', () => {
    // File system watcher events are asynchronous, and a watcher only sees what happens after it is active, so these
    // tests rewrite the file until the event arrives instead of sleeping for a guessed time.
    const WATCH_TIMEOUT = 30000;

    it('fires onDidChange when a watched file is modified and get() returns the new content', async function () {
      this.timeout(WATCH_TIMEOUT + 5000);
      const file = css('watched.css', 'v0');
      const provider = make();
      provider.configure([file], '');
      assert.equal(await provider.get(), '/* watched.css */\nv0');
      const changes = countChanges(provider);
      const baseline = changes();

      let version = 0;
      const start = Date.now();
      while (changes() === baseline) {
        if (Date.now() - start > WATCH_TIMEOUT) throw new Error('timed out waiting for the file watcher to report the change');
        version++;
        fs.writeFileSync(file, `v${version}`);
        await sleep(300);
      }
      // Let a possible trailing event for the last write arrive; the content is the last write either way.
      await sleep(300);
      assert.equal(await provider.get(), `/* watched.css */\nv${version}`);
    });

    it('follows a file that is created and deleted', async function () {
      this.timeout(WATCH_TIMEOUT * 2 + 5000);
      const file = path.join(dir, 'later.css');
      const unreadable = `/* Read Markdown: could not read ${vscode.Uri.file(file).fsPath} */`;
      const provider = make();
      provider.configure([file], '');
      assert.equal(await provider.get(), unreadable);

      // Created: keep re-creating until the watcher is active and reports it.
      const created = `/* later.css */\nhere`;
      await pollUntil(
        async () => {
          fs.writeFileSync(file, 'here');
          await sleep(300);
          return (await provider.get()) === created;
        },
        'the watcher to report the new file',
        WATCH_TIMEOUT,
      );

      // Deleted.
      await pollUntil(
        async () => {
          fs.rmSync(file, { force: true });
          await sleep(300);
          return (await provider.get()) === unreadable;
        },
        'the watcher to report the deleted file',
        WATCH_TIMEOUT,
      );
    });

    it('stops watching files that were removed from the configuration', async function () {
      this.timeout(WATCH_TIMEOUT + 10000);
      const gone = css('removed.css', 'g0');
      const kept = css('kept.css', 'k0');
      const provider = make();
      provider.configure([gone, kept], '');
      await provider.get();
      const changes = countChanges(provider);

      // Positive control first: the watcher is active, and this is how long it takes to report a write.
      const started = Date.now();
      let version = 0;
      while (changes() === 0) {
        if (Date.now() - started > WATCH_TIMEOUT) throw new Error('timed out waiting for the file watcher to report the change');
        version++;
        fs.writeFileSync(gone, `g${version}`);
        await sleep(300);
      }
      const latency = Date.now() - started;

      provider.configure([kept], '');
      assert.equal(await provider.get(), '/* kept.css */\nk0');
      await sleep(500); // events of the earlier writes may still be on their way
      const settled = changes();
      const until = Date.now() + Math.max(1500, latency * 2);
      while (Date.now() < until) {
        version++;
        fs.writeFileSync(gone, `g${version}`);
        await sleep(300);
      }
      assert.equal(changes(), settled, 'a file that is no longer configured does not fire');
    });
  });
});

async function pollUntil(step: () => Promise<boolean>, what: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!(await step())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
  }
}
