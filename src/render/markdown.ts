import MarkdownIt, { type Token } from 'markdown-it';
import footnote from 'markdown-it-footnote';
import taskLists from 'markdown-it-task-lists';
import hljs from 'highlight.js/lib/common';
import type { Heading } from '../protocol';
import { Slugger, headingText } from './headings';

export interface RenderOptions {
  /** Render ```mermaid fences as diagram placeholders. */
  mermaid: boolean;
  /**
   * Rewrites a relative resource path (e.g. image src) to a URL the webview can load.
   * Return undefined to keep the original value.
   */
  resolveResource?: (path: string) => string | undefined;
}

export interface RenderResult {
  html: string;
  headings: Heading[];
  hasMermaid: boolean;
  /** Sorted, unique 0-based source lines that start a rendered block (`data-line`). */
  blockLines: number[];
}

interface RenderEnv {
  options: RenderOptions;
  headings: Heading[];
  hasMermaid: boolean;
  blockLines: Set<number>;
}

const FRONT_MATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const BLOCK_LEAVES = new Set(['fence', 'code_block', 'hr', 'html_block']);
const ALERT = /^\[!(note|tip|important|warning|caution)\][ \t]*/i;

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getEnv(env: unknown): RenderEnv {
  return env as RenderEnv;
}

export function createMarkdownRenderer(): (source: string, options: RenderOptions) => RenderResult {
  const md = MarkdownIt({ html: true, linkify: true, typographer: false });
  md.use(footnote);
  md.use(taskLists, { enabled: false, label: true });

  // Source map: annotate every opening block token with its starting source line. Top-level
  // blocks also get their end line (exclusive) so the preview can edit them as raw source; their
  // ranges are disjoint, unlike nested blocks (list items, blockquote paragraphs).
  md.core.ruler.push('rm_source_map', (state) => {
    const env = getEnv(state.env);
    for (const token of state.tokens) {
      if (!token.map || !token.block) continue;
      if (token.nesting === 1 || BLOCK_LEAVES.has(token.type)) {
        const line = token.map[0];
        token.attrSet('data-line', String(line));
        if (token.level === 0) token.attrSet('data-line-end', String(token.map[1]));
        // List items get their own end line (not `data-line-end`, which marks editable top-level
        // blocks) so the preview can reorder them; it includes nested lists and trailing blanks.
        else if (token.type === 'list_item_open') token.attrSet('data-item-end', String(token.map[1]));
        env.blockLines?.add(line);
      }
    }
  });

  // Heading ids + outline.
  md.core.ruler.push('rm_headings', (state) => {
    const env = getEnv(state.env);
    const slugger = new Slugger();
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.type !== 'heading_open') continue;
      const inline = tokens[i + 1];
      const text = inline && inline.type === 'inline' ? headingText(inline) : '';
      const slug = slugger.slug(text);
      token.attrSet('id', slug);
      // Only top-level headings participate in the outline (not those inside blockquotes/lists).
      if (token.level === 0) {
        env.headings?.push({ level: Number(token.tag.slice(1)), text, slug, line: token.map ? token.map[0] : 0 });
      }
    }
  });

  // GitHub alerts: > [!NOTE] / [!TIP] / [!IMPORTANT] / [!WARNING] / [!CAUTION]
  md.core.ruler.push('rm_alerts', (state) => {
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length - 2; i++) {
      if (tokens[i].type !== 'blockquote_open' || tokens[i + 1].type !== 'paragraph_open') continue;
      const inline = tokens[i + 2];
      const first = inline.children?.[0];
      const m = first?.type === 'text' ? ALERT.exec(first.content) : null;
      if (!m || !first || !inline.children) continue;
      const kind = m[1].toLowerCase();
      tokens[i].attrJoin('class', `rm-alert rm-alert-${kind}`);
      first.content = first.content.slice(m[0].length);
      if (!first.content) {
        inline.children.shift();
        const next = inline.children[0];
        if (next && (next.type === 'softbreak' || next.type === 'hardbreak')) inline.children.shift();
      }
      const title = new state.Token('html_inline', '', 0);
      title.content = `<span class="rm-alert-title">${kind[0].toUpperCase()}${kind.slice(1)}</span>`;
      inline.children.unshift(title);
    }
  });

  md.renderer.rules.fence = (tokens, idx, _options, rawEnv) => {
    const env = getEnv(rawEnv);
    const token = tokens[idx];
    const info = token.info ? md.utils.unescapeAll(token.info).trim() : '';
    const lang = info.split(/\s+/)[0] ?? '';
    const lines = lineAttrs(token);

    if (lang.toLowerCase() === 'mermaid' && env.options?.mermaid) {
      env.hasMermaid = true;
      return `<div class="rm-mermaid"${lines}><pre class="mermaid">${escapeHtml(token.content)}</pre></div>\n`;
    }

    let body: string;
    const language = lang && hljs.getLanguage(lang) ? lang : '';
    if (language) {
      try {
        body = hljs.highlight(token.content, { language, ignoreIllegals: true }).value;
      } catch {
        body = escapeHtml(token.content);
      }
    } else {
      body = escapeHtml(token.content);
    }
    const langAttr = lang ? ` data-lang="${escapeHtml(lang)}"` : '';
    const cls = language ? ` class="hljs language-${escapeHtml(language)}"` : ' class="hljs"';
    return `<pre class="rm-code"${lines}${langAttr}><code${cls}>${body}</code></pre>\n`;
  };

  md.renderer.rules.code_block = (tokens, idx) => {
    const token = tokens[idx];
    return `<pre class="rm-code"${lineAttrs(token)}><code class="hljs">${escapeHtml(token.content)}</code></pre>\n`;
  };

  const defaultImage = md.renderer.rules.image!;
  md.renderer.rules.image = (tokens, idx, options, rawEnv, self) => {
    const env = getEnv(rawEnv);
    rewriteAttr(tokens[idx], 'src', env.options?.resolveResource);
    return defaultImage(tokens, idx, options, rawEnv, self);
  };

  // Keep the original href in data-href so the webview can resolve relative links via the extension.
  const defaultLinkOpen = md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.link_open = (tokens, idx, options, rawEnv, self) => {
    const href = tokens[idx].attrGet('href');
    if (href !== null) tokens[idx].attrSet('data-href', String(href));
    return defaultLinkOpen(tokens, idx, options, rawEnv, self);
  };

  return (source: string, options: RenderOptions): RenderResult => {
    const env: RenderEnv = { options, headings: [], hasMermaid: false, blockLines: new Set() };
    let prefix = '';
    const fm = FRONT_MATTER.exec(source);
    if (fm) {
      // Replace front matter with blank lines so source line numbers stay aligned.
      const lineCount = fm[0].split(/\r?\n/).length - 1;
      source = '\n'.repeat(lineCount) + source.slice(fm[0].length);
      // Without a trailing newline the closing `---` line is not counted by lineCount.
      const end = /\n$/.test(fm[0]) ? lineCount : lineCount + 1;
      prefix = `<details class="rm-frontmatter" data-line="0" data-line-end="${end}"><summary>Front matter</summary><pre class="rm-code"><code class="hljs language-yaml">${safeHighlight(fm[1], 'yaml')}</code></pre></details>\n`;
      env.blockLines.add(0);
    }
    const html = prefix + md.render(source, env as unknown as Record<string, unknown>);
    return {
      html,
      headings: env.headings,
      hasMermaid: env.hasMermaid,
      blockLines: [...env.blockLines].sort((a, b) => a - b),
    };
  };
}

/** ` data-line="…"` (and ` data-line-end="…"` for top-level blocks) for manually rendered tokens. */
function lineAttrs(token: Token): string {
  const line = token.attrGet('data-line');
  const end = token.attrGet('data-line-end');
  return (line !== null ? ` data-line="${line}"` : '') + (end !== null ? ` data-line-end="${end}"` : '');
}

function safeHighlight(code: string, language: string): string {
  try {
    return hljs.highlight(code, { language, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(code);
  }
}

function rewriteAttr(token: Token, attr: string, resolve: RenderOptions['resolveResource']): void {
  const value = token.attrGet(attr);
  if (value === null || !resolve) return;
  const v = String(value);
  if (!v || v.startsWith('#') || v.startsWith('//') || HAS_SCHEME.test(v)) return;
  const resolved = resolve(v);
  if (resolved) token.attrSet(attr, resolved);
}
