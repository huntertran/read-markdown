// Pure resolution of the links and image paths written in a document. No `vscode` imports, no file system
// access: everything works on URI parts (`vscode.Uri.path` style: POSIX separators, `/c:/dir` for drives) so it
// runs under plain mocha. Callers do the `stat`, and turn the result back into a `vscode.Uri` (`toUri`).
//
// The same rules serve links (PreviewManager.openLink) and images (PreviewPanel.resolveResource), and the result
// says whether the target lies in an allowed root (`inside`), which the caller can use to decide whether to ask
// before opening it. Symlinks are out of scope: this is string arithmetic, so a link inside a root that points
// outside it is reported as inside.
import * as path from 'node:path';

/** The parts of a `vscode.Uri` this module needs; a `vscode.Uri` satisfies it. */
export interface UriParts {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
}

export interface PathContext {
  /** The document the reference is written in. */
  document: UriParts;
  /** All workspace folders (`vscode.workspace.workspaceFolders`). */
  workspaceFolders: readonly UriParts[];
  /**
   * `file` documents only (a local file system): the host is Windows, so backslashes separate path segments in
   * references relative to the document, and `\\host\share` is a UNC path. Default false.
   */
  windows?: boolean;
  /** `file` documents only: compare paths without regard to case. Default: same as `windows`. */
  caseInsensitive?: boolean;
  /**
   * Where a relative reference in a document that is not a local file (`vscode-remote:`, `untitled:`) starts:
   * `document` (its folder, the default) or `workspace` (the first workspace folder; what image paths did before
   * this module existed, kept as is).
   */
  relativeBase?: 'document' | 'workspace';
}

export type Reference =
  /** `#heading` only: refers to the document itself. */
  | { kind: 'fragment'; fragment: string }
  /** `http:`, `https:`, `mailto:`: handed to the OS. */
  | { kind: 'external'; scheme: string }
  /** Any other scheme (`command:`, `vscode:`, `javascript:`, a Windows drive `C:`…): deliberately not opened. */
  | { kind: 'unsupported'; scheme: string }
  | {
      kind: 'local';
      scheme: string;
      authority: string;
      /** Normalised (`.`/`..` resolved after percent-decoding). */
      path: string;
      /** Percent-decoded, without the leading `?` / `#`; empty when absent. */
      query: string;
      fragment: string;
      /** The target lies in `allowedRoots(context)` (the root itself counts). */
      inside: boolean;
    }
  | { kind: 'invalid'; reason: 'empty' | 'no-base' };

export const EXTERNAL_SCHEMES: ReadonlySet<string> = new Set(['http', 'https', 'mailto']);

const SCHEME = /^([a-z][a-z0-9+.-]*):/i;
const DRIVE = /^\/[a-zA-Z]:(?=\/|$)/;

/** `windows` / `caseInsensitive` for documents on this machine's file system. */
export function hostPathFlags(): { windows: boolean; caseInsensitive: boolean } {
  return { windows: process.platform === 'win32', caseInsensitive: process.platform === 'win32' || process.platform === 'darwin' };
}

/**
 * Resolves `ref` (a link `href` or an image `src`, as written) in `context`. Percent-decoding happens once and
 * before the path is normalised, so `..%2F` traverses like `../`. A malformed escape keeps the raw path (and the
 * raw fragment) instead of throwing.
 */
export function resolveReference(ref: string, context: PathContext): Reference {
  if (!ref) return { kind: 'invalid', reason: 'empty' };
  const schemeMatch = SCHEME.exec(ref);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (EXTERNAL_SCHEMES.has(scheme)) return { kind: 'external', scheme };
    if (scheme === 'file') return withInside(parseFileUri(ref), context);
    return { kind: 'unsupported', scheme };
  }

  const hash = ref.indexOf('#');
  const beforeHash = hash >= 0 ? ref.slice(0, hash) : ref;
  const fragment = hash >= 0 ? decodeOrRaw(ref.slice(hash + 1)) : '';
  if (!beforeHash) return { kind: 'fragment', fragment };
  const question = beforeHash.indexOf('?');
  const rawPath = question >= 0 ? beforeHash.slice(0, question) : beforeHash;
  const query = question >= 0 ? decodeOrRaw(beforeHash.slice(question + 1)) : '';
  const decoded = decodeOrRaw(rawPath);

  const located = decoded.startsWith('/') ? resolveWorkspaceRoot(decoded, context) : resolveRelative(decoded, context);
  if (!located) return { kind: 'invalid', reason: 'no-base' };
  return withInside({ kind: 'local', ...located, query, fragment }, context);
}

/**
 * Roots a document may reach: its workspace folders and, for a local file, the folder it is in. This is also the
 * webview's `localResourceRoots` (besides the extension's own media folders), so an image outside it cannot load.
 */
export function allowedRoots(context: PathContext): UriParts[] {
  const doc = context.document;
  const roots: UriParts[] = [];
  if (doc.scheme === 'file') roots.push({ scheme: 'file', authority: doc.authority, path: path.posix.dirname(doc.path) });
  roots.push(...context.workspaceFolders);
  return roots;
}

/** True if `target` is one of `roots` or lies below one. Paths are normalised first; `/a/b` does not contain `/a/bc`. */
export function isInsideRoots(target: UriParts, roots: readonly UriParts[], context: Pick<PathContext, 'caseInsensitive' | 'windows'> = {}): boolean {
  const key = (p: UriParts): string | undefined => comparable(p, context.caseInsensitive ?? context.windows ?? false);
  const t = key(target);
  if (t === undefined) return false;
  return roots.some((root) => {
    if (root.scheme.toLowerCase() !== target.scheme.toLowerCase() || root.authority.toLowerCase() !== target.authority.toLowerCase()) {
      return false;
    }
    const r = key(root);
    if (r === undefined) return false;
    return r === '' || t === r || t.startsWith(r + '/');
  });
}

// ---- internals ----------------------------------------------------------------------------------

type Located = { scheme: string; authority: string; path: string };

type Local = Extract<Reference, { kind: 'local' }>;

function withInside(local: Omit<Local, 'inside'>, context: PathContext): Local {
  return { ...local, inside: isInsideRoots(local, allowedRoots(context), context) };
}

/** Path comparison key: normalised, no trailing slash (the root `/` becomes ''), drive letter folded. */
function comparable(p: UriParts, caseInsensitive: boolean): string {
  let norm = path.posix.normalize(p.path || '/');
  if (norm.length > 1 && norm.endsWith('/')) norm = norm.slice(0, -1);
  if (norm === '/') norm = '';
  norm = norm.replace(DRIVE, (d) => d.toLowerCase());
  return caseInsensitive && p.scheme.toLowerCase() === 'file' ? norm.toLowerCase() : norm;
}

function decodeOrRaw(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** `/…`: from the workspace folder of the document (else the first one), else from the file system root. */
function resolveWorkspaceRoot(decoded: string, context: PathContext): Located {
  const folder = folderOf(context.document, context) ?? context.workspaceFolders[0];
  if (folder) return { scheme: folder.scheme, authority: folder.authority, path: path.posix.join(folder.path, decoded) };
  // No workspace: an absolute file path, which may be written `//host/share/…` (a UNC path).
  return fileFromAbsolute(context.windows ? decoded.replace(/\\/g, '/') : decoded);
}

function resolveRelative(decoded: string, context: PathContext): Located | undefined {
  const doc = context.document;
  if (doc.scheme === 'file') return resolveInLocalFile(decoded, context);
  if (context.relativeBase === 'workspace') {
    const folder = context.workspaceFolders[0];
    return folder ? { scheme: folder.scheme, authority: folder.authority, path: path.posix.join(folder.path, decoded) } : undefined;
  }
  // `untitled:` has no folder: its "directory" is empty, so the result is just the relative path.
  return { scheme: doc.scheme, authority: doc.authority, path: path.posix.join(doc.path, '..', decoded) };
}

/**
 * Relative to a document on the local file system, the way `path.resolve(dirname(fsPath), ref)` does on the host:
 * `..` stops at the drive / UNC share root, and on Windows `\x` is the root of the document's drive and
 * `\\host\share\x` a UNC path.
 */
function resolveInLocalFile(decoded: string, context: PathContext): Located {
  const doc = context.document;
  const ref = context.windows ? decoded.replace(/\\/g, '/') : decoded;
  if (context.windows && ref.startsWith('//')) return fileFromAbsolute(ref);
  const root = rootOf(doc);
  if (context.windows && ref.startsWith('/')) {
    return { scheme: doc.scheme, authority: doc.authority, path: root + path.posix.normalize(ref) };
  }
  const base = path.posix.dirname(doc.path).slice(root.length) || '/';
  return { scheme: doc.scheme, authority: doc.authority, path: root + path.posix.normalize(path.posix.join(base, ref)) };
}

/** The part of a local file path `..` cannot climb out of: a drive (`/c:`) or a UNC share (`/share`). */
function rootOf(doc: UriParts): string {
  const drive = DRIVE.exec(doc.path);
  if (drive) return drive[0];
  if (doc.authority) return /^\/[^/]*/.exec(doc.path)?.[0] ?? '';
  return '';
}

/** What `vscode.Uri.file` makes of an absolute path: a leading `//host` is the authority. */
function fileFromAbsolute(p: string): Located {
  let authority = '';
  if (p.startsWith('//')) {
    const slash = p.indexOf('/', 2);
    authority = slash === -1 ? p.slice(2) : p.slice(2, slash);
    p = slash === -1 ? '/' : p.slice(slash);
  }
  return { scheme: 'file', authority, path: path.posix.normalize(p) };
}

/** The workspace folder containing `doc` (the deepest one), as `workspace.getWorkspaceFolder`. */
function folderOf(doc: UriParts, context: PathContext): UriParts | undefined {
  const flags = { windows: context.windows, caseInsensitive: context.caseInsensitive };
  let best: UriParts | undefined;
  for (const f of context.workspaceFolders) {
    if (isInsideRoots(doc, [f], flags) && (!best || f.path.length > best.path.length)) best = f;
  }
  return best;
}

/** `file:` URI the way `vscode.Uri.parse` reads it: scheme, `//authority`, path, `?query`, `#fragment`, percent-decoded. */
function parseFileUri(href: string): Omit<Local, 'inside'> {
  const m = /^([^:/?#]+?:)(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?/.exec(href);
  let p = gracefulDecode(m?.[3] ?? '');
  if (!p.startsWith('/')) p = '/' + p;
  return {
    kind: 'local',
    scheme: 'file',
    authority: gracefulDecode(m?.[2] ?? ''),
    path: path.posix.normalize(p),
    query: gracefulDecode(m?.[4] ?? ''),
    fragment: gracefulDecode(m?.[5] ?? ''),
  };
}

/** Like VS Code's own URI parsing: decodes each run of escapes, leaving a malformed run as written. */
function gracefulDecode(s: string): string {
  return s.replace(/(%[0-9A-Za-z][0-9A-Za-z])+/g, (run) => decodeRun(run));
}

function decodeRun(run: string): string {
  try {
    return decodeURIComponent(run);
  } catch {
    return run.length > 3 ? run.slice(0, 3) + decodeRun(run.slice(3)) : run;
  }
}
