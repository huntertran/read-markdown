import * as assert from 'node:assert/strict';
import { type StyleSettings, buildCssVariables, cssValue, schemeForPreset } from '../../src/config/styles';

const base: StyleSettings = {
  preset: 'vscode',
  bodyFontFamily: '',
  bodyFontSize: 15,
  bodyLineHeight: 1.65,
  bodyMaxWidth: 860,
  bodyBackgroundColor: '',
  bodyTextColor: '',
  headingFontFamily: '',
  headingScale: 1,
  headingFontSizes: {},
  headingColors: {},
  headingHighlight: 'underline',
  headingHighlightColor: '',
  searchHighlightColor: '',
  searchCurrentHighlightColor: '',
  tableHeaderBackgroundColor: '',
  tableHeaderTextColor: '',
  navWidth: 260,
};

describe('buildCssVariables', () => {
  it('uses VS Code theme variables for the vscode preset', () => {
    const css = buildCssVariables(base);
    assert.match(css, /--rm-bg: var\(--vscode-editor-background\);/);
    assert.match(css, /--rm-font-size: 15px;/);
    assert.match(css, /--rm-max-width: 860px;/);
    assert.match(css, /--rm-h1-size: 2em;/);
  });

  it('applies overrides, scale and per-level values', () => {
    const css = buildCssVariables({
      ...base,
      preset: 'sepia',
      bodyBackgroundColor: '#123456',
      bodyMaxWidth: 0,
      headingScale: 1.5,
      headingFontSizes: { h2: '30px' },
      headingColors: { h1: 'red' },
    });
    assert.match(css, /--rm-bg: #123456;/);
    assert.match(css, /--rm-fg: #433422;/);
    assert.match(css, /--rm-max-width: none;/);
    assert.match(css, /--rm-h1-size: 3em;/);
    assert.match(css, /--rm-h2-size: 30px;/);
    assert.match(css, /--rm-h1-color: red;/);
  });

  it('clamps numbers and strips CSS injection characters', () => {
    const css = buildCssVariables({ ...base, bodyFontSize: 999, bodyTextColor: 'red; } body { display:none' });
    assert.match(css, /--rm-font-size: 40px;/);
    assert.doesNotMatch(css, /}\s*body/);
    assert.equal(cssValue('a;b{c}<d>'), 'abcd');
  });

  it('sets table header variables only when customized', () => {
    assert.doesNotMatch(buildCssVariables(base), /--rm-table-header/);
    const css = buildCssVariables({ ...base, tableHeaderBackgroundColor: '#2d4a6b', tableHeaderTextColor: 'white' });
    assert.match(css, /--rm-table-header-bg: #2d4a6b;/);
    assert.match(css, /--rm-table-header-fg: white;/);
  });

  it('maps presets to color schemes', () => {
    assert.equal(schemeForPreset('vscode'), 'auto');
    assert.equal(schemeForPreset('sepia'), 'light');
    assert.equal(schemeForPreset('high-contrast'), 'dark');
  });
});
