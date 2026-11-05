import type { Token } from 'markdown-it';

/** Plain text of an inline heading token (formatting stripped). */
export function headingText(inline: Token): string {
  if (!inline.children) return inline.content.trim();
  let text = '';
  for (const child of inline.children) {
    if (child.type === 'text' || child.type === 'code_inline' || child.type === 'image') {
      text += child.content; // image content is its alt text
    } else if (child.type === 'softbreak' || child.type === 'hardbreak') {
      text += ' ';
    }
  }
  return text.replace(/\s+/g, ' ').trim();
}

/** GitHub-style heading slugs, unique per document. */
export class Slugger {
  private readonly used = new Set<string>();

  slug(text: string): string {
    const base =
      text
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
        .replace(/\s/g, '-') || 'section';
    let slug = base;
    for (let n = 1; this.used.has(slug); n++) slug = `${base}-${n}`;
    this.used.add(slug);
    return slug;
  }
}
