import * as assert from 'node:assert/strict';
import { MERMAID_LOOKS, MERMAID_THEMES, type MermaidTheme } from '../../src/protocol';
import { useDom } from './dom';

type MermaidModule = typeof import('../../webview/mermaid');

interface FakeMermaid {
  initialize(config: Record<string, unknown>): void;
  run(options: { nodes: ArrayLike<HTMLElement>; suppressErrors?: boolean }): Promise<void>;
}

/** What `getComputedStyle` answers for the expressions `previewThemeVariables` asks about. */
const RESOLVED: Record<string, string> = {
  'var(--rm-bg)': 'rgb(255, 255, 255)',
  'var(--rm-fg)': 'rgb(17, 34, 51)',
  'var(--rm-accent)': 'rgb(0, 102, 204)',
  'var(--rm-border)': 'rgb(204, 204, 204)',
  'var(--rm-muted)': 'rgb(102, 102, 102)',
  'color-mix(in srgb, var(--rm-accent) 14%, var(--rm-bg))': 'rgb(1, 2, 3)',
  // Translucent: toHex composites it over the background (white), 50% black -> #808080.
  'color-mix(in srgb, var(--rm-accent) 7%, var(--rm-bg))': 'rgba(0, 0, 0, 0.5)',
  'color-mix(in srgb, var(--rm-fg) 5%, var(--rm-bg))': 'rgb(240, 240, 240)',
  'var(--rm-font)': 'Test Sans, sans-serif',
};

describe('mermaid', () => {
  useDom();
  let mod: MermaidModule;
  const SRC = 'https://example.invalid/mermaid.min.js';
  let savedComputedStyle: PropertyDescriptor | undefined;
  // `useDom` removes the globals in its own `after`, which runs before ours (mocha runs `after` hooks in registration order).
  let head: HTMLHeadElement | undefined;
  let win: Window | undefined;

  // Fake Mermaid, "loaded" by completing the script tag the module appends to <head> (jsdom never fetches it).
  const initializations: Record<string, unknown>[] = [];
  const runs: HTMLElement[][] = [];
  const scripts: HTMLScriptElement[] = [];
  let running = 0;
  let overlapped = false;
  /** Set to hold every `run` until released; lets a test queue several renders at once. */
  let gate: Promise<void> | undefined;
  let drawn = 0;
  const fake: FakeMermaid = {
    initialize(config) {
      if (running > 0) overlapped = true;
      initializations.push(config);
    },
    async run({ nodes }) {
      running++;
      try {
        if (gate) await gate;
        runs.push(Array.from(nodes));
        for (const node of Array.from(nodes)) {
          drawn++;
          node.innerHTML = `<svg id="mermaid-${drawn}"><text>${node.dataset.src ?? ''}</text></svg>`;
          node.setAttribute('data-processed', 'true');
        }
      } finally {
        running--;
      }
    },
  };

  before(async () => {
    savedComputedStyle = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle');
    // jsdom keeps var() / color-mix() as written and has no cascade; answer from a table instead.
    Object.defineProperty(globalThis, 'getComputedStyle', {
      configurable: true,
      writable: true,
      value: (el: HTMLElement) => {
        const resolve = (value: string): string => {
          if (value === '') return ''; // the property this call is not about
          const known = RESOLVED[value];
          if (known === undefined) throw new Error(`unexpected expression asked of the probe: ${value}`);
          return known;
        };
        return { color: resolve(el.style.color), fontFamily: resolve(el.style.fontFamily) };
      },
    });
    head = document.head;
    const append = document.head.append.bind(document.head);
    win = window;
    (head as unknown as { append: (...nodes: (Node | string)[]) => void }).append = (...nodes) => {
      append(...nodes);
      for (const node of nodes) {
        if (node instanceof Element && node.tagName === 'SCRIPT') {
          const script = node as HTMLScriptElement;
          scripts.push(script);
          window.mermaid = fake;
          queueMicrotask(() => {
            script.onload?.(new window.Event('load'));
          });
        }
      }
    };
    mod = await import('../../webview/mermaid');
  });

  after(() => {
    delete (head as unknown as Record<string, unknown> | undefined)?.append;
    delete win?.mermaid;
    if (savedComputedStyle) Object.defineProperty(globalThis, 'getComputedStyle', savedComputedStyle);
    else delete (globalThis as Record<string, unknown>).getComputedStyle;
  });

  beforeEach(() => {
    document.body.dataset.mermaidSrc = SRC;
    initializations.length = 0;
    runs.length = 0;
    gate = undefined;
    overlapped = false;
  });

  const light = { scheme: 'light', theme: 'default', look: 'classic' } as const;
  const dark = { scheme: 'dark', theme: 'default', look: 'classic' } as const;

  function diagrams(...sources: string[]): HTMLElement {
    const root = document.createElement('div');
    root.innerHTML = sources.map((s) => `<div class="rm-mermaid"><pre class="mermaid">${s}</pre></div>`).join('');
    document.body.append(root);
    return root;
  }
  const blocks = (root: HTMLElement): HTMLElement[] => [...root.querySelectorAll<HTMLElement>('pre.mermaid')];

  describe('mermaidConfig', () => {
    it("always initializes Mermaid with securityLevel 'strict', for every theme, look and scheme", () => {
      let checked = 0;
      for (const theme of MERMAID_THEMES) {
        for (const look of MERMAID_LOOKS) {
          for (const scheme of ['light', 'dark'] as const) {
            const config = mod.mermaidConfig({ scheme, theme, look });
            assert.equal(config.securityLevel, 'strict', `${theme}/${look}/${scheme}`);
            assert.equal(config.startOnLoad, false, `${theme}/${look}/${scheme}`);
            assert.equal(config.look, look, `${theme}/${look}/${scheme}`);
            checked++;
          }
        }
      }
      assert.equal(checked, MERMAID_THEMES.length * MERMAID_LOOKS.length * 2);
    });

    it('maps a paired theme to its dark variant on a dark scheme and keeps it on a light one', () => {
      const darkVariant: Record<MermaidTheme, string | undefined> = {
        auto: undefined,
        default: 'dark',
        neo: 'neo-dark',
        redux: 'redux-dark',
        'redux-color': 'redux-dark-color',
        // Light-only themes have no dark variant and are used as they are.
        base: 'base',
        forest: 'forest',
        neutral: 'neutral',
      };
      for (const theme of MERMAID_THEMES) {
        if (theme === 'auto') continue;
        assert.equal(mod.mermaidConfig({ scheme: 'light', theme, look: 'classic' }).theme, theme, `light ${theme}`);
        assert.equal(mod.mermaidConfig({ scheme: 'dark', theme, look: 'classic' }).theme, darkVariant[theme], `dark ${theme}`);
        assert.equal('themeVariables' in mod.mermaidConfig({ scheme: 'dark', theme, look: 'classic' }), false, `${theme} has no themeVariables`);
      }
    });

    it('uses the base theme with variables taken from the preview colors for `auto`', () => {
      const config = mod.mermaidConfig({ scheme: 'light', theme: 'auto', look: 'neo' });
      assert.equal(config.theme, 'base');
      assert.equal(config.look, 'neo');
      assert.deepEqual(config.themeVariables, {
        darkMode: false,
        useGradient: false,
        dropShadow: 'drop-shadow(1px 2px 2px rgba(0, 0, 0, 0.15))',
        background: '#ffffff',
        fontFamily: 'Test Sans, sans-serif',
        primaryColor: '#010203',
        primaryTextColor: '#112233',
        primaryBorderColor: '#0066cc',
        secondaryColor: '#808080',
        secondaryTextColor: '#112233',
        secondaryBorderColor: '#cccccc',
        tertiaryColor: '#f0f0f0',
        tertiaryTextColor: '#112233',
        tertiaryBorderColor: '#cccccc',
        lineColor: '#666666',
        textColor: '#112233',
        titleColor: '#112233',
        edgeLabelBackground: '#ffffff',
        clusterBkg: '#f0f0f0',
        clusterBorder: '#cccccc',
        noteBkgColor: '#808080',
        noteTextColor: '#112233',
        noteBorderColor: '#cccccc',
      });
    });

    it('marks the `auto` variables as dark on a dark scheme (and does not map the theme name)', () => {
      const config = mod.mermaidConfig({ scheme: 'dark', theme: 'auto', look: 'classic' });
      assert.equal(config.theme, 'base');
      const vars = config.themeVariables as Record<string, unknown>;
      assert.equal(vars.darkMode, true);
      assert.equal(vars.dropShadow, 'drop-shadow(1px 2px 2px rgba(0, 0, 0, 0.6))');
      assert.equal(config.securityLevel, 'strict');
    });
  });

  describe('renderMermaid', () => {
    it('loads Mermaid once through a script tag and draws a block once', async () => {
      const root = diagrams('graph A');
      await mod.renderMermaid(root, light);
      assert.equal(scripts.length, 1);
      assert.equal(scripts[0].src, SRC);
      assert.equal(initializations.length, 1);
      assert.deepEqual(initializations[0], mod.mermaidConfig(light));
      assert.equal(runs.length, 1);
      const [block] = blocks(root);
      assert.deepEqual(runs[0], [block]);
      assert.equal(block.dataset.rmConfig, JSON.stringify(mod.mermaidConfig(light)));
      assert.ok(block.hasAttribute('data-processed'));
      assert.ok(block.querySelector('svg'));
      assert.equal(block.dataset.src, 'graph A');
    });

    it('does not redraw a block when called again with the same config', async () => {
      const root = diagrams('graph B');
      await mod.renderMermaid(root, light);
      const svg = blocks(root)[0].innerHTML;
      initializations.length = 0;
      runs.length = 0;
      await mod.renderMermaid(root, light);
      await mod.renderMermaid(root, { ...light });
      assert.equal(runs.length, 0);
      assert.equal(initializations.length, 0);
      assert.equal(blocks(root)[0].innerHTML, svg);
    });

    it('redraws when the config changes and re-initializes Mermaid with the new one', async () => {
      const root = diagrams('graph C');
      await mod.renderMermaid(root, light);
      const first = blocks(root)[0].innerHTML;
      initializations.length = 0;
      runs.length = 0;
      await mod.renderMermaid(root, dark);
      assert.equal(runs.length, 1);
      assert.deepEqual(initializations, [mod.mermaidConfig(dark)]);
      const [block] = blocks(root);
      assert.equal(block.dataset.rmConfig, JSON.stringify(mod.mermaidConfig(dark)));
      assert.notEqual(block.innerHTML, first);
      // The look is part of the config too.
      runs.length = 0;
      await mod.renderMermaid(root, { ...dark, look: 'handDrawn' });
      assert.equal(runs.length, 1);
    });

    it('serves an unchanged config + source from the SVG cache without calling Mermaid', async () => {
      const source = 'graph D';
      const root = diagrams(source);
      await mod.renderMermaid(root, light);
      const svg = blocks(root)[0].innerHTML;
      await mod.renderMermaid(root, dark); // the block now holds the dark drawing
      assert.notEqual(blocks(root)[0].innerHTML, svg);
      initializations.length = 0;
      runs.length = 0;

      // Back to the first config: the drawing comes from the cache (same markup, no draw, no initialize).
      await mod.renderMermaid(root, light);
      assert.equal(runs.length, 0);
      assert.equal(initializations.length, 0);
      const [block] = blocks(root);
      assert.equal(block.innerHTML, svg);
      assert.equal(block.dataset.rmConfig, JSON.stringify(mod.mermaidConfig(light)));
      assert.ok(block.hasAttribute('data-processed'));

      // A fresh element (as after every re-render of the document) with the same source is cached too.
      const again = diagrams(source);
      await mod.renderMermaid(again, light);
      assert.equal(runs.length, 0);
      assert.equal(blocks(again)[0].innerHTML, svg);
      assert.equal(blocks(again)[0].dataset.rmConfig, JSON.stringify(mod.mermaidConfig(light)));
    });

    it('draws only the blocks that are new or changed', async () => {
      const root = diagrams('graph E1');
      await mod.renderMermaid(root, light);
      const [old] = blocks(root);
      const extra = document.createElement('pre');
      extra.className = 'mermaid';
      extra.textContent = 'graph E2';
      root.append(extra);
      runs.length = 0;
      await mod.renderMermaid(root, light);
      assert.deepEqual(runs, [[extra]]);
      assert.ok(old.hasAttribute('data-processed'));
    });

    it('does nothing (no load, no initialize) when the root has no diagrams', async () => {
      const root = document.createElement('div');
      root.innerHTML = '<p>no diagrams</p>';
      const before = scripts.length;
      await mod.renderMermaid(root, light);
      assert.equal(scripts.length, before);
      assert.equal(initializations.length, 0);
      assert.equal(runs.length, 0);
    });

    it('never initializes while a run is in flight (calls are serialized)', async () => {
      let release!: () => void;
      gate = new Promise<void>((resolve) => (release = resolve));
      const a = diagrams('graph F1');
      const b = diagrams('graph F2');
      // Configs no earlier test used, so the first call must initialize (the last initialized key is another one).
      const one = { scheme: 'light', theme: 'forest', look: 'neo' } as const;
      const two = { scheme: 'dark', theme: 'neutral', look: 'neo' } as const;
      const first = mod.renderMermaid(a, one);
      const second = mod.renderMermaid(b, two);
      // Let the first run start (it waits on the gate), then release everything.
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(running, 1);
      assert.equal(initializations.length, 1, 'the second call has not initialized yet');
      release();
      await Promise.all([first, second]);
      assert.equal(overlapped, false);
      assert.deepEqual(initializations, [mod.mermaidConfig(one), mod.mermaidConfig(two)]);
      assert.equal(runs.length, 2);
    });
  });
});
