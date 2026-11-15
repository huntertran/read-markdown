import * as assert from 'node:assert/strict';
import type * as vscode from 'vscode';
import {
  type ApiState,
  type GitApi,
  GitBaseline,
  type GitExtension,
  type GitExtensionHandle,
  type GitRepository,
} from '../../src/scm/gitBaseline';

/** A stand-in for `vscode.Uri`: what `GitBaseline` reads (scheme, fsPath, toString). */
function fakeUri(path: string, scheme = 'file'): vscode.Uri {
  return { scheme, path, fsPath: path, toString: () => `${scheme}://${path}` } as unknown as vscode.Uri;
}

/** An event (and emitter) that counts its live listeners and records what it fired. */
class FakeEvent<T> {
  private readonly listeners = new Set<{ fn: (e: T) => unknown }>();
  readonly fired: T[] = [];
  disposed = false;

  readonly event: vscode.Event<T> = (fn: (e: T) => unknown): vscode.Disposable => {
    const entry = { fn };
    this.listeners.add(entry);
    return { dispose: () => void this.listeners.delete(entry) };
  };

  get listenerCount(): number {
    return this.listeners.size;
  }

  fire(e: T): void {
    this.fired.push(e);
    for (const l of [...this.listeners]) l.fn(e);
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A repository whose index is a map of fsPath → content; a missing path is untracked (`show` rejects). */
class FakeRepo implements GitRepository {
  readonly rootUri: vscode.Uri;
  readonly stateChange = new FakeEvent<void>();
  readonly state = { onDidChange: this.stateChange.event };
  readonly index = new Map<string, string>();
  /** The paths `show` was called with, in order. */
  readonly shows: string[] = [];
  private held: Deferred<string> | undefined;

  constructor(readonly root: string) {
    this.rootUri = fakeUri(root);
  }

  /** Makes the next `show` wait until the returned deferred is settled. */
  holdNext(): Deferred<string> {
    this.held = deferred<string>();
    return this.held;
  }

  show(ref: string, path: string): Promise<string> {
    assert.equal(ref, '', 'reads the index');
    this.shows.push(path);
    const held = this.held;
    this.held = undefined;
    if (held) return held.promise;
    const text = this.index.get(path);
    return text === undefined ? Promise.reject(new Error(`untracked: ${path}`)) : Promise.resolve(text);
  }
}

class FakeApi implements GitApi {
  state: ApiState;
  readonly stateChange = new FakeEvent<ApiState>();
  readonly opened = new FakeEvent<GitRepository>();
  readonly closed = new FakeEvent<GitRepository>();
  readonly onDidChangeState = this.stateChange.event;
  readonly onDidOpenRepository = this.opened.event;
  readonly onDidCloseRepository = this.closed.event;
  repos: FakeRepo[] = [];

  constructor(state: ApiState) {
    this.state = state;
  }

  getRepository(uri: vscode.Uri): GitRepository | null {
    return this.repos.find((r) => uri.fsPath.startsWith(`${r.root}/`)) ?? null;
  }

  /** Live listeners on the three API events. */
  get listenerCounts(): number[] {
    return [this.stateChange.listenerCount, this.opened.listenerCount, this.closed.listenerCount];
  }
}

class FakeGit implements GitExtension {
  readonly enablement = new FakeEvent<boolean>();
  readonly onDidChangeEnablement = this.enablement.event;
  getAPICalls = 0;

  constructor(
    public enabled: boolean,
    public api: FakeApi,
  ) {}

  getAPI(version: 1): GitApi {
    assert.equal(version, 1);
    this.getAPICalls++;
    return this.api;
  }
}

interface Options {
  /** No Git extension installed (`getExtension` returns undefined). */
  missing?: boolean;
  /** `getExtension` throws. */
  lookupThrows?: boolean;
  /** Extension already active (exports used directly); default true. */
  active?: boolean;
  /** What `activate()` does when the extension is not active: resolve (default), reject, or wait for `activation`. */
  activate?: 'resolve' | 'reject' | 'gate';
  enabled?: boolean;
  state?: ApiState;
}

interface Setup {
  baseline: GitBaseline;
  git: FakeGit;
  api: FakeApi;
  /** Repository at /ws, holding /ws/a.md = 'a1' and /ws/b.md = 'b1'. */
  repo: FakeRepo;
  /** The emitter behind `onDidChange`. */
  emitter: FakeEvent<vscode.Uri | undefined>;
  /** What `onDidChange` delivered: the file's string, or undefined for "any file". */
  changes: (string | undefined)[];
  lookups: () => number;
  activations: () => number;
  /** For `activate: 'gate'`: settles the pending activation. */
  activation: Deferred<GitExtension>;
}

const A = fakeUri('/ws/a.md');
const B = fakeUri('/ws/b.md');

function setup(o: Options = {}): Setup {
  const api = new FakeApi(o.state ?? 'initialized');
  const repo = new FakeRepo('/ws');
  repo.index.set(A.fsPath, 'a1');
  repo.index.set(B.fsPath, 'b1');
  api.repos.push(repo);
  const git = new FakeGit(o.enabled ?? true, api);
  const activation = deferred<GitExtension>();
  let lookups = 0;
  let activations = 0;
  const handle: GitExtensionHandle = {
    isActive: o.active ?? true,
    exports: git,
    activate: () => {
      activations++;
      if (o.activate === 'reject') return Promise.reject(new Error('activation failed'));
      if (o.activate === 'gate') return activation.promise;
      return Promise.resolve(git);
    },
  };
  const emitter = new FakeEvent<vscode.Uri | undefined>();
  const baseline = new GitBaseline({
    getGitExtension: () => {
      lookups++;
      if (o.lookupThrows) throw new Error('lookup failed');
      return o.missing ? undefined : handle;
    },
    createEmitter: () => emitter,
  });
  const changes: (string | undefined)[] = [];
  baseline.onDidChange((uri) => changes.push(uri?.toString()));
  return { baseline, git, api, repo, emitter, changes, lookups: () => lookups, activations: () => activations, activation };
}

/** Lets pending promise chains (activation, `show`, a refresh) settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** A baseline whose Git API is connected and initialized; `changes` and `shows` are cleared. */
async function connected(o: Options = {}): Promise<Setup> {
  const s = setup(o);
  assert.equal(await s.baseline.getOriginal(A), undefined, 'the first call only starts connecting');
  await flush();
  s.changes.length = 0;
  s.repo.shows.length = 0;
  return s;
}

/** Collects unhandled promise rejections while `run` executes (and a little after). */
async function unhandledRejections(run: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    seen.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);
  try {
    await run();
    await flush();
    await flush();
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  return seen;
}

describe('GitBaseline', () => {
  describe('getOriginal', () => {
    it('returns the index content of a file in a repository', async () => {
      const s = await connected();
      assert.equal(await s.baseline.getOriginal(A), 'a1');
      assert.deepEqual(s.repo.shows, ['/ws/a.md']);
    });

    it('has no baseline for a document that is not a file, without even looking for Git', async () => {
      const s = setup();
      assert.equal(await s.baseline.getOriginal(fakeUri('Untitled-1', 'untitled')), undefined);
      await flush();
      assert.equal(s.lookups(), 0);
      assert.deepEqual(s.changes, []);
    });

    it('has no baseline for a file outside every repository', async () => {
      const s = await connected();
      assert.equal(await s.baseline.getOriginal(fakeUri('/elsewhere/c.md')), undefined);
      assert.deepEqual(s.repo.shows, []);
      assert.equal(s.repo.stateChange.listenerCount, 0, 'no repository to watch');
    });

    it('has no baseline for a file that is not in the index (show rejects)', async () => {
      const s = await connected();
      const untracked = fakeUri('/ws/new.md');
      const rejections = await unhandledRejections(async () => {
        assert.equal(await s.baseline.getOriginal(untracked), undefined);
      });
      assert.deepEqual(rejections, []);
      assert.deepEqual(s.repo.shows, ['/ws/new.md']);
    });

    it('has no baseline when the Git extension is not installed', async () => {
      const s = setup({ missing: true });
      assert.equal(await s.baseline.getOriginal(A), undefined);
      await flush();
      assert.equal(await s.baseline.getOriginal(A), undefined);
      assert.deepEqual(s.changes, []);
      assert.deepEqual(s.repo.shows, []);
    });

    it('has no baseline while Git is disabled', async () => {
      const s = setup({ enabled: false });
      assert.equal(await s.baseline.getOriginal(A), undefined);
      await flush();
      assert.equal(await s.baseline.getOriginal(A), undefined);
      assert.equal(s.git.getAPICalls, 0);
      assert.deepEqual(s.api.listenerCounts, [0, 0, 0]);
      assert.deepEqual(s.changes, []);
      assert.equal(s.git.enablement.listenerCount, 1, 'still waits for Git to be enabled');
    });

    it('reports "any file" once the Git extension is connected and its API initialized', async () => {
      const s = setup();
      assert.equal(await s.baseline.getOriginal(A), undefined);
      await flush();
      assert.deepEqual(s.changes, [undefined]);
      assert.equal(await s.baseline.getOriginal(A), 'a1');
    });

    it('waits for an inactive Git extension to activate', async () => {
      const s = setup({ active: false, activate: 'gate' });
      assert.equal(await s.baseline.getOriginal(A), undefined);
      assert.equal(s.activations(), 1);
      assert.equal(await s.baseline.getOriginal(A), undefined, 'still activating');
      s.activation.resolve(s.git);
      await flush();
      assert.deepEqual(s.changes, [undefined]);
      assert.equal(await s.baseline.getOriginal(A), 'a1');
    });

    it('uses the exports of an active Git extension without activating it again', async () => {
      const s = await connected({ active: true });
      assert.equal(s.activations(), 0);
      assert.equal(await s.baseline.getOriginal(A), 'a1');
    });

    it('has no baseline while the Git API is uninitialized, and reports "any file" once it is', async () => {
      const s = setup({ state: 'uninitialized' });
      assert.equal(await s.baseline.getOriginal(A), undefined);
      await flush();
      assert.equal(await s.baseline.getOriginal(A), undefined);
      assert.deepEqual(s.changes, [], 'nothing to report yet');
      assert.deepEqual(s.repo.shows, []);
      s.api.stateChange.fire('uninitialized');
      assert.deepEqual(s.changes, []);
      s.api.state = 'initialized';
      s.api.stateChange.fire('initialized');
      assert.deepEqual(s.changes, [undefined]);
      assert.equal(await s.baseline.getOriginal(A), 'a1');
      assert.equal(s.lookups(), 1, 'connected once');
    });

    it('starts only one activation for several calls before it resolves', async () => {
      const s = setup({ active: false, activate: 'gate' });
      const results = await Promise.all([s.baseline.getOriginal(A), s.baseline.getOriginal(B), s.baseline.getOriginal(A)]);
      assert.deepEqual(results, [undefined, undefined, undefined]);
      assert.equal(s.lookups(), 1);
      assert.equal(s.activations(), 1);
      s.activation.resolve(s.git);
      await flush();
      assert.equal(s.git.enablement.listenerCount, 1);
      assert.deepEqual(s.api.listenerCounts, [1, 1, 1]);
      assert.deepEqual(s.changes, [undefined]);
    });

    it('has no baseline, and no unhandled rejection, when activating Git fails', async () => {
      let s: Setup | undefined;
      const rejections = await unhandledRejections(async () => {
        s = setup({ active: false, activate: 'reject' });
        assert.equal(await s.baseline.getOriginal(A), undefined);
        await flush();
        assert.equal(await s.baseline.getOriginal(A), undefined);
      });
      assert.deepEqual(rejections, []);
      assert.ok(s);
      assert.equal(s.activations(), 1, 'not retried');
      assert.deepEqual(s.changes, []);
      assert.deepEqual(s.repo.shows, []);
    });

    it('has no baseline, and no unhandled rejection, when looking up the Git extension throws', async () => {
      let s: Setup | undefined;
      const rejections = await unhandledRejections(async () => {
        s = setup({ lookupThrows: true });
        assert.equal(await s.baseline.getOriginal(A), undefined);
        await flush();
        assert.equal(await s.baseline.getOriginal(A), undefined);
      });
      assert.deepEqual(rejections, []);
      assert.ok(s);
      assert.equal(s.lookups(), 1, 'not retried');
      assert.deepEqual(s.changes, []);
    });
  });

  describe('cache', () => {
    it('reads each file once', async () => {
      const s = await connected();
      assert.equal(await s.baseline.getOriginal(A), 'a1');
      s.repo.index.set(A.fsPath, 'a2');
      assert.equal(await s.baseline.getOriginal(A), 'a1', 'cached until the repository reports a change');
      assert.equal(await s.baseline.getOriginal(fakeUri('/ws/a.md')), 'a1', 'keyed by the URI string, not the object');
      assert.equal(await s.baseline.getOriginal(B), 'b1');
      assert.deepEqual(s.repo.shows, ['/ws/a.md', '/ws/b.md']);
    });

    it('reads afresh when the file now belongs to a different repository object', async () => {
      const s = await connected();
      assert.equal(await s.baseline.getOriginal(A), 'a1');
      const other = new FakeRepo('/ws');
      other.index.set(A.fsPath, 'a-other');
      s.api.repos = [other];
      assert.equal(await s.baseline.getOriginal(A), 'a-other');
      assert.deepEqual(other.shows, ['/ws/a.md']);
      assert.equal(await s.baseline.getOriginal(A), 'a-other');
      assert.deepEqual(other.shows, ['/ws/a.md'], 'the replacement entry is cached');
      assert.equal(other.stateChange.listenerCount, 1, 'the new repository is watched');
    });

    it('watches each repository once', async () => {
      const s = await connected();
      await s.baseline.getOriginal(A);
      await s.baseline.getOriginal(B);
      await s.baseline.getOriginal(A);
      assert.equal(s.repo.stateChange.listenerCount, 1);
    });
  });

  describe('refresh on repository state changes', () => {
    it('reports a file whose index content changed and serves the new content without reading again', async () => {
      const s = await connected();
      await s.baseline.getOriginal(A);
      s.repo.index.set(A.fsPath, 'a2');
      s.repo.stateChange.fire();
      await flush();
      assert.deepEqual(s.changes, ['file:///ws/a.md']);
      assert.equal(s.repo.shows.length, 2);
      assert.equal(await s.baseline.getOriginal(A), 'a2');
      assert.equal(s.repo.shows.length, 2, 'the refreshed content is cached');
    });

    it('reports the file it was asked for (the stored URI)', async () => {
      const s = await connected();
      await s.baseline.getOriginal(A);
      let delivered: vscode.Uri | undefined;
      s.baseline.onDidChange((uri) => (delivered = uri));
      s.repo.index.set(A.fsPath, 'a2');
      s.repo.stateChange.fire();
      await flush();
      assert.equal(delivered?.fsPath, '/ws/a.md');
      assert.equal(delivered?.toString(), A.toString());
    });

    it('does not report a status refresh that left the index content as it was', async () => {
      const s = await connected();
      await s.baseline.getOriginal(A);
      s.repo.stateChange.fire();
      await flush();
      assert.deepEqual(s.repo.shows, ['/ws/a.md', '/ws/a.md'], 'read again');
      assert.deepEqual(s.changes, []);
    });

    it('reports a file that left the index (now untracked) and one that entered it', async () => {
      const s = await connected();
      const c = fakeUri('/ws/c.md');
      await s.baseline.getOriginal(A);
      assert.equal(await s.baseline.getOriginal(c), undefined);
      s.repo.index.delete(A.fsPath);
      s.repo.index.set(c.fsPath, 'c1');
      s.repo.stateChange.fire();
      await flush();
      assert.deepEqual(s.changes, ['file:///ws/a.md', 'file:///ws/c.md']);
      assert.equal(await s.baseline.getOriginal(A), undefined);
      assert.equal(await s.baseline.getOriginal(c), 'c1');
    });

    it('re-reads only the files that have a baseline, and only those of that repository', async () => {
      const s = await connected();
      const other = new FakeRepo('/other');
      const c = fakeUri('/other/c.md');
      other.index.set(c.fsPath, 'c1');
      s.api.repos.push(other);
      await s.baseline.getOriginal(A);
      await s.baseline.getOriginal(c);
      s.repo.shows.length = 0;
      other.shows.length = 0;
      s.repo.stateChange.fire();
      await flush();
      assert.deepEqual(s.repo.shows, ['/ws/a.md'], 'b.md was never asked for');
      assert.deepEqual(other.shows, []);
      other.index.set(c.fsPath, 'c2');
      other.stateChange.fire();
      await flush();
      assert.deepEqual(other.shows, ['/other/c.md']);
      assert.deepEqual(s.repo.shows, ['/ws/a.md']);
      assert.deepEqual(s.changes, ['file:///other/c.md']);
    });

    it('drops a refresh whose file was released while it was reading', async () => {
      const s = await connected();
      await s.baseline.getOriginal(A);
      const read = s.repo.holdNext();
      s.repo.stateChange.fire();
      s.baseline.release(A);
      read.resolve('a2');
      await flush();
      assert.deepEqual(s.changes, []);
      s.repo.index.set(A.fsPath, 'a3');
      assert.equal(await s.baseline.getOriginal(A), 'a3', 'the dropped result did not bring the entry back');
      assert.equal(s.repo.shows.length, 3, 'first read, refresh, read afresh');
    });

    it('drops a refresh whose entry was replaced while it was reading', async () => {
      const s = await connected();
      await s.baseline.getOriginal(A);
      const read = s.repo.holdNext();
      s.repo.stateChange.fire();
      // A repository opens meanwhile: every baseline is reset and A is read again.
      s.api.opened.fire(new FakeRepo('/new'));
      s.repo.index.set(A.fsPath, 'a3');
      assert.equal(await s.baseline.getOriginal(A), 'a3');
      read.resolve('a2');
      await flush();
      assert.deepEqual(s.changes, [undefined], 'only the reset, no report from the stale refresh');
      assert.equal(await s.baseline.getOriginal(A), 'a3', 'the stale result did not overwrite the new entry');
      assert.equal(s.repo.shows.length, 3, 'first read, refresh, read after the reset; none since');
    });

    it('does not re-read files of a repository after their baselines were reset', async () => {
      const s = await connected();
      await s.baseline.getOriginal(A);
      s.api.opened.fire(new FakeRepo('/new'));
      s.repo.shows.length = 0;
      s.repo.stateChange.fire();
      await flush();
      assert.deepEqual(s.repo.shows, []);
    });
  });

  describe('repositories', () => {
    it('resets every baseline and reports "any file" when a repository opens', async () => {
      const s = await connected();
      await s.baseline.getOriginal(A);
      s.api.opened.fire(new FakeRepo('/new'));
      assert.deepEqual(s.changes, [undefined]);
      s.repo.index.set(A.fsPath, 'a2');
      assert.equal(await s.baseline.getOriginal(A), 'a2', 'read afresh');
      assert.equal(s.repo.stateChange.listenerCount, 1, 'repository listeners are kept');
    });

    it('stops watching a repository that closes, resets every baseline and reports "any file"', async () => {
      const s = await connected();
      const other = new FakeRepo('/other');
      other.index.set('/other/c.md', 'c1');
      s.api.repos.push(other);
      await s.baseline.getOriginal(A);
      await s.baseline.getOriginal(fakeUri('/other/c.md'));
      s.api.repos = [other];
      s.api.closed.fire(s.repo);
      assert.equal(s.repo.stateChange.listenerCount, 0);
      assert.equal(other.stateChange.listenerCount, 1, 'other repositories stay watched');
      assert.deepEqual(s.changes, [undefined]);
      s.repo.shows.length = 0;
      s.repo.stateChange.fire();
      await flush();
      assert.deepEqual(s.repo.shows, []);
      assert.equal(await s.baseline.getOriginal(A), undefined, 'no repository any more');
    });

    it('watches a repository again after it closed and reopened', async () => {
      const s = await connected();
      await s.baseline.getOriginal(A);
      s.api.closed.fire(s.repo);
      s.api.opened.fire(s.repo);
      assert.equal(await s.baseline.getOriginal(A), 'a1');
      assert.equal(s.repo.stateChange.listenerCount, 1);
    });
  });

  describe('Git enablement', () => {
    it('drops the API and its listeners when Git is disabled, and reports "any file"', async () => {
      const s = await connected();
      await s.baseline.getOriginal(A);
      s.git.enablement.fire(false);
      assert.deepEqual(s.changes, [undefined]);
      assert.deepEqual(s.api.listenerCounts, [0, 0, 0]);
      assert.equal(s.repo.stateChange.listenerCount, 0);
      assert.equal(await s.baseline.getOriginal(A), undefined);
      assert.equal(s.lookups(), 1, 'does not connect again');
    });

    it('listens to the API again, once, when Git is re-enabled', async () => {
      const s = await connected();
      await s.baseline.getOriginal(A);
      s.git.enablement.fire(false);
      const api = new FakeApi('initialized');
      api.repos.push(s.repo);
      s.git.api = api;
      s.git.enablement.fire(true);
      assert.equal(s.git.getAPICalls, 2);
      assert.deepEqual(s.api.listenerCounts, [0, 0, 0], 'the old API is not listened to');
      assert.deepEqual(api.listenerCounts, [1, 1, 1]);
      assert.deepEqual(s.changes, [undefined, undefined]);
      s.repo.index.set(A.fsPath, 'a2');
      assert.equal(await s.baseline.getOriginal(A), 'a2', 'baselines were reset');
      assert.equal(s.repo.stateChange.listenerCount, 1);
      s.changes.length = 0;
      api.opened.fire(new FakeRepo('/new'));
      assert.deepEqual(s.changes, [undefined], 'one listener, one report');
    });

    it('drops the old listeners when Git reports enabled twice in a row', async () => {
      const s = await connected();
      await s.baseline.getOriginal(A);
      s.git.enablement.fire(true);
      assert.deepEqual(s.api.listenerCounts, [1, 1, 1]);
      assert.equal(s.repo.stateChange.listenerCount, 0, 'repository listeners belong to the replaced API');
      assert.deepEqual(s.changes, [undefined]);
      s.changes.length = 0;
      s.api.opened.fire(new FakeRepo('/new'));
      assert.deepEqual(s.changes, [undefined]);
      assert.equal(await s.baseline.getOriginal(A), 'a1');
      assert.equal(s.repo.stateChange.listenerCount, 1);
    });

    it('starts listening when Git, disabled at first, is enabled', async () => {
      const s = setup({ enabled: false });
      assert.equal(await s.baseline.getOriginal(A), undefined);
      await flush();
      s.git.enabled = true;
      s.git.enablement.fire(true);
      assert.deepEqual(s.api.listenerCounts, [1, 1, 1]);
      assert.deepEqual(s.changes, [undefined]);
      assert.equal(await s.baseline.getOriginal(A), 'a1');
    });
  });

  describe('release', () => {
    it('forgets the file: a later call reads afresh and a refresh no longer touches it', async () => {
      const s = await connected();
      await s.baseline.getOriginal(A);
      await s.baseline.getOriginal(B);
      s.baseline.release(A);
      s.repo.shows.length = 0;
      s.repo.index.set(A.fsPath, 'a2');
      s.repo.stateChange.fire();
      await flush();
      assert.deepEqual(s.repo.shows, ['/ws/b.md']);
      assert.deepEqual(s.changes, [], 'A is not reported');
      assert.equal(await s.baseline.getOriginal(A), 'a2');
      assert.deepEqual(s.repo.shows, ['/ws/b.md', '/ws/a.md']);
    });

    it('accepts a file it never had', async () => {
      const s = await connected();
      s.baseline.release(fakeUri('/ws/none.md'));
      assert.equal(await s.baseline.getOriginal(A), 'a1');
    });
  });

  describe('dispose', () => {
    it('disposes the emitter and every listener', async () => {
      const s = await connected();
      await s.baseline.getOriginal(A);
      assert.equal(s.git.enablement.listenerCount, 1);
      assert.deepEqual(s.api.listenerCounts, [1, 1, 1]);
      assert.equal(s.repo.stateChange.listenerCount, 1);
      s.baseline.dispose();
      assert.equal(s.emitter.disposed, true);
      assert.equal(s.git.enablement.listenerCount, 0);
      assert.deepEqual(s.api.listenerCounts, [0, 0, 0]);
      assert.equal(s.repo.stateChange.listenerCount, 0);
    });

    it('can be disposed before it ever connected', () => {
      const s = setup();
      s.baseline.dispose();
      assert.equal(s.emitter.disposed, true);
      assert.equal(s.lookups(), 0);
    });
  });
});
