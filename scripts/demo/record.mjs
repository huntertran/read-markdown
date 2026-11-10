// Records the README demo GIFs by driving a real VS Code window with this extension loaded.
//
//   npm run build && node scripts/demo/record.mjs [scene ...]
//
// Scenes: outline, sync, settings, edit, changes (default: all). Output: docs/images/<scene>.gif.
// Needs ffmpeg on PATH and git (for the `changes` scene). VS Code is downloaded into .vscode-test
// like the integration tests. A VS Code window opens and is scripted; leave it alone while it runs
// (it may sit behind other windows).
//
// How it works: VS Code is started with a Chrome DevTools port and Playwright attaches to it.
// Frames come from the DevTools screencast of the workbench page (webviews included). The real
// mouse pointer is not part of the page, so a drawn cursor follows every scripted mouse move.
import { downloadAndUnzipVSCode } from '@vscode/test-electron';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT_DIR = path.join(ROOT, 'docs', 'images');
const WIDTH = 1280;
const HEIGHT = 760;
const FPS = 15;
const PORT = 9333 + Math.floor(Math.random() * 500);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------
// VS Code session

const BASE_SETTINGS = {
  'workbench.startupEditor': 'none',
  'workbench.colorTheme': 'Default Dark Modern',
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
  'workbench.editor.enablePreview': false,
  'workbench.tips.enabled': false,
  'workbench.enableExperiments': false,
  'workbench.layoutControl.enabled': false,
  'window.commandCenter': false,
  'window.newWindowDimensions': 'default',
  'chat.disableAIFeatures': true,
  'security.workspace.trust.enabled': false,
  'update.mode': 'none',
  'telemetry.telemetryLevel': 'off',
  'extensions.ignoreRecommendations': true,
  'git.openRepositoryInParentFolders': 'never',
  'editor.minimap.enabled': false,
  'editor.stickyScroll.enabled': false,
  'editor.fontSize': 13,
  'editor.lineHeight': 20,
  'breadcrumbs.enabled': false,
  'files.eol': '\n',
};

export async function launch({ settings = {}, git = false } = {}) {
  const exe = await downloadAndUnzipVSCode({ cachePath: path.join(ROOT, '.vscode-test') });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-demo-'));
  const ws = path.join(tmp, 'workspace');
  fs.mkdirSync(ws);
  const doc = fs.readFileSync(path.join(ROOT, 'test/fixtures/long-ai-doc.md'), 'utf8').replace(/\r\n/g, '\n');
  fs.writeFileSync(path.join(ws, 'plan.md'), doc);
  fs.cpSync(path.join(ROOT, 'test/fixtures/images'), path.join(ws, 'images'), { recursive: true });
  if (git) {
    const g = (...args) => execFileSync('git', args, { cwd: ws, stdio: 'ignore' });
    g('init', '-q');
    g('-c', 'user.name=demo', '-c', 'user.email=demo@example.com', 'add', '.');
    g('-c', 'user.name=demo', '-c', 'user.email=demo@example.com', 'commit', '-q', '-m', 'plan');
  }
  const userData = path.join(tmp, 'user-data');
  fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
  fs.writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify({ ...BASE_SETTINGS, ...settings }, null, 2));

  // Inside a VS Code terminal ELECTRON_RUN_AS_NODE is set, which would start Code.exe as plain Node.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('ELECTRON_') && !k.startsWith('VSCODE_')));
  const proc = spawn(
    exe,
    [
      `--remote-debugging-port=${PORT}`,
      `--extensionDevelopmentPath=${ROOT}`,
      `--user-data-dir=${userData}`,
      `--extensions-dir=${path.join(tmp, 'extensions')}`,
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-workspace-trust',
      '--disable-features=CalculateNativeWinOcclusion',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--new-window',
      ws,
    ],
    { env, stdio: 'ignore' },
  );

  let browser;
  for (let i = 0; i < 120 && !browser; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
    } catch {
      await sleep(500);
    }
  }
  if (!browser) throw new Error('Could not connect to VS Code');
  let page;
  for (let i = 0; i < 120 && !page; i++) {
    page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes('workbench.html'));
    if (!page) await sleep(500);
  }
  if (!page) throw new Error('No workbench window');
  await page.waitForSelector('.monaco-workbench .part.editor', { timeout: 60_000 });

  const cdp = await page.context().newCDPSession(page);
  // Electron has no DevTools window-bounds API, so emulate the page size instead.
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
  await page.bringToFront();
  await sleep(2500); // let extensions activate

  const session = new Session(page, cdp, ws);
  session.close = async () => {
    await browser.close().catch(() => {});
    proc.kill();
    await sleep(1000);
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
  };
  await session.installCursor();
  return session;
}

class Session {
  constructor(page, cdp, ws) {
    this.page = page;
    this.cdp = cdp;
    this.ws = ws;
    this.mx = WIDTH / 2;
    this.my = HEIGHT / 2;
  }

  // --- workbench helpers ---

  /** Runs a command palette entry; fails unless the top match is exactly `label`. */
  async command(label, { optional = false } = {}) {
    const { page } = this;
    await page.keyboard.press('F1');
    await page.waitForSelector('.quick-input-widget:not([style*="display: none"]) input');
    await page.keyboard.type(label);
    await sleep(600);
    const row = page.locator('.quick-input-list .monaco-list-row.focused .quick-input-list-label').first();
    const found = (await row.textContent({ timeout: 2000 }).catch(() => '')) ?? '';
    if (!found.replace(/\s+/g, ' ').trim().startsWith(label)) {
      await page.keyboard.press('Escape');
      if (optional) return;
      throw new Error(`Command "${label}" not found (top match: "${found}")`);
    }
    await page.keyboard.press('Enter');
    await sleep(600);
  }

  async openFile(name) {
    await this.page.keyboard.press('Control+P');
    await sleep(300);
    await this.page.keyboard.type(name);
    await sleep(600);
    await this.page.keyboard.press('Enter');
    await this.page.waitForSelector('.editor-group-container .monaco-editor .view-lines');
    await sleep(500);
  }

  /** Clean layout: no side bar, panel or notifications. */
  async tidy() {
    const visible = (sel) => this.page.locator(sel).first().isVisible().catch(() => false);
    if (await visible('.part.sidebar')) await this.command('View: Close Primary Side Bar');
    if (await visible('.part.auxiliarybar')) await this.command('View: Hide Secondary Side Bar');
    if (await visible('.part.panel')) await this.command('View: Hide Panel');
    await this.command('Notifications: Clear All Notifications', { optional: true });
    await this.command('Notifications: Enable Do Not Disturb Mode', { optional: true });
  }

  async gotoLine(line) {
    await this.page.keyboard.press('Control+G');
    await sleep(200);
    await this.page.keyboard.type(String(line));
    await this.page.keyboard.press('Enter');
    await sleep(300);
  }

  /** The preview webview's content frame. */
  async preview() {
    for (let i = 0; i < 60; i++) {
      for (const f of this.page.frames()) {
        if (!f.url().includes('fake.html')) continue;
        if ((await f.locator('#rm-content > *').count().catch(() => 0)) > 0) return f;
      }
      await sleep(250);
    }
    throw new Error('Preview not found');
  }

  async box(locator) {
    await locator.waitFor({ state: 'visible' });
    const b = await locator.boundingBox();
    if (!b) throw new Error(`No box for ${locator}`);
    return b;
  }

  /** Viewport rect of the `nth` occurrence of `text` on the visible lines of the text editor. */
  async editorText(text, nth = 0) {
    const rect = await this.page.evaluate(
      ([text, nth]) => {
        const lines = [...document.querySelectorAll('.editor-group-container .monaco-editor .view-lines .view-line')];
        lines.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
        let seen = 0;
        for (const line of lines) {
          const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
          // Monaco renders spaces as NBSP.
          const nodes = [];
          let all = '';
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            nodes.push([n, all.length]);
            all += n.data.replace(/ /g, ' ');
          }
          let from = 0;
          for (let i = all.indexOf(text, from); i >= 0; i = all.indexOf(text, from)) {
            if (seen++ === nth) {
              const range = document.createRange();
              const at = (pos) => {
                const [node, start] = nodes.filter(([, s]) => s <= pos).pop();
                return [node, pos - start];
              };
              range.setStart(...at(i));
              range.setEnd(...at(i + text.length - 1));
              const r = range.getBoundingClientRect();
              const charW = r.width / Math.max(1, text.length - 1);
              return { x: r.x, y: r.y, width: r.width + charW, height: r.height };
            }
            from = i + 1;
          }
        }
        return null;
      },
      [text, nth],
    );
    if (!rect) throw new Error(`"${text}" not visible in the editor`);
    return rect;
  }

  /** Selects the `nth` visible occurrence of `text` in the text editor: click, then shift+click. */
  async selectEditorText(text, nth = 0) {
    const r = await this.editorText(text, nth);
    const y = r.y + r.height / 2;
    await this.click({ x: r.x + 1, y, width: 0, height: 0 });
    await this.move(r.x + r.width - 1, y, 350);
    await this.page.keyboard.down('Shift');
    await this.click();
    await this.page.keyboard.up('Shift');
  }

  // --- drawn cursor ---

  async installCursor() {
    await this.page.evaluate(([x, y]) => {
      const ns = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(ns, 'svg');
      svg.id = 'demo-cursor';
      svg.setAttribute('width', '22');
      svg.setAttribute('height', '28');
      svg.setAttribute('viewBox', '0 0 22 28');
      const p = document.createElementNS(ns, 'path');
      p.setAttribute('d', 'M2 2 L2 22 L7 17.5 L10.5 25.5 L14 24 L10.6 16.2 L17 16.2 Z');
      p.setAttribute('fill', '#ffffff');
      p.setAttribute('stroke', '#000000');
      p.setAttribute('stroke-width', '1.4');
      p.setAttribute('stroke-linejoin', 'round');
      svg.append(p);
      Object.assign(svg.style, {
        position: 'fixed', left: '0', top: '0', zIndex: '2147483647', pointerEvents: 'none',
        transform: `translate(${x - 2}px, ${y - 2}px)`, filter: 'drop-shadow(0 1px 1.5px rgba(0,0,0,.5))',
      });
      document.body.append(svg);
    }, [this.mx, this.my]);
  }

  async setCursor(x, y) {
    await this.page.evaluate(([x, y]) => {
      const c = document.getElementById('demo-cursor');
      if (c) c.style.transform = `translate(${x - 2}px, ${y - 2}px)`;
    }, [x, y]);
  }

  async ripple(x, y) {
    await this.page.evaluate(([x, y]) => {
      const r = document.createElement('div');
      Object.assign(r.style, {
        position: 'fixed', left: `${x - 14}px`, top: `${y - 14}px`, width: '28px', height: '28px',
        borderRadius: '50%', border: '2px solid #ffcc33', zIndex: '2147483646', pointerEvents: 'none',
      });
      document.body.append(r);
      r.animate([{ transform: 'scale(.3)', opacity: 1 }, { transform: 'scale(1.2)', opacity: 0 }], { duration: 450, easing: 'ease-out' }).onfinish = () => r.remove();
    }, [x, y]);
  }

  async move(x, y, ms = 450) {
    const steps = Math.max(1, Math.round(ms / 16));
    const [x0, y0] = [this.mx, this.my];
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      const px = x0 + (x - x0) * e;
      const py = y0 + (y - y0) * e;
      await Promise.all([this.page.mouse.move(px, py), this.setCursor(px, py)]);
    }
    this.mx = x;
    this.my = y;
  }

  async moveTo(target, { dx = 0.5, dy = 0.5, ms } = {}) {
    const b = typeof target.boundingBox === 'function' ? await this.box(target) : target;
    await this.move(b.x + b.width * dx, b.y + b.height * dy, ms);
  }

  async click(target, opts = {}) {
    if (target) await this.moveTo(target, opts);
    await sleep(120);
    await this.ripple(this.mx, this.my);
    await this.page.mouse.click(this.mx, this.my, { clickCount: opts.clickCount ?? 1 });
  }

  async drag(target, dx, dy, ms = 900) {
    if (target) await this.moveTo(target);
    await sleep(150);
    await this.page.mouse.down();
    await this.move(this.mx + dx, this.my + dy, ms);
    await sleep(250);
    await this.page.mouse.up();
  }

  async wheel(dy, steps = 10, ms = 600) {
    for (let i = 0; i < steps; i++) {
      await this.page.mouse.wheel(0, dy / steps);
      await sleep(ms / steps);
    }
  }

  async type(text, delay = 55) {
    await this.page.keyboard.type(text, { delay });
  }

  // --- recording ---

  async record(name, scene) {
    const frames = [];
    const onFrame = async ({ data, sessionId }) => {
      frames.push({ data, t: Date.now() });
      await this.cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    };
    this.cdp.on('Page.screencastFrame', onFrame);
    await this.cdp.send('Page.startScreencast', { format: 'png', maxWidth: WIDTH, maxHeight: HEIGHT, everyNthFrame: 1 });
    await this.setCursor(this.mx + 0.01, this.my); // force a first frame
    await sleep(800);
    await scene();
    await sleep(1200);
    await this.cdp.send('Page.stopScreencast');
    this.cdp.off('Page.screencastFrame', onFrame);
    await writeGif(name, frames);
  }
}

async function writeGif(name, frames) {
  if (frames.length < 2) throw new Error(`${name}: no frames captured`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rm-frames-${name}-`));
  const lines = ['ffconcat version 1.0'];
  frames.forEach((f, i) => {
    const file = `f${String(i).padStart(5, '0')}.png`;
    fs.writeFileSync(path.join(dir, file), Buffer.from(f.data, 'base64'));
    const next = frames[i + 1]?.t ?? f.t + 2500; // hold the last frame before the loop restarts
    lines.push(`file ${file}`, `duration ${((next - f.t) / 1000).toFixed(3)}`);
  });
  lines.push(`file f${String(frames.length - 1).padStart(5, '0')}.png`);
  fs.writeFileSync(path.join(dir, 'frames.txt'), lines.join('\n'));
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, `${name}.gif`);
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(dir, 'frames.txt'),
    '-vf', `fps=${FPS},split[a][b];[a]palettegen=max_colors=192:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
    '-loop', '0', out,
  ]);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`${path.relative(ROOT, out)}  ${(fs.statSync(out).size / 1024 / 1024).toFixed(2)} MB, ${frames.length} frames`);
}

// ---------------------------------------------------------------------------------------------
// Scenes

const SCENES = {
  /** Outline: jump to a heading, filter, fold sections. */
  async outline() {
    const s = await launch();
    try {
      await s.openFile('plan.md');
      await s.tidy();
      await s.command('Read Markdown: Open Preview');
      const v = await s.preview();
      await sleep(1500);
      const nav = (text) => v.locator('#rm-nav-list a', { hasText: text }).first();
      await s.record('outline', async () => {
        await s.click(nav('Migration'));
        await sleep(1400);
        await s.click(nav('Hot paths'));
        await sleep(1400);
        await s.click(v.locator('#rm-nav-filter'));
        await s.type('refund');
        await sleep(900);
        await s.click(nav('Extract RefundService'));
        await sleep(1400);
        await s.click(v.locator('#rm-nav-filter'));
        await s.page.keyboard.press('Control+A');
        await s.page.keyboard.press('Backspace');
        await sleep(600);
        await s.click(nav('Proposed Changes'));
        await sleep(1200);
        await s.click(v.locator('#proposed-changes .rm-fold, #proposed-changes ~ .rm-fold').first());
        await sleep(1200);
        await s.click(v.locator('#proposed-changes .rm-fold'));
        await sleep(1000);
        // Collapse all, then open the top section (its subsections stay folded) and one of them.
        await s.click(v.locator('#rm-fold-all'));
        await sleep(1300);
        await s.click(v.locator('#rm-content h1 .rm-fold').first());
        await sleep(1600);
        await s.click(v.locator('#migration .rm-fold'));
        await sleep(1600);
      });
    } finally {
      await s.close();
    }
  },

  /** Source → preview: scroll sync and selection highlight. */
  async sync() {
    const s = await launch({ settings: { 'readMarkdown.nav.show': false } });
    try {
      await s.openFile('plan.md');
      await s.tidy();
      await s.command('Read Markdown: Open Preview to the Side');
      await s.preview();
      await s.command('View: Focus First Editor Group');
      await sleep(1500);
      const editor = s.page.locator('.editor-group-container').first().locator('.monaco-editor .editor-scrollable');
      await s.record('sync', async () => {
        await s.moveTo(editor, { dx: 0.5, dy: 0.4 });
        await s.wheel(900, 18, 1600);
        await sleep(900);
        await s.wheel(700, 14, 1200);
        await sleep(900);
        const word = await s.editorText('refund flow');
        await s.click({ ...word, width: word.width * (6 / 11) }, { clickCount: 2 });
        await sleep(2200);
        await s.page.keyboard.press('Control+F');
        await sleep(300);
        await s.type('idempotency', 70);
        await sleep(500);
        for (let i = 0; i < 3; i++) {
          await s.page.keyboard.press('Enter');
          await sleep(1300);
        }
        await s.page.keyboard.press('Escape');
        await sleep(500);
      });
    } finally {
      await s.close();
    }
  },

  /** Quick settings panel. */
  async settings() {
    const s = await launch();
    try {
      await s.openFile('plan.md');
      await s.tidy();
      await s.command('Read Markdown: Open Preview');
      const v = await s.preview();
      await sleep(1500);
      const row = (label) => v.locator('.rm-settings-row', { has: v.locator('.rm-settings-label', { hasText: label }) }).first();
      await s.record('settings', async () => {
        await s.click(v.locator('#rm-open-settings'));
        await sleep(700);
        for (const preset of ['sepia', 'light']) {
          await s.moveTo(row('Theme').locator('select'));
          await sleep(300);
          await row('Theme').locator('select').selectOption(preset);
          await sleep(1300);
        }
        const slider = async (label, from, to) => {
          const b = await s.box(row(label).locator('input[type=range]'));
          await s.move(b.x + b.width * from, b.y + b.height / 2);
          await s.drag(null, b.width * (to - from), 0, 900);
          await sleep(1100);
        };
        await slider('Font size', 5 / 18, 8 / 18);
        await slider('Line height', 0.375, 0.6);
        await s.moveTo(row('Heading style').locator('select'));
        await sleep(300);
        await row('Heading style').locator('select').selectOption('leftBorder');
        await sleep(1300);
        await s.click(v.locator('#rm-content h1').first(), { dx: 0.1 });
        await sleep(1200);
      });
    } finally {
      await s.close();
    }
  },

  /** Edit a block, tick a task, reorder a list item. */
  async edit() {
    const s = await launch({ settings: { 'readMarkdown.nav.show': false, 'readMarkdown.edit.enabled': true } });
    try {
      await s.openFile('plan.md');
      await s.tidy();
      // Scroll the editor so "## Context" is the top line; the preview opens synced to it.
      await s.gotoLine(22);
      for (let i = 0; i < 17; i++) await s.page.keyboard.press('Control+ArrowDown');
      await s.command('Read Markdown: Open Preview to the Side');
      const v = await s.preview();
      await sleep(2000);
      const para = v.locator('#context').locator('xpath=following::p[1]');
      const tasks = v.locator('#context').locator('xpath=following::ul[1]');
      await s.record('edit', async () => {
        await s.moveTo(para, { dx: 0.4, dy: 0.3 });
        await sleep(700);
        await s.click(v.locator('.rm-block-rail .rm-block-action').first());
        await sleep(800);
        await s.page.keyboard.press('Control+End');
        await s.type(' Webhooks follow once refunds are stable.');
        await sleep(500);
        await s.page.keyboard.press('Control+Enter');
        await sleep(1600);
        await s.click(tasks.locator('li', { hasText: 'Extract RefundService' }).locator('input[type=checkbox]'));
        await sleep(1400);
        const item = tasks.locator('li', { hasText: 'Remove the legacy retry loop' });
        await s.moveTo(item, { dx: 0.2 });
        await sleep(500);
        const first = await s.box(tasks.locator('li').first());
        const grip = await s.box(v.locator('.rm-item-grip'));
        await s.moveTo(grip, { ms: 300 });
        await s.drag(null, 0, first.y + first.height * 0.3 - (grip.y + grip.height / 2), 1300);
        await sleep(1800);
      });
    } finally {
      await s.close();
    }
  },

  /** Track changes against the git index. */
  async changes() {
    const s = await launch({ git: true, settings: { 'readMarkdown.nav.show': false } });
    try {
      await s.openFile('plan.md');
      await s.tidy();
      await s.gotoLine(24);
      await s.command('Read Markdown: Open Preview to the Side');
      const v = await s.preview();
      await sleep(1000);
      await s.command('View: Focus First Editor Group');
      await s.gotoLine(26);
      await sleep(1500);
      await s.record('changes', async () => {
        // Reword.
        await s.selectEditorText('smaller units');
        await sleep(300);
        await s.type('focused services', 70);
        await sleep(1600);
        // Move a task up two lines.
        const task = await s.editorText('Remove the legacy');
        await s.click(task, { dx: 0.9 });
        await sleep(300);
        for (let i = 0; i < 3; i++) {
          await s.page.keyboard.press('Alt+ArrowUp');
          await sleep(350);
        }
        await sleep(1500);
        // Delete a line, add a new one.
        const goal = await s.editorText('Map every caller');
        await s.click(goal, { dx: 0.9 });
        await sleep(300);
        await s.page.keyboard.press('Control+Shift+K');
        await sleep(1300);
        await s.page.keyboard.press('End');
        await s.page.keyboard.press('Enter');
        await s.type('- [ ] Add refund metrics', 50);
        await sleep(1600);
        // Bars only, then back to inline.
        await s.click(v.locator('#rm-toggle-changes'));
        await sleep(1800);
        await s.click(v.locator('#rm-toggle-changes'));
        await sleep(1200);
      });
    } finally {
      await s.close();
    }
  },
};

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const names = process.argv.slice(2);
  for (const name of names.length ? names : Object.keys(SCENES)) {
    if (!SCENES[name]) throw new Error(`Unknown scene "${name}". Scenes: ${Object.keys(SCENES).join(', ')}`);
    console.log(`Recording ${name}…`);
    await SCENES[name]();
  }
}
