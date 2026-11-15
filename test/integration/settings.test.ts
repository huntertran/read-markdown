import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { type Settings, SECTION, getSettings, updateSetting } from '../../src/config/settings';
import { DEFAULTS, ENUM_SETTINGS, NUMBER_SETTINGS } from '../../src/config/values';
import type { PreviewManager } from '../../src/preview/previewManager';
import type { PreviewPanel } from '../../src/preview/previewPanel';
import type { ToWebview } from '../../src/protocol';

const EXTENSION_ID = 'huntertran.read-markdown';

type SettingKey = keyof typeof DEFAULTS;
const KEYS = Object.keys(DEFAULTS) as SettingKey[];

let manager: PreviewManager;

function workspaceFolder(): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'fixture workspace must be open');
  return folder.uri;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(check: () => boolean, what: string, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

const config = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration(SECTION);
const inspect = (key: string): ReturnType<vscode.WorkspaceConfiguration['inspect']> => config().inspect<unknown>(key);

interface Stored {
  global: unknown;
  workspace: unknown;
}

/** Writes `value` (undefined removes the entry) to one scope, one key at a time like a user would. */
async function write(key: string, value: unknown, target: vscode.ConfigurationTarget): Promise<void> {
  await config().update(key, value, target);
}

async function writeAll(entries: ReadonlyArray<readonly [string, unknown]>): Promise<void> {
  for (const [key, value] of entries) await write(key, value, vscode.ConfigurationTarget.Global);
}

/**
 * One value per setting that is valid and not the default, and the `Settings` field it must land in. A typo in
 * a key read by `getSettings` (or two keys swapped) fails the per-key test of exactly that key. `Record` over
 * `DEFAULTS` makes a new setting without a row here a type error.
 */
const CASES: Record<SettingKey, { field: keyof Settings; value: unknown }> = {
  'preview.autoOpen': { field: 'autoOpen', value: 'beside' },
  'preview.scrollSync': { field: 'scrollSync', value: false },
  'nav.show': { field: 'navShow', value: false },
  'nav.position': { field: 'navPosition', value: 'right' },
  'nav.maxDepth': { field: 'navMaxDepth', value: 5 },
  'nav.width': { field: 'navWidth', value: 300 },
  'theme.preset': { field: 'preset', value: 'sepia' },
  'body.fontFamily': { field: 'bodyFontFamily', value: 'Georgia, serif' },
  'body.fontSize': { field: 'bodyFontSize', value: 18 },
  'body.lineHeight': { field: 'bodyLineHeight', value: 2 },
  'body.maxWidth': { field: 'bodyMaxWidth', value: 1000 },
  'body.fullWidth': { field: 'bodyFullWidth', value: true },
  'body.backgroundColor': { field: 'bodyBackgroundColor', value: '#101010' },
  'body.textColor': { field: 'bodyTextColor', value: '#fafafa' },
  'headings.fontFamily': { field: 'headingFontFamily', value: 'Arial' },
  'headings.scale': { field: 'headingScale', value: 1.5 },
  'headings.fontSizes': { field: 'headingFontSizes', value: { h1: '2em' } },
  'headings.colors': { field: 'headingColors', value: { h2: '#ff0000' } },
  'headings.highlight': { field: 'headingHighlight', value: 'background' },
  'headings.highlightColor': { field: 'headingHighlightColor', value: '#00ff00' },
  'customCss.inline': { field: 'customCssInline', value: 'p { color: red; }' },
  'customCss.files': { field: 'customCssFiles', value: ['missing-settings-test.css'] },
  'search.syncSelection': { field: 'searchSyncSelection', value: false },
  'search.caseSensitive': { field: 'searchCaseSensitive', value: true },
  'search.minLength': { field: 'searchMinLength', value: 4 },
  'search.highlightColor': { field: 'searchHighlightColor', value: '#111111' },
  'search.currentHighlightColor': { field: 'searchCurrentHighlightColor', value: '#222222' },
  'table.headerBackgroundColor': { field: 'tableHeaderBackgroundColor', value: '#333333' },
  'table.headerTextColor': { field: 'tableHeaderTextColor', value: '#444444' },
  'code.copyButton': { field: 'copyButton', value: false },
  'mermaid.enabled': { field: 'mermaid', value: false },
  'mermaid.theme': { field: 'mermaidTheme', value: 'forest' },
  'mermaid.look': { field: 'mermaidLook', value: 'handDrawn' },
  'sections.collapsible': { field: 'collapsible', value: false },
  'sections.startCollapsedBelowLevel': { field: 'startCollapsedBelowLevel', value: 2 },
  'edit.enabled': { field: 'editEnabled', value: true },
  'edit.doubleClick': { field: 'editDoubleClick', value: true },
  'edit.saveOnCommit': { field: 'editSaveOnCommit', value: true },
  'changes.mode': { field: 'changesMode', value: 'gutter' },
  'tasks.agentProgress': { field: 'agentProgress', value: false },
  'tasks.progress': { field: 'taskProgress', value: false },
  'security.allowRemoteContent': { field: 'allowRemoteContent', value: false },
};

/** What `getSettings()` returns when nothing is configured: every field at its default. */
function defaultSettings(overrides: Partial<Record<SettingKey, unknown>> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of KEYS) out[CASES[key].field] = key in overrides ? overrides[key] : DEFAULTS[key];
  return out;
}

const isEnumKey = (key: SettingKey): key is SettingKey & keyof typeof ENUM_SETTINGS => Object.hasOwn(ENUM_SETTINGS, key);
const isNumberKey = (key: SettingKey): key is SettingKey & keyof typeof NUMBER_SETTINGS => Object.hasOwn(NUMBER_SETTINGS, key);

/** A value of the wrong type for `key` that is falsy where the default is true and truthy where it is false. */
function wrongTypeFor(key: SettingKey): unknown {
  const fallback: unknown = DEFAULTS[key];
  if (typeof fallback === 'boolean') return fallback ? 0 : 1;
  if (isEnumKey(key)) return 42;
  if (isNumberKey(key)) return '5';
  if (typeof fallback === 'string') return 123;
  return 'not-an-object-or-array';
}

describe('Settings wiring', () => {
  const saved = new Map<SettingKey, Stored>();
  let settingsDir = '';
  let settingsDirExisted = false;

  /** Removes every readMarkdown value at the user and workspace scope (only the ones that are set). */
  async function resetAll(): Promise<void> {
    for (const key of KEYS) {
      const info = inspect(key);
      if (info?.globalValue !== undefined) await write(key, undefined, vscode.ConfigurationTarget.Global);
      if (info?.workspaceValue !== undefined) await write(key, undefined, vscode.ConfigurationTarget.Workspace);
    }
  }

  before(async () => {
    const ext = vscode.extensions.getExtension<{ manager: PreviewManager }>(EXTENSION_ID);
    assert.ok(ext, 'extension should be installed');
    manager = (await ext.activate()).manager;
    settingsDir = path.join(workspaceFolder().fsPath, '.vscode');
    settingsDirExisted = fs.existsSync(settingsDir);
    for (const key of KEYS) {
      const info = inspect(key);
      saved.set(key, { global: info?.globalValue, workspace: info?.workspaceValue });
    }
  });

  beforeEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await resetAll();
  });

  afterEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  after(async () => {
    await resetAll();
    for (const [key, { global, workspace }] of saved) {
      if (global !== undefined) await write(key, global, vscode.ConfigurationTarget.Global);
      if (workspace !== undefined) await write(key, workspace, vscode.ConfigurationTarget.Workspace);
    }
    // Writing the workspace scope creates .vscode/settings.json (an empty `{}` once every key is removed again).
    if (!settingsDirExisted) fs.rmSync(settingsDir, { recursive: true, force: true, maxRetries: 5 });
  });

  describe('key to field mapping', () => {
    it('has a case for every default and getSettings() returns the defaults when nothing is configured', () => {
      assert.deepEqual(Object.keys(CASES).sort(), [...KEYS].sort());
      assert.equal(new Set(KEYS.map((k) => CASES[k].field)).size, KEYS.length, 'every field is read from exactly one key');
      assert.deepEqual(getSettings(), defaultSettings());
    });

    it('registers every key in package.json with the default values.ts declares', () => {
      // `getSettings` falls back to DEFAULTS for an unknown key, so only the live registration proves the key exists.
      for (const key of KEYS) {
        const info = inspect(key);
        assert.ok(info, `${key} is not registered`);
        assert.deepEqual(info.defaultValue, DEFAULTS[key], `${key}: package.json default differs from values.ts`);
      }
    });

    for (const key of KEYS) {
      const { field, value } = CASES[key];
      it(`${key} changes only Settings.${field}`, async () => {
        await write(key, value, vscode.ConfigurationTarget.Global);
        assert.deepEqual(getSettings(), defaultSettings({ [key]: value }));
      });
    }

    it('reads every key at once into distinct fields', async () => {
      await writeAll(KEYS.map((key) => [key, CASES[key].value] as const));
      const expected: Partial<Record<SettingKey, unknown>> = {};
      for (const key of KEYS) expected[key] = CASES[key].value;
      assert.deepEqual(getSettings(), defaultSettings(expected));
    });
  });

  describe('invalid values', () => {
    it('falls back to the default for a value of the wrong type or an unknown enum member', async () => {
      await writeAll(KEYS.map((key) => [key, isEnumKey(key) ? 'not-a-member' : wrongTypeFor(key)] as const));
      assert.deepEqual(getSettings(), defaultSettings());
      // An enum must also reject a non-string, not only an unknown string.
      await writeAll(KEYS.filter(isEnumKey).map((key) => [key, 42] as const));
      assert.deepEqual(getSettings(), defaultSettings());
    });

    it('clamps an out-of-range number to its bounds', async () => {
      const numberKeys = KEYS.filter(isNumberKey);
      await writeAll(numberKeys.map((key) => [key, NUMBER_SETTINGS[key].max + 1000] as const));
      assert.deepEqual(
        getSettings(),
        defaultSettings(Object.fromEntries(numberKeys.map((key) => [key, NUMBER_SETTINGS[key].max]))),
      );
      await writeAll(numberKeys.map((key) => [key, NUMBER_SETTINGS[key].min - 1000] as const));
      assert.deepEqual(
        getSettings(),
        defaultSettings(Object.fromEntries(numberKeys.map((key) => [key, NUMBER_SETTINGS[key].min]))),
      );
      // The documented bounds themselves, not only the table the code shares with this test.
      await write('nav.maxDepth', 99, vscode.ConfigurationTarget.Global);
      await write('body.fontSize', 2, vscode.ConfigurationTarget.Global);
      const s = getSettings();
      assert.equal(s.navMaxDepth, 6);
      assert.equal(s.bodyFontSize, 8);
    });

    it('rounds a fractional number only where whole numbers are required', async () => {
      await writeAll([
        ['nav.maxDepth', 2.6],
        ['nav.width', 300.4],
        ['body.fontSize', 12.5],
      ]);
      const s = getSettings();
      assert.equal(s.navMaxDepth, 3);
      assert.equal(s.navWidth, 300);
      assert.equal(s.bodyFontSize, 12.5);
    });

    it('keeps only the valid entries of the structured settings', async () => {
      await writeAll([
        ['headings.fontSizes', { h1: 5, h2: '2em', h7: '1em', other: 'x' }],
        ['headings.colors', { h3: '#abcdef', h4: null }],
        ['customCss.files', [1, 'a.css', null, 'b.css']],
      ]);
      const s = getSettings();
      assert.deepEqual(s.headingFontSizes, { h2: '2em' });
      assert.deepEqual(s.headingColors, { h3: '#abcdef' });
      assert.deepEqual(s.customCssFiles, ['a.css', 'b.css']);
    });
  });

  describe('updateSetting write scope', () => {
    const KEY = 'body.fontSize';

    it('writes to the user settings when no other scope defines the key', async () => {
      await updateSetting(KEY, 20);
      const info = inspect(KEY);
      assert.equal(info?.globalValue, 20);
      assert.equal(info?.workspaceValue, undefined);
      assert.equal(info?.workspaceFolderValue, undefined);
      assert.equal(getSettings().bodyFontSize, 20);
    });

    it('writes to the workspace value when it is defined and leaves the user value alone', async () => {
      await write(KEY, 18, vscode.ConfigurationTarget.Global);
      await write(KEY, 19, vscode.ConfigurationTarget.Workspace);
      assert.equal(getSettings().bodyFontSize, 19, 'precondition: the workspace wins');

      await updateSetting(KEY, 21);
      const info = inspect(KEY);
      assert.equal(info?.workspaceValue, 21);
      assert.equal(info?.globalValue, 18);
      assert.equal(getSettings().bodyFontSize, 21);
    });

    it('chooses the scope per key', async () => {
      await write(KEY, 19, vscode.ConfigurationTarget.Workspace);
      await updateSetting('body.lineHeight', 2);
      const other = inspect('body.lineHeight');
      assert.equal(other?.globalValue, 2);
      assert.equal(other?.workspaceValue, undefined);
      assert.equal(inspect(KEY)?.workspaceValue, 19, 'the other key stays untouched');
    });

    it('never needs the workspace-folder branch: no setting is folder-scoped', () => {
      // `updateSetting` and `getSettings()` inspect without a resource, so a folder-scoped value would be invisible
      // to them (and the WorkspaceFolder branch is unreachable: VS Code refuses folder writes for window-scoped
      // settings, and `inspect()` without a resource never reports `workspaceFolderValue`). That is only correct
      // while no readMarkdown setting declares the `resource` (or `language-overridable`) scope.
      const ext = vscode.extensions.getExtension(EXTENSION_ID);
      const configuration = (ext?.packageJSON as { contributes?: { configuration?: unknown } } | undefined)?.contributes?.configuration;
      const blocks = Array.isArray(configuration) ? configuration : [configuration];
      let properties = 0;
      for (const block of blocks as Array<{ properties?: Record<string, { scope?: string }> } | undefined>) {
        for (const [key, def] of Object.entries(block?.properties ?? {})) {
          properties++;
          assert.ok(
            def.scope === undefined || def.scope === 'window' || def.scope === 'application',
            `${key} has scope "${def.scope}": updateSetting/getSettings() would not see a folder-level value`,
          );
        }
      }
      assert.ok(properties >= KEYS.length, 'the contributed settings were found');
      assert.equal(inspect(KEY)?.workspaceFolderValue, undefined);
    });

    it('writes false and 0, only "" means remove', async () => {
      await updateSetting('nav.show', false);
      await updateSetting('body.maxWidth', 0);
      assert.equal(inspect('nav.show')?.globalValue, false);
      assert.equal(inspect('body.maxWidth')?.globalValue, 0);
      assert.equal(getSettings().navShow, false);
      assert.equal(getSettings().bodyMaxWidth, 0);
    });

    it('removes the key from the user settings for ""', async () => {
      await write('nav.width', 320, vscode.ConfigurationTarget.Global);
      await write('table.headerBackgroundColor', '#112233', vscode.ConfigurationTarget.Global);

      await updateSetting('nav.width', '');
      await updateSetting('table.headerBackgroundColor', '');

      for (const key of ['nav.width', 'table.headerBackgroundColor']) {
        const info = inspect(key);
        assert.equal(info?.globalValue, undefined, `${key} removed (not written as an empty string)`);
        assert.notEqual(info?.globalValue, '');
      }
      assert.equal(getSettings().navWidth, DEFAULTS['nav.width']);
      assert.equal(getSettings().tableHeaderBackgroundColor, '');
    });

    it('removes the workspace value for "" and keeps the user value', async () => {
      await write(KEY, 18, vscode.ConfigurationTarget.Global);
      await write(KEY, 19, vscode.ConfigurationTarget.Workspace);

      await updateSetting(KEY, '');

      const info = inspect(KEY);
      assert.equal(info?.workspaceValue, undefined);
      assert.equal(info?.globalValue, 18);
      assert.equal(getSettings().bodyFontSize, 18);
    });

    it('is a no-op for "" when the key is not set anywhere', async () => {
      await updateSetting(KEY, '');
      const info = inspect(KEY);
      assert.equal(info?.globalValue, undefined);
      assert.equal(info?.workspaceValue, undefined);
      assert.equal(getSettings().bodyFontSize, DEFAULTS[KEY]);
    });
  });

  describe('PreviewManager.updateQuickSetting', () => {
    let changes = 0;
    let listener: vscode.Disposable;

    beforeEach(() => {
      changes = 0;
      listener = vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(SECTION)) changes++;
      });
    });

    afterEach(() => {
      listener.dispose();
    });

    /** Nothing was written to any scope for these keys and no configuration change fired. */
    async function assertNothingWritten(keys: readonly string[]): Promise<void> {
      await sleep(150);
      assert.equal(changes, 0, 'no configuration change event');
      for (const key of keys) {
        const info = inspect(key);
        assert.equal(info?.globalValue, undefined, `${key} (user)`);
        assert.equal(info?.workspaceValue, undefined, `${key} (workspace)`);
        assert.equal(info?.workspaceFolderValue, undefined, `${key} (folder)`);
      }
      // An earlier test may have left an empty `{}` file behind; it must not hold a readMarkdown value.
      const file = path.join(settingsDir, 'settings.json');
      if (fs.existsSync(file)) assert.ok(!fs.readFileSync(file, 'utf8').includes(SECTION), 'no readMarkdown value in the workspace file');
    }

    it('ignores an invalid value of a quick setting', async () => {
      const invalid: ReadonlyArray<readonly [string, unknown]> = [
        ['nav.maxDepth', 99],
        ['nav.maxDepth', '3'],
        ['nav.maxDepth', 2.5],
        ['nav.show', 'yes'],
        ['nav.show', 1],
        ['theme.preset', 'neon'],
        ['theme.preset', 5],
        ['body.fontSize', Number.NaN],
        ['body.fontSize', Number.POSITIVE_INFINITY],
        ['table.headerBackgroundColor', 'red'],
        ['table.headerTextColor', '#abc'],
        ['changes.mode', 'sideways'],
      ];
      for (const [key, value] of invalid) await manager.updateQuickSetting(key, value);
      await assertNothingWritten(invalid.map(([key]) => key));
    });

    it('ignores an unknown key and a real setting that is not a quick setting', async () => {
      const ignored: ReadonlyArray<readonly [string, unknown]> = [
        ['nav.bogus', true],
        ['readMarkdown.nav.show', false],
        ['__proto__', 1],
        ['constructor', 1],
        ['body.fontFamily', 'Comic Sans MS'],
        ['security.allowRemoteContent', false],
        ['customCss.inline', 'p { color: red; }'],
        ['edit.saveOnCommit', true],
      ];
      for (const [key, value] of ignored) await manager.updateQuickSetting(key, value);
      await assertNothingWritten(ignored.map(([key]) => key));
    });

    it('writes a valid value', async () => {
      await manager.updateQuickSetting('nav.maxDepth', 5);
      await manager.updateQuickSetting('theme.preset', 'sepia');
      await manager.updateQuickSetting('nav.show', false);
      await manager.updateQuickSetting('table.headerBackgroundColor', '#AABBCC');
      assert.equal(inspect('nav.maxDepth')?.globalValue, 5);
      assert.equal(inspect('theme.preset')?.globalValue, 'sepia');
      assert.equal(inspect('nav.show')?.globalValue, false);
      assert.equal(inspect('table.headerBackgroundColor')?.globalValue, '#AABBCC');
      assert.ok(changes > 0, 'a configuration change event fired');
      const s = getSettings();
      assert.equal(s.navMaxDepth, 5);
      assert.equal(s.preset, 'sepia');
      assert.equal(s.navShow, false);
      assert.equal(s.tableHeaderBackgroundColor, '#AABBCC');
    });

    it('resets nav.width and a color with "" and keeps the scope that defines the key', async () => {
      await write('nav.width', 300, vscode.ConfigurationTarget.Workspace);
      await write('table.headerTextColor', '#123456', vscode.ConfigurationTarget.Global);

      await manager.updateQuickSetting('nav.width', '');
      await manager.updateQuickSetting('table.headerTextColor', '');

      assert.equal(inspect('nav.width')?.workspaceValue, undefined);
      assert.equal(inspect('table.headerTextColor')?.globalValue, undefined);
      assert.equal(getSettings().navWidth, DEFAULTS['nav.width']);
    });

    it('rejects "" for a quick setting that does not take it', async () => {
      await write('nav.maxDepth', 4, vscode.ConfigurationTarget.Global);
      await manager.updateQuickSetting('nav.maxDepth', '');
      assert.equal(inspect('nav.maxDepth')?.globalValue, 4);
    });
  });

  describe('reaction to a configuration change on an open preview', () => {
    /** Messages the extension posts to the webview, recorded by wrapping `postMessage` on the live webview. */
    function record(preview: PreviewPanel): ToWebview[] {
      const webview = preview.panel.webview;
      const original = webview.postMessage.bind(webview);
      const log: ToWebview[] = [];
      webview.postMessage = (message: unknown) => {
        log.push(message as ToWebview);
        return original(message);
      };
      return log;
    }

    const ofType = <T extends ToWebview['type']>(log: readonly ToWebview[], type: T): Extract<ToWebview, { type: T }>[] =>
      log.filter((m): m is Extract<ToWebview, { type: T }> => m.type === type);

    /**
     * Records the messages, then reloads the page so a `ready` that arrives after the wrapper is installed is
     * certain; waits until the webview has its config and render and the host has been quiet for a moment.
     */
    async function openRecorded(
      uri: vscode.Uri,
      column: vscode.ViewColumn,
      preserveFocus: boolean,
    ): Promise<{ preview: PreviewPanel; log: ToWebview[] }> {
      const preview = await manager.open(uri, column, preserveFocus);
      const log = record(preview);
      preview.reloadWebview();
      await waitFor(() => ofType(log, 'config').length > 0 && ofType(log, 'render').length > 0, 'the webview to be ready');
      let count = -1;
      while (count !== log.length) {
        count = log.length;
        await sleep(400);
      }
      return { preview, log };
    }

    /** Waits for the host to answer a change; `grace` lets a message that would follow it arrive too. */
    async function settleAfter(log: ToWebview[], what: string, grace = 600): Promise<void> {
      await waitFor(() => ofType(log, 'config').length > 0, `${what}: a config message`);
      await sleep(grace);
    }

    function lastConfig(log: readonly ToWebview[]): Extract<ToWebview, { type: 'config' }> {
      const found = ofType(log, 'config').at(-1);
      assert.ok(found, 'a config message was posted');
      return found;
    }

    const OTHER = (): vscode.Uri => vscode.Uri.joinPath(workspaceFolder(), 'other.md');

    it('broadcasts the new config for any change, without re-rendering when nothing it affects changed', async () => {
      const { log } = await openRecorded(OTHER(), vscode.ViewColumn.Active, false);
      log.length = 0;

      await write('nav.maxDepth', 5, vscode.ConfigurationTarget.Global);
      await settleAfter(log, 'nav.maxDepth');

      assert.equal(lastConfig(log).ui.navMaxDepth, 5);
      assert.equal(ofType(log, 'render').length, 0, 'the document is not re-rendered');
      assert.equal(ofType(log, 'highlight').length, 0);
    });

    it('re-renders when mermaid.enabled changes', async () => {
      const { log } = await openRecorded(OTHER(), vscode.ViewColumn.Active, false);
      log.length = 0;

      await write('mermaid.enabled', false, vscode.ConfigurationTarget.Global);
      await waitFor(() => ofType(log, 'render').length > 0, 'a render after mermaid.enabled');
      await settleAfter(log, 'mermaid.enabled');
      assert.equal(lastConfig(log).ui.mermaid, false);

      log.length = 0;
      await write('mermaid.enabled', undefined, vscode.ConfigurationTarget.Global);
      await waitFor(() => ofType(log, 'render').length > 0, 'a render after mermaid.enabled is back on');
      await settleAfter(log, 'mermaid.enabled (on)');
      assert.equal(lastConfig(log).ui.mermaid, true);
    });

    it('re-renders when changes.mode changes', async () => {
      const { log } = await openRecorded(OTHER(), vscode.ViewColumn.Active, false);
      log.length = 0;

      await write('changes.mode', 'gutter', vscode.ConfigurationTarget.Global);
      await waitFor(() => ofType(log, 'render').length > 0, 'a render after changes.mode');
      await settleAfter(log, 'changes.mode');
      assert.equal(lastConfig(log).ui.changesMode, 'gutter');
    });

    it('re-renders when tasks.agentProgress changes', async () => {
      const { log } = await openRecorded(OTHER(), vscode.ViewColumn.Active, false);
      log.length = 0;

      await write('tasks.agentProgress', false, vscode.ConfigurationTarget.Global);
      await waitFor(() => ofType(log, 'render').length > 0, 'a render after tasks.agentProgress');
      await settleAfter(log, 'tasks.agentProgress');
      assert.equal(lastConfig(log).ui.agentProgress, false);
    });

    it('clears the highlight when search.syncSelection is turned off', async () => {
      const uri = OTHER();
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
      editor.selection = new vscode.Selection(2, 0, 2, 6); // "Opened"
      assert.equal(doc.getText(editor.selection), 'Opened', 'precondition: the selected text');

      const { log } = await openRecorded(uri, vscode.ViewColumn.Beside, true);
      await waitFor(() => ofType(log, 'highlight').some((m) => m.term === 'Opened'), 'the selection to be highlighted');
      log.length = 0;

      await write('search.syncSelection', false, vscode.ConfigurationTarget.Global);
      await waitFor(() => ofType(log, 'highlight').length > 0, 'the highlight to be cleared');
      const cleared = ofType(log, 'highlight').at(-1);
      assert.equal(cleared?.term, '');
      assert.equal(lastConfig(log).ui.navShow, true, 'the config is broadcast as well');
    });
  });
});
