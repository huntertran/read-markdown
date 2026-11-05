// Lazily loads Mermaid only when the document contains diagrams, and caches rendered SVGs so
// live re-renders while typing do not re-layout unchanged diagrams.

interface MermaidApi {
  initialize(config: Record<string, unknown>): void;
  run(options: { nodes: ArrayLike<HTMLElement>; suppressErrors?: boolean }): Promise<void>;
}

declare global {
  interface Window {
    mermaid?: MermaidApi;
  }
}

let loading: Promise<MermaidApi> | undefined;
let initializedScheme = '';
const svgCache = new Map<string, string>();

function load(): Promise<MermaidApi> {
  loading ??= new Promise<MermaidApi>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = document.body.dataset.mermaidSrc ?? '';
    script.nonce = document.body.dataset.nonce ?? '';
    script.onload = () => (window.mermaid ? resolve(window.mermaid) : reject(new Error('Mermaid failed to load')));
    script.onerror = () => reject(new Error('Mermaid failed to load'));
    document.head.append(script);
  });
  return loading;
}

export async function renderMermaid(root: HTMLElement, scheme: 'light' | 'dark'): Promise<void> {
  const blocks = [...root.querySelectorAll<HTMLElement>('pre.mermaid')];
  if (blocks.length === 0) return;
  const pending: HTMLElement[] = [];
  for (const block of blocks) {
    block.dataset.src ??= block.textContent ?? '';
    const cached = svgCache.get(`${scheme}\n${block.dataset.src}`);
    if (cached) {
      block.innerHTML = cached;
      block.setAttribute('data-processed', 'true');
    } else if (!block.hasAttribute('data-processed')) {
      pending.push(block);
    }
  }
  if (pending.length === 0) return;

  let mermaid: MermaidApi;
  try {
    mermaid = await load();
  } catch (err) {
    pending.forEach((b) => b.classList.add('rm-mermaid-error'));
    console.error(err);
    return;
  }
  if (initializedScheme !== scheme) {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: scheme === 'dark' ? 'dark' : 'default' });
    initializedScheme = scheme;
  }
  await mermaid.run({ nodes: pending, suppressErrors: true });
  for (const block of pending) {
    if (block.querySelector('svg') && block.dataset.src !== undefined) {
      if (svgCache.size > 200) svgCache.clear();
      svgCache.set(`${scheme}\n${block.dataset.src}`, block.innerHTML);
    }
  }
}

/** Re-renders all diagrams, e.g. after the color scheme changed. */
export async function rerenderMermaid(root: HTMLElement, scheme: 'light' | 'dark'): Promise<void> {
  for (const block of root.querySelectorAll<HTMLElement>('pre.mermaid[data-processed]')) {
    block.removeAttribute('data-processed');
    block.textContent = block.dataset.src ?? '';
  }
  await renderMermaid(root, scheme);
}
