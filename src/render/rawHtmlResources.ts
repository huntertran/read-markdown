// Resource URLs in raw HTML (`<img src="images/a.png">`, `<video poster>`, `<source srcset>`) must be
// rewritten like Markdown image sources: the webview resolves a relative URL against its own origin, not
// the document's folder, so the image would not load. Pure (no `vscode`), unit-tested.
//
// Only the resolution is done here. The caller runs `neutralizeReservedAttributes` on the OUTPUT (a misread tag can
// turn the inserted URL into attribute names) and the webview sanitizer still decides what is allowed. A tag
// this module does not recognize is left unchanged (the image then stays broken, as before).

/** Tags whose resource attributes load a file. */
const MEDIA_TAGS = new Set(['img', 'source', 'video', 'audio', 'track']);
/** Opening tag (HTML attribute grammar, as markdown-it's `html_re`): name, then the attribute run. */
const OPEN_TAG = /<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[a-zA-Z_:][a-zA-Z0-9:._-]*(?:\s*=\s*(?:[^"'=<>`\s]+|'[^']*'|"[^"]*"))?)*)(\s*\/?>)/g;
const ATTRIBUTE = /(\s+)([a-zA-Z_:][a-zA-Z0-9:._-]*)(?:(\s*=\s*)([^"'=<>`\s]+|'[^']*'|"[^"]*"))?/g;
const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Decodes the character references an attribute value may hold (`&amp;`, `&#38;`, `&#x26;`). */
function decodeEntities(value: string): string {
  return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (all, dec?: string, hex?: string, name?: string) => {
    if (name) return NAMED_ENTITIES[name.toLowerCase()] ?? all;
    const code = dec ? Number.parseInt(dec, 10) : Number.parseInt(hex ?? '', 16);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
  });
}

function quoteAttribute(value: string): string {
  return `"${value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`;
}

function unquote(raw: string): string {
  return raw.startsWith('"') || raw.startsWith("'") ? raw.slice(1, -1) : raw;
}

/** `resolve` returns undefined for a URL it leaves alone (absolute, fragment, outside the document). */
function rewriteSrcset(value: string, resolve: (url: string) => string | undefined): string | undefined {
  let changed = false;
  const candidates = value.split(',').map((candidate) => {
    const m = /^(\s*)(\S+)(.*)$/s.exec(candidate);
    if (!m) return candidate;
    const resolved = resolve(m[2]);
    if (resolved === undefined) return candidate;
    changed = true;
    return `${m[1]}${resolved}${m[3]}`;
  });
  return changed ? candidates.join(',') : undefined;
}

/**
 * Returns `html` (the content of a raw HTML token) with the `src`, `poster` and `srcset` URLs of media tags
 * replaced by `resolve(url)`. `resolve` receives the decoded attribute value and returns undefined to keep it.
 */
export function resolveRawHtmlResources(html: string, resolve: (url: string) => string | undefined): string {
  if (!/<(?:img|source|video|audio|track)\b/i.test(html)) return html;
  return html.replace(OPEN_TAG, (tag: string, name: string, attributes: string, end: string) => {
    if (!MEDIA_TAGS.has(name.toLowerCase())) return tag;
    let changed = false;
    const rewritten = attributes.replace(ATTRIBUTE, (attr: string, space: string, attrName: string, eq?: string, raw?: string) => {
      if (eq === undefined || raw === undefined) return attr;
      const lower = attrName.toLowerCase();
      if (lower !== 'src' && lower !== 'poster' && lower !== 'srcset') return attr;
      const value = decodeEntities(unquote(raw));
      const resolved = lower === 'srcset' ? rewriteSrcset(value, resolve) : resolve(value);
      if (resolved === undefined) return attr;
      changed = true;
      return `${space}${attrName}=${quoteAttribute(resolved)}`;
    });
    return changed ? `<${name}${rewritten}${end}` : tag;
  });
}
