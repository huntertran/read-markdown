// Runtime validation of messages coming from the webview, which is not trusted: its code runs
// inside a rendered document. Pure (no `vscode`, no Node imports) so it runs under plain mocha.

import type { FromWebview } from '../protocol';

type Fields = Record<string, unknown>;

const isString = (v: unknown): v is string => typeof v === 'string';
const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean';
/** A 0-based source line, document version or list index. */
const isIndex = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
/** A scroll position in (possibly fractional) source lines. */
const isLinePosition = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isJsonPrimitive = (v: unknown): boolean => isString(v) || isBoolean(v) || (typeof v === 'number' && Number.isFinite(v));
const optional = (v: unknown, check: (x: unknown) => boolean): boolean => v === undefined || check(v);

/**
 * One validator per `FromWebview` member; `Record` over the union's `type` makes a message type
 * without a validator (or a stale one) a compile error. Each checks the fields its member declares.
 */
const validators: { [K in FromWebview['type']]: (m: Fields) => boolean } = {
  ready: () => true,
  needBaseline: (m) => isIndex(m.id),
  revealLine: (m) => isLinePosition(m.line),
  openLink: (m) => isString(m.href),
  // Shape only: `validateQuickSetting` decides which keys and values are allowed.
  updateSetting: (m) => isString(m.key) && isJsonPrimitive(m.value),
  openSettings: () => true,
  copy: (m) => isString(m.text),
  showSource: (m) => optional(m.line, isIndex),
  requestBlockSource: (m) => isIndex(m.start) && isIndex(m.end) && isIndex(m.docVersion),
  editBlock: (m) => isIndex(m.start) && isIndex(m.end) && isIndex(m.docVersion) && isString(m.text),
  toggleTask: (m) => isIndex(m.line) && isBoolean(m.checked) && isIndex(m.docVersion),
  moveListItem: (m) =>
    Array.isArray(m.starts) && m.starts.every(isIndex) && isIndex(m.end) && isIndex(m.from) && isIndex(m.to) && isIndex(m.docVersion),
};

/** True if `type` names a `FromWebview` message. */
function isKnownType(type: unknown): type is FromWebview['type'] {
  return isString(type) && Object.prototype.hasOwnProperty.call(validators, type);
}

/** Returns `data` typed as a `FromWebview` message if it is one, else undefined. Never rewrites `data`. */
export function parseFromWebview(data: unknown): FromWebview | undefined {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
  const fields = data as Fields;
  if (!isKnownType(fields.type)) return undefined;
  return validators[fields.type](fields) ? (data as FromWebview) : undefined;
}

/** A short, payload-free description of `data` for logs (the message type if it has a string one). */
export function describeMessage(data: unknown): string {
  if (typeof data !== 'object' || data === null) return typeof data;
  if (Array.isArray(data)) return 'array';
  const type = (data as Fields).type;
  return isString(type) && /^[A-Za-z]{1,32}$/.test(type) ? `type "${type}"` : 'object without a usable type';
}

/** URI schemes a restored preview may open: the ones `isMarkdownDocument` accepts. */
export const RESTORABLE_SCHEMES: readonly string[] = ['file', 'untitled', 'vscode-remote'];

/** True if `scheme` may be opened when restoring a saved preview. */
export function isRestorableScheme(scheme: unknown): boolean {
  return isString(scheme) && RESTORABLE_SCHEMES.includes(scheme.toLowerCase());
}

/** The scheme of a URI string (RFC 3986), or undefined if it has none. */
export function uriScheme(uri: unknown): string | undefined {
  return isString(uri) ? /^([a-z][a-z0-9+.-]*):/i.exec(uri)?.[1].toLowerCase() : undefined;
}
