import * as assert from 'node:assert/strict';
import { parseColor, toHex } from '../../webview/color';

describe('color', () => {
  it('parses the computed color forms', () => {
    assert.deepEqual(parseColor('rgb(30, 30, 30)'), [30, 30, 30, 1]);
    assert.deepEqual(parseColor('rgba(255, 0, 0, 0.5)'), [255, 0, 0, 0.5]);
    assert.deepEqual(parseColor('rgb(10 20 30 / 25%)'), [10, 20, 30, 0.25]);
    assert.deepEqual(parseColor('color(srgb 1 0.5 0)'), [255, 127.5, 0, 1]);
    assert.deepEqual(parseColor('color(srgb 0 0 1 / 0.2)'), [0, 0, 255, 0.2]);
    assert.equal(parseColor('transparent'), undefined);
  });

  it('converts to #rrggbb', () => {
    assert.equal(toHex('rgb(30, 30, 30)'), '#1e1e1e');
    assert.equal(toHex('color(srgb 1 0.5 0)'), '#ff8000');
    assert.equal(toHex('nonsense'), '#000000');
  });

  it('drops alpha without a backdrop and composites over one', () => {
    assert.equal(toHex('rgba(255, 0, 0, 0.5)'), '#ff0000');
    assert.equal(toHex('rgba(255, 0, 0, 0.5)', 'rgb(0, 0, 255)'), '#800080');
    assert.equal(toHex('rgba(255, 255, 255, 0)', 'rgb(16, 32, 48)'), '#102030');
  });
});
