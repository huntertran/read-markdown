// Raw HTML in a document (markdown-it `html_block` / `html_inline`) must not be able to impersonate
// renderer output. The renderer marks blocks with `data-line*` / `data-item-end` (the preview edits,
// reorders and scrolls by them), tasks with `data-task`, links with `data-href` (preferred over
// `href` when a link is clicked), and the webview tags track-changes elements with `data-move-id` /
// `data-rm-*`. This module removes those attributes from author HTML. Pure (no `vscode`), unit-tested.
//
// Two passes, repeated until the text stops changing:
// 1. A tokenizer that follows the HTML attribute grammar (case-insensitive names, `/` and any
//    whitespace as separators, quoted / unquoted / valueless values, a `>` inside a quoted value)
//    and removes reserved attributes from every tag. Text outside tags is left alone.
// 2. A context-free safety net removing `data-<reserved> = value` wherever it still appears. The
//    tokenizer does not know the parser state a browser would be in (comments, `<textarea>`,
//    `<svg>` foreign content, ...), so a crafted document could make it disagree about where a tag
//    ends; the net does not depend on tag extents. Over-removal (e.g. inside a comment or a
//    `<pre>` text) is accepted, under-removal is not.
//
// Known limits: valueless reserved attributes are only removed by pass 1, so in a context where the
// tokenizer is misled they survive; a valueless attribute carries no line number, URL or id, so the
// webview ignores it. Prose such as `data-line = 3` inside an HTML block loses that text.

/** Attribute names (lower case) that only the renderer / webview may set. `data-rm-*` is also reserved. */
export const RESERVED_ATTRIBUTES: readonly string[] = [
  'data-line',
  'data-line-end',
  'data-item-end',
  'data-task',
  'data-href',
  'data-move-id',
  'data-vscode-context',
];
const RESERVED_PREFIX = 'data-rm-';

const RESERVED = new Set(RESERVED_ATTRIBUTES);
/** Cheap pre-check: anything reserved may be present. */
const MAY_CONTAIN = /data-(?:line|item-end|task|href|move-id|vscode-context|rm-)/i;
const NET = /data-(?:line(?:-end)?|item-end|task|href|move-id|vscode-context|rm-[^\s/>=]*)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi;
/** Safety limit for the repeat loop (each round that changes something only shortens the text). */
const MAX_ROUNDS = 8;

const GT = 62;
const SLASH = 47;
const EQUALS = 61;

function isSpace(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 12 || c === 13;
}

function isAlpha(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

function isReserved(name: string): boolean {
  const lower = name.toLowerCase();
  return RESERVED.has(lower) || lower.startsWith(RESERVED_PREFIX);
}

/**
 * Removes reserved attributes from the tags of `html`. A tag left open at the end of the string
 * (`<div data-line="1"`, or an unterminated quote) is closed, because a browser would otherwise
 * continue it into the renderer's next tag and take that tag's real `data-line` as its own attribute.
 */
function stripTags(html: string): string {
  const n = html.length;
  let out = '';
  let copyFrom = 0;
  let i = 0;
  let closer = '';
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) break;
    let j = lt + 1;
    if (html.charCodeAt(j) === SLASH) j++;
    if (!isAlpha(html.charCodeAt(j))) {
      i = lt + 1;
      continue;
    }
    // Tag name.
    while (j < n && !isSpace(html.charCodeAt(j)) && html.charCodeAt(j) !== SLASH && html.charCodeAt(j) !== GT) j++;
    // Attributes, up to the closing `>`.
    let terminated = false;
    while (j < n) {
      let c = html.charCodeAt(j);
      if (isSpace(c) || c === SLASH) {
        j++;
        continue;
      }
      if (c === GT) {
        j++;
        terminated = true;
        break;
      }
      const nameStart = j;
      j++; // A leading `=` belongs to the name, as in the HTML tokenizer.
      while (j < n) {
        c = html.charCodeAt(j);
        if (isSpace(c) || c === SLASH || c === GT || c === EQUALS) break;
        j++;
      }
      const name = html.slice(nameStart, j);
      let attrEnd = j;
      let k = j;
      while (k < n && isSpace(html.charCodeAt(k))) k++;
      let quote = '';
      if (html.charCodeAt(k) === EQUALS) {
        k++;
        while (k < n && isSpace(html.charCodeAt(k))) k++;
        const q = html[k];
        if (q === '"' || q === "'") {
          const close = html.indexOf(q, k + 1);
          if (close < 0) {
            quote = q;
            k = n;
          } else {
            k = close + 1;
          }
        } else {
          while (k < n && !isSpace(html.charCodeAt(k)) && html.charCodeAt(k) !== GT) k++;
        }
        attrEnd = k;
        j = k;
      }
      if (isReserved(name)) {
        // Take the whitespace before the attribute along, unless the next token would then be glued to the previous one.
        let from = nameStart;
        const after = html.charCodeAt(attrEnd);
        if (attrEnd >= n || isSpace(after) || after === GT || after === SLASH) {
          while (from > copyFrom && isSpace(html.charCodeAt(from - 1))) from--;
        }
        out += html.slice(copyFrom, from);
        copyFrom = attrEnd;
      } else if (quote) {
        // Unterminated value of a kept attribute: the closing quote goes in before the `>`.
        closer = quote;
      }
    }
    if (!terminated) {
      closer += '>';
      break;
    }
    i = j;
  }
  if (closer === '' && copyFrom === 0) return html;
  return out + html.slice(copyFrom) + closer;
}

/**
 * Returns `html` without reserved attributes (see the file comment). `html` is the content of one
 * markdown-it `html_block` or `html_inline` token; the renderer's own markup never goes through here.
 */
export function neutralizeReservedAttributes(html: string): string {
  if (html.indexOf('<') < 0) return html;
  let current = html;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    let next = stripTags(current);
    if (MAY_CONTAIN.test(next)) next = next.replace(NET, '');
    if (next === current) return current;
    current = next;
  }
  // Still changing after MAX_ROUNDS: a deliberately nested input. Drop it rather than let it through.
  return '';
}
