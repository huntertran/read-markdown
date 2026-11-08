// The git index version of a file, read through the built-in Git extension's public API (the same
// original VS Code's editor gutter compares against). VS Code's own SCM diff hooks for custom editors
// are proposed API, so this is the stable route.
import * as vscode from 'vscode';

// Minimal subset of the Git extension API (extensions/git/src/api/git.d.ts in microsoft/vscode).
interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly state: { readonly onDidChange: vscode.Event<void> };
  /** `ref` '' = the index (`git show :path`). */
  show(ref: string, path: string): Promise<string>;
}

type ApiState = 'uninitialized' | 'initialized';

interface GitApi {
  readonly state: ApiState;
  readonly onDidChangeState: vscode.Event<ApiState>;
  readonly onDidOpenRepository: vscode.Event<GitRepository>;
  getRepository(uri: vscode.Uri): GitRepository | null;
}

interface GitExtension {
  readonly enabled: boolean;
  readonly onDidChangeEnablement: vscode.Event<boolean>;
  getAPI(version: 1): GitApi;
}

interface Entry {
  repo: GitRepository;
  /** Resolved index content; undefined = not in the index (untracked, ignored, new). */
  text: Promise<string | undefined>;
}

export class GitBaseline implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly emitter = new vscode.EventEmitter<vscode.Uri | undefined>();
  /** Fires with the file whose baseline changed, or undefined when any may have (git became available). */
  readonly onDidChange = this.emitter.event;
  private readonly entries = new Map<string, Entry>();
  private readonly watched = new Set<GitRepository>();
  private api: GitApi | undefined;
  private connecting = false;

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
      entry = { repo, text: read(repo, uri) };
      this.entries.set(key, entry);
    }
    return entry.text;
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
      const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
      if (!ext) return;
      const git = ext.isActive ? ext.exports : await ext.activate();
      this.disposables.push(
        git.onDidChangeEnablement((enabled) => {
          this.api = undefined;
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
    this.disposables.push(
      api.onDidChangeState((state) => {
        if (state === 'initialized') this.reset();
      }),
      // Repositories are discovered after the API initializes; files in them may now have a baseline.
      api.onDidOpenRepository(() => this.reset()),
    );
  }

  private reset(): void {
    this.entries.clear();
    this.emitter.fire(undefined);
  }

  private watch(repo: GitRepository): void {
    if (this.watched.has(repo)) return;
    this.watched.add(repo);
    // Fires on stage / unstage / commit / checkout, but also on every status refresh (e.g. a save):
    // only report files whose index content really changed.
    this.disposables.push(repo.state.onDidChange(() => void this.refresh(repo)));
  }

  private async refresh(repo: GitRepository): Promise<void> {
    for (const [key, entry] of [...this.entries]) {
      if (entry.repo !== repo) continue;
      const uri = vscode.Uri.parse(key);
      const next = read(repo, uri);
      const [before, after] = await Promise.all([entry.text, next]);
      if (this.entries.get(key) !== entry) continue;
      this.entries.set(key, { repo, text: next });
      if (before !== after) this.emitter.fire(uri);
    }
  }

  dispose(): void {
    this.emitter.dispose();
    this.disposables.forEach((d) => d.dispose());
    this.entries.clear();
  }
}

function read(repo: GitRepository, uri: vscode.Uri): Promise<string | undefined> {
  return repo.show('', uri.fsPath).then(
    (text) => text,
    () => undefined,
  );
}
