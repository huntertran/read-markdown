// Allowlist sanitizer for the HTML the extension host renders from Markdown (markdown-it runs with
// `html: true`, so documents can carry raw HTML). The nonce-only CSP already blocks script
// execution; this is defence in depth, and an allowlist means a new browser quirk needs no new
// entry here: anything not listed (tags, attributes, URL schemes) is dropped.
//
// Decisions worth knowing (see also the lists below):
// - `<style>` elements and `style` attributes are kept on purpose (project decision: documents may
//   restyle themselves). DOMPurify only keeps a leading `<style>` with FORCE_BODY, and drops one
//   whose CSS text contains `<` followed by a letter, `/` or `!`.
// - `data-*` is an explicit list (the renderer's own attributes), not ALLOW_DATA_ATTR, so authors
//   cannot forge the webview's internal state attributes (`data-move-id`, `data-rm-*`, ...);
//   `data-vscode-context` in particular drives the context menu and only the preview sets it.
// - `id` is kept verbatim (outline and `#fragment` links use heading slugs), so DOMPurify's
//   SANITIZE_DOM (which drops ids such as `title` or `location`) is off. DOM clobbering by `name`
//   is closed instead by allowing `name` on `<a>` only (anchors; `<img name>` is what could shadow
//   `document` properties and `form`/`embed`/`object`/`iframe` are removed anyway).
import createDOMPurify, { type Config, type DOMPurify } from 'dompurify';

/** Text nodes plus the HTML and SVG elements a rendered document can legitimately contain. */
const ALLOWED_TAGS = [
  '#text',
  // Structure
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'div', 'span', 'br', 'hr', 'blockquote', 'pre', 'code',
  'section', 'article', 'aside', 'header', 'footer', 'nav', 'main', 'address', 'hgroup', 'center',
  'details', 'summary', 'figure', 'figcaption',
  // Inline text
  'a', 'abbr', 'b', 'bdi', 'bdo', 'big', 'cite', 'del', 'dfn', 'em', 'font', 'i', 'ins', 'kbd', 'mark',
  'q', 'rp', 'rt', 'ruby', 's', 'samp', 'small', 'strike', 'strong', 'sub', 'sup', 'time', 'tt', 'u', 'var', 'wbr',
  // Lists and tables
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'caption', 'colgroup', 'col', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
  // Media. `input` is only for task-list checkboxes (see the element hook), `label` wraps them.
  'img', 'picture', 'source', 'video', 'audio', 'track', 'input', 'label',
  // Inline SVG: static drawing elements only (no use, image, animate*, set, foreignObject, script).
  'svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon', 'text', 'tspan',
  'defs', 'lineargradient', 'radialgradient', 'stop', 'title', 'desc', 'clippath', 'mask', 'pattern', 'marker',
  'symbol', 'filter', 'fegaussianblur', 'feoffset', 'feblend', 'fecolormatrix', 'fecomposite', 'feflood', 'femerge', 'femergenode',
  'style',
];

/** Attributes allowed on any allowed element. `aria-*` is on by default in DOMPurify. */
const ALLOWED_ATTR = [
  // Global and presentational HTML
  'class', 'id', 'title', 'lang', 'dir', 'role', 'style', 'align', 'valign', 'width', 'height', 'border', 'cellpadding', 'cellspacing',
  'color', 'size', 'face', 'hidden', 'open',
  // Tables, lists, text-level
  'colspan', 'rowspan', 'scope', 'headers', 'abbr', 'span', 'start', 'reversed', 'value', 'type', 'datetime', 'cite', 'for',
  // Links, images, media. `name` is narrowed to `<a>` by the attribute hook; `target` is left out
  // (the preview handles link clicks itself).
  'href', 'rel', 'name', 'src', 'srcset', 'sizes', 'media', 'alt', 'loading', 'decoding',
  'controls', 'autoplay', 'loop', 'muted', 'preload', 'poster', 'playsinline', 'kind', 'srclang', 'label', 'default',
  // Task-list checkboxes
  'checked', 'disabled',
  // The renderer's own attributes (see src/render/markdown.ts)
  'data-line', 'data-line-end', 'data-item-end', 'data-task', 'data-href', 'data-lang', 'data-rm-html',
  // SVG
  'xmlns', 'viewbox', 'preserveaspectratio', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'fx', 'fy', 'd', 'points',
  'dx', 'dy', 'transform', 'opacity', 'visibility', 'display', 'overflow', 'vector-effect',
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin',
  'stroke-dasharray', 'stroke-dashoffset', 'stroke-miterlimit', 'clip-path', 'clip-rule', 'mask', 'filter', 'offset',
  'stop-color', 'stop-opacity', 'gradientunits', 'gradienttransform', 'spreadmethod', 'clippathunits', 'maskunits',
  'maskcontentunits', 'patternunits', 'patterncontentunits', 'patterntransform', 'markerwidth', 'markerheight', 'markerunits',
  'marker-start', 'marker-mid', 'marker-end', 'orient', 'refx', 'refy', 'text-anchor', 'dominant-baseline', 'alignment-baseline',
  'font-family', 'font-size', 'font-weight', 'font-style', 'letter-spacing', 'text-decoration', 'textlength', 'lengthadjust',
  'stddeviation', 'in', 'in2', 'result', 'mode', 'operator', 'values', 'flood-color', 'flood-opacity',
];

/**
 * Allowed URL schemes are http(s) and mailto; anything without a scheme (relative paths, `#anchor`,
 * `//host`) passes. DOMPurify strips whitespace and control characters (so `java\tscript:` is seen
 * as `javascript:`) before testing. `data:` is separate: DOMPurify allows `data:` only for
 * `src`/`href` of img, source, video, audio and track.
 */
const ALLOWED_URI_REGEXP = /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.:-]|$))/i;
/** Same stripping DOMPurify applies before it tests a URL attribute (hence the control characters). */
// eslint-disable-next-line no-control-regex
const URL_NOISE = /[\u0000-\u0020\u00A0\u1680\u180E\u2000-\u2029\u205F\u3000]/g;

/** What DOMPurify drops without hoisting the element's children (it hoists them for other tags). */
const FORBID_CONTENTS = [
  // DOMPurify's defaults
  'annotation-xml', 'audio', 'colgroup', 'desc', 'foreignobject', 'head', 'iframe', 'math', 'mi', 'mn', 'mo', 'ms', 'mtext',
  'noembed', 'noframes', 'noscript', 'plaintext', 'script', 'selectedcontent', 'style', 'svg', 'template', 'thead', 'title', 'video', 'xmp',
  // Active or replaced content the old sanitizer removed together with its children
  'object', 'embed', 'applet', 'frame', 'frameset', 'form', 'base', 'meta', 'link',
];

const CONFIG: Config = {
  ALLOWED_TAGS,
  ALLOWED_ATTR,
  ALLOWED_URI_REGEXP,
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: true,
  ALLOW_UNKNOWN_PROTOCOLS: false,
  FORBID_ATTR: ['data-vscode-context'],
  FORBID_CONTENTS,
  // Keeps a leading `<style>` (otherwise the parser files it under <head>, which is discarded).
  FORCE_BODY: true,
  // Heading ids must survive verbatim; see the header comment for how clobbering is handled.
  SANITIZE_DOM: false,
  RETURN_DOM_FRAGMENT: true,
};

let purify: DOMPurify | undefined;
let boundTo: unknown;

/** Built on first use and bound to the current global `window` (also when tests swap windows). */
function instance(): DOMPurify {
  if (purify && boundTo === window) return purify;
  const p = createDOMPurify(window);
  p.setConfig(CONFIG);
  p.addHook('uponSanitizeAttribute', (node, data) => {
    switch (data.attrName) {
      case 'srcset':
        // DOMPurify tests the whole value as one URL, so every candidate is checked here.
        if (!srcsetIsSafe(data.attrValue)) data.keepAttr = false;
        break;
      case 'name':
        if (node.nodeName !== 'A') data.keepAttr = false;
        break;
    }
  });
  p.addHook('uponSanitizeElement', (node, data) => {
    // The only form control kept is the task-list checkbox.
    if (data.tagName === 'input' && (node as HTMLInputElement).type !== 'checkbox') node.parentNode?.removeChild(node);
  });
  purify = p;
  boundTo = window;
  return p;
}

/** True when every candidate URL of a `srcset` passes the URL policy. */
function srcsetIsSafe(value: string): boolean {
  for (const candidate of value.split(',')) {
    const url = candidate.trim().split(/\s+/, 1)[0] ?? '';
    if (url && !ALLOWED_URI_REGEXP.test(url.replace(URL_NOISE, ''))) return false;
  }
  return true;
}

export function sanitize(html: string): DocumentFragment {
  return instance().sanitize(html) as unknown as DocumentFragment;
}
