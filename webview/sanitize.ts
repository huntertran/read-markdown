// Defence in depth: the CSP already blocks inline scripts, but strip active content from raw HTML in Markdown.
const BLOCKED = 'script, iframe, frame, frameset, object, embed, applet, base, meta, link, form, noscript';
const URL_ATTRS = ['href', 'src', 'xlink:href', 'action', 'formaction', 'srcset', 'poster'];

export function sanitize(html: string): DocumentFragment {
  const template = document.createElement('template');
  template.innerHTML = html;
  const root = template.content;
  root.querySelectorAll(BLOCKED).forEach((el) => el.remove());
  root.querySelectorAll('*').forEach((el) => {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) el.removeAttribute(attr.name);
      else if (URL_ATTRS.includes(name) && /^\s*(javascript|vbscript|data:text\/html)/i.test(attr.value)) el.removeAttribute(attr.name);
    }
  });
  return root;
}
