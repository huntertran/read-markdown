import * as assert from 'node:assert/strict';
import { inspect } from 'node:util';
import type { FromWebview } from '../../src/protocol';
import { describeMessage, isRestorableScheme, parseFromWebview, uriScheme } from '../../src/preview/messages';

/** One valid sample per `FromWebview` member; the mapped type fails to compile if one is missing. */
const VALID: { [K in FromWebview['type']]: Extract<FromWebview, { type: K }>[] } = {
  ready: [{ type: 'ready' }],
  needBaseline: [
    { type: 'needBaseline', id: 0 },
    { type: 'needBaseline', id: 7 },
  ],
  revealLine: [
    { type: 'revealLine', line: 0 },
    { type: 'revealLine', line: 12.5 },
  ],
  openLink: [{ type: 'openLink', href: 'https://example.com/#x' }],
  updateSetting: [
    { type: 'updateSetting', key: 'nav.show', value: true },
    { type: 'updateSetting', key: 'body.fontSize', value: 16 },
    { type: 'updateSetting', key: 'theme.preset', value: 'sepia' },
    { type: 'updateSetting', key: 'nav.width', value: '' },
  ],
  openSettings: [{ type: 'openSettings' }],
  copy: [
    { type: 'copy', text: 'const a = 1;' },
    { type: 'copy', text: '' },
  ],
  showSource: [{ type: 'showSource' }, { type: 'showSource', line: 0 }, { type: 'showSource', line: 42 }],
  requestBlockSource: [{ type: 'requestBlockSource', start: 0, end: 3, docVersion: 7 }],
  editBlock: [
    { type: 'editBlock', start: 2, end: 5, docVersion: 1, text: 'new\ntext' },
    { type: 'editBlock', start: 2, end: 5, docVersion: 1, text: '' },
  ],
  toggleTask: [
    { type: 'toggleTask', line: 4, checked: true, docVersion: 2 },
    { type: 'toggleTask', line: 4, checked: false, docVersion: 2 },
  ],
  moveListItem: [{ type: 'moveListItem', starts: [0, 1, 2], end: 3, from: 0, to: 2, docVersion: 5 }],
};

describe('parseFromWebview: valid messages', () => {
  for (const [type, samples] of Object.entries(VALID)) {
    it(`accepts ${type}`, () => {
      for (const sample of samples) assert.equal(parseFromWebview(sample), sample, JSON.stringify(sample));
    });
  }

  it('returns the same object without stripping extra fields', () => {
    const m = { type: 'copy', text: 'x', extra: 1 };
    assert.equal(parseFromWebview(m), m);
  });

  it('accepts a message that went through structured clone / JSON', () => {
    const m: unknown = JSON.parse(JSON.stringify({ type: 'moveListItem', starts: [3, 5], end: 8, from: 1, to: 0, docVersion: 9 }));
    assert.deepEqual(parseFromWebview(m), m);
  });
});

describe('parseFromWebview: invalid input', () => {
  it('rejects non-objects', () => {
    for (const bad of [null, undefined, 'ready', 42, true, [], [{ type: 'ready' }], () => ({ type: 'ready' })]) {
      assert.equal(parseFromWebview(bad), undefined, inspect(bad));
    }
  });

  it('rejects a missing, non-string or unknown type', () => {
    for (const bad of [{}, { type: 1 }, { type: null }, { type: ['ready'] }, { type: 'nope' }, { type: 'READY' }, { type: 'toString' }, { type: '__proto__' }, { type: 'constructor' }]) {
      assert.equal(parseFromWebview(bad), undefined, JSON.stringify(bad));
    }
  });

  it('rejects wrong field types and missing fields', () => {
    const bad: unknown[] = [
      { type: 'needBaseline' },
      { type: 'needBaseline', id: '1' },
      { type: 'needBaseline', id: -1 },
      { type: 'needBaseline', id: 1.5 },
      { type: 'revealLine' },
      { type: 'revealLine', line: '3' },
      { type: 'openLink' },
      { type: 'openLink', href: 5 },
      { type: 'updateSetting', key: 'nav.show' },
      { type: 'updateSetting', value: true },
      { type: 'updateSetting', key: 3, value: true },
      { type: 'updateSetting', key: 'nav.show', value: {} },
      { type: 'updateSetting', key: 'nav.show', value: [1] },
      { type: 'updateSetting', key: 'nav.show', value: null },
      { type: 'updateSetting', key: 'body.fontSize', value: NaN },
      { type: 'updateSetting', key: 'body.fontSize', value: Infinity },
      { type: 'copy' },
      { type: 'copy', text: 12 },
      { type: 'copy', text: { toString: 'x' } },
      { type: 'showSource', line: '3' },
      { type: 'showSource', line: null },
      { type: 'requestBlockSource', start: 0, end: 1 },
      { type: 'requestBlockSource', start: '0', end: 1, docVersion: 1 },
      { type: 'editBlock', start: 0, end: 1, docVersion: 1 },
      { type: 'editBlock', start: 0, end: 1, docVersion: 1, text: 5 },
      { type: 'editBlock', start: 0, end: 1, text: 'x' },
      { type: 'toggleTask', line: 1, docVersion: 1 },
      { type: 'toggleTask', line: 1, checked: 'true', docVersion: 1 },
      { type: 'toggleTask', line: 1, checked: 1, docVersion: 1 },
      { type: 'toggleTask', checked: true, docVersion: 1 },
      { type: 'moveListItem', end: 3, from: 0, to: 1, docVersion: 1 },
      { type: 'moveListItem', starts: 'abc', end: 3, from: 0, to: 1, docVersion: 1 },
      { type: 'moveListItem', starts: [0, '1'], end: 3, from: 0, to: 1, docVersion: 1 },
      { type: 'moveListItem', starts: [0, -1], end: 3, from: 0, to: 1, docVersion: 1 },
      { type: 'moveListItem', starts: [0, 1], end: 3, from: 0, docVersion: 1 },
      { type: 'moveListItem', starts: [0, 1], end: 3, from: 0, to: 1 },
    ];
    for (const m of bad) assert.equal(parseFromWebview(m), undefined, JSON.stringify(m));
  });

  it('rejects NaN, Infinity, negative and fractional line numbers and indices', () => {
    for (const n of [NaN, Infinity, -Infinity, -1, -0.5, 1.5]) {
      const bad: unknown[] = [
        { type: 'showSource', line: n },
        { type: 'requestBlockSource', start: n, end: 1, docVersion: 1 },
        { type: 'requestBlockSource', start: 0, end: n, docVersion: 1 },
        { type: 'requestBlockSource', start: 0, end: 1, docVersion: n },
        { type: 'editBlock', start: n, end: 1, docVersion: 1, text: '' },
        { type: 'toggleTask', line: n, checked: true, docVersion: 1 },
        { type: 'toggleTask', line: 1, checked: true, docVersion: n },
        { type: 'moveListItem', starts: [0, n], end: 3, from: 0, to: 1, docVersion: 1 },
        { type: 'moveListItem', starts: [0, 1], end: n, from: 0, to: 1, docVersion: 1 },
        { type: 'moveListItem', starts: [0, 1], end: 3, from: n, to: 1, docVersion: 1 },
        { type: 'moveListItem', starts: [0, 1], end: 3, from: 0, to: n, docVersion: 1 },
      ];
      for (const m of bad) assert.equal(parseFromWebview(m), undefined, `${n}: ${JSON.stringify(m)}`);
    }
  });

  it('revealLine allows fractional scroll positions but not NaN, Infinity or negatives', () => {
    assert.ok(parseFromWebview({ type: 'revealLine', line: 0.25 }));
    for (const n of [NaN, Infinity, -Infinity, -1, -0.5]) assert.equal(parseFromWebview({ type: 'revealLine', line: n }), undefined, String(n));
  });
});

describe('describeMessage', () => {
  it('names the type without echoing payloads', () => {
    assert.equal(describeMessage({ type: 'copy', text: 12 }), 'type "copy"');
    assert.equal(describeMessage({ type: 'x'.repeat(100), text: 'secret' }), 'object without a usable type');
    assert.equal(describeMessage({ text: 'secret' }), 'object without a usable type');
    assert.equal(describeMessage(null), 'object');
    assert.equal(describeMessage('secret text'), 'string');
    assert.equal(describeMessage([1]), 'array');
  });
});

describe('restorable URI schemes', () => {
  it('extracts the scheme of a URI string', () => {
    assert.equal(uriScheme('file:///c%3A/docs/a.md'), 'file');
    assert.equal(uriScheme('VSCODE-REMOTE://ssh-remote%2Bhost/a.md'), 'vscode-remote');
    assert.equal(uriScheme('untitled:Untitled-1'), 'untitled');
    assert.equal(uriScheme('/just/a/path.md'), undefined);
    assert.equal(uriScheme(''), undefined);
    assert.equal(uriScheme(42), undefined);
    assert.equal(uriScheme(undefined), undefined);
  });

  it('allows only file, untitled and vscode-remote', () => {
    for (const ok of ['file', 'untitled', 'vscode-remote', 'FILE']) assert.equal(isRestorableScheme(ok), true, ok);
    for (const bad of ['http', 'https', 'command', 'vscode', 'vscode-userdata', 'vscode-vfs', 'git', 'data', 'javascript', 'vscode-remote2', '', undefined, null, 1]) {
      assert.equal(isRestorableScheme(bad), false, String(bad));
    }
  });

  it('rejects saved state URIs with other schemes', () => {
    assert.equal(isRestorableScheme(uriScheme('command:workbench.action.reloadWindow')), false);
    assert.equal(isRestorableScheme(uriScheme('https://example.com/a.md')), false);
    assert.equal(isRestorableScheme(uriScheme('not a uri')), false);
    assert.equal(isRestorableScheme(uriScheme('file:///a/b.md')), true);
  });
});
