// The git index version of a file, read through the built-in Git extension's public API (the same
// original VS Code's editor gutter compares against). VS Code's own SCM diff hooks for custom editors
// are proposed API, so this is the stable route. No runtime `vscode` import: the extension lookup and
// the event emitter are injected (`vscodeGit.ts` wires the real ones), so this runs under plain mocha.
import type * as vscode from 'vscode';

// Minimal subset of the Git extension API (extensions/git/src/api/git.d.ts in microsoft/vscode).
export interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly state: { readonly onDidChange: vscode.Event<void> };
  /** `ref` '' = the index (`git show :path`). */
  show(ref: string, path: string): Promise<string>;
}

export type ApiState = 'uninitialized' | 'initialized';

export interface GitApi {
  readonly state: ApiState;
  readonly onDidChangeState: vscode.Event<ApiState>;
  readonly onDidOpenRepository: vscode.Event<GitRepository>;
  readonly onDidCloseRepository: vscode.Event<GitRepository>;
  getRepository(uri: vscode.Uri): GitRepository | null;
}

export interface GitExtension {
  readonly enabled: boolean;
  readonly onDidChangeEnablement: vscode.Event<boolean>;
  getAPI(version: 1): GitApi;
}

/** The parts of `vscode.Extension<GitExtension>` that are used. */
export type GitExtensionHandle = Pick<vscode.Extension<GitExtension>, 'isActive' | 'exports' | 'activate'>;

/** The parts of `vscode.EventEmitter` that are used. */
export interface Emitter<T> extends vscode.Disposable {
  readonly event: vscode.Event<T>;
  fire(data: T): void;
}

/** What `GitBaseline` needs from VS Code. */
export interface GitBaselinePorts {
  /** `vscode.extensions.getExtension('vscode.git')`: undefined if the Git extension is not installed. */
  getGitExtension(): GitExtensionHandle | undefined;
  /** A `vscode.EventEmitter` for `onDidChange`. */
  createEmitter(): Emitter<vscode.Uri | undefined>;
}

interface Entry {
  repo: GitRepository;
  /** The file (kept so a refresh re-reads it without parsing the map key back into a Uri). */
  uri: vscode.Uri;
  /** Resolved index content; undefined = not in the index (untracked, ignored, new). */
  text: Promise<string | undefined>;
}

export class GitBaseline implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly emitter: Emitter<vscode.Uri | undefined>;
  /** Fires with the file whose baseline changed, or undefined when any may have (git became available). */
  readonly onDidChange: vscode.Event<vscode.Uri | undefined>;
  private readonly entries = new Map<string, Entry>();
  /** Repository state listeners; disposed when the repository closes or the Git API is replaced. */
  private readonly watched = new Map<GitRepository, vscode.Disposable>();
  /** Listeners on the current Git API; disposed before listening again (Git disabled / re-enabled). */
  private apiListeners: vscode.Disposable[] = [];
  private api: GitApi | undefined;
  private connecting = false;

  constructor(private readonly ports: GitBaselinePorts) {
    this.emitter = ports.createEmitter();
    this.onDidChange = this.emitter.event;
  }

  /**
   * The file's content in the git index, or undefined if there is none (no repository, untracked,
   * Git disabled, or the Git extension is still starting: `onDidChange` fires once it is ready).
   */
  async getOriginal(uri: vscode.Uri): Promise<string | undefined> {
    if (uri.scheme !== 'file') return undefined;
    const api = this.connect();
    if (!api) return undefined;
    const repo = api.getRepository(uri);
    if (!repo) return undefined;
    this.watch(repo);
    const key = uri.toString();
    let entry = this.entries.get(key);
    if (!entry || entry.repo !== repo) {
      entry = { repo, uri, text: read(repo, uri) };
      this.entries.set(key, entry);
    }
    return entry.text;
  }

  /** Forgets the file's baseline (its last preview closed); a later `getOriginal` fetches it afresh. */
  release(uri: vscode.Uri): void {
    this.entries.delete(uri.toString());
  }

  /** The Git API once it is initialized; starts connecting (without waiting) otherwise. */
  private connect(): GitApi | undefined {
    if (this.api?.state === 'initialized') return this.api;
    if (!this.connecting) {
      this.connecting = true;
      void this.activate();
    }
    return undefined;
  }

  private async activate(): Promise<void> {
    try {
      const ext = this.ports.getGitExtension();
      if (!ext) return;
      const git = ext.isActive ? ext.exports : await ext.activate();
      this.disposables.push(
        git.onDidChangeEnablement((enabled) => {
          this.api = undefined;
          this.stopListening();
          if (enabled) {
            const api = git.getAPI(1);
            this.api = api;
            this.listen(api);
          }
          this.reset();
        }),
      );
      if (!git.enabled) return;
      const api = git.getAPI(1);
      this.api = api;
      this.listen(api);
      if (api.state === 'initialized') this.reset();
    } catch {
      // Git extension missing or failed: no baseline.
    }
  }

  private listen(api: GitApi): void {
    this.stopListening();
    this.apiListeners.push(
      api.onDidChangeState((state) => {
        if (state === 'initialized') this.reset();
      }),
      // Repositories are discovered after the API initializes; files in them may now have a baseline.
      api.onDidOpenRepository(() => this.reset()),
      api.onDidCloseRepository((repo) => {
        this.watched.get(repo)?.dispose();
        this.watched.delete(repo);
        this.reset();
      }),
    );
  }

  private stopListening(): void {
    this.apiListeners.forEach((d) => {
      d.dispose();
    });
    this.apiListeners = [];
    this.watched.forEach((d) => {
      d.dispose();
    });
    this.watched.clear();
  }

  private reset(): void {
    this.entries.clear();
    this.emitter.fire(undefined);
  }

  private watch(repo: GitRepository): void {
    if (this.watched.has(repo)) return;
    // Fires on stage / unstage / commit / checkout, but also on every status refresh (e.g. a save):
    // only report files whose index content really changed.
    this.watched.set(repo, repo.state.onDidChange(() => void this.refresh(repo)));
  }

  private async refresh(repo: GitRepository): Promise<void> {
    for (const [key, entry] of [...this.entries]) {
      if (entry.repo !== repo) continue;
      const { uri } = entry;
      const next = read(repo, uri);
      const [before, after] = await Promise.all([entry.text, next]);
      if (this.entries.get(key) !== entry) continue;
      this.entries.set(key, { repo, uri, text: next });
      if (before !== after) this.emitter.fire(uri);
    }
  }

  dispose(): void {
    this.emitter.dispose();
    this.disposables.forEach((d) => {
      d.dispose();
    });
    this.stopListening();
    this.entries.clear();
  }
}

function read(repo: GitRepository, uri: vscode.Uri): Promise<string | undefined> {
  return repo.show('', uri.fsPath).then(
    (text) => text,
    () => undefined,
  );
}
