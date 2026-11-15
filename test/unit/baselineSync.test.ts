import * as assert from 'node:assert/strict';
import { BaselineSync } from '../../src/preview/baselineSync';

describe('BaselineSync', () => {
  it('sends the HTML for a new baseline only once', () => {
    const sync = new BaselineSync();
    assert.equal(sync.claim(1), true);
    assert.equal(sync.claim(1), false);
    assert.equal(sync.claim(1), false);
  });

  it('sends the HTML again when the baseline changes', () => {
    const sync = new BaselineSync();
    sync.claim(1);
    assert.equal(sync.claim(2), true);
    assert.equal(sync.claim(2), false);
  });

  it('sends nothing without changes, and the HTML again once changes come back (the webview released it)', () => {
    const sync = new BaselineSync();
    sync.claim(1);
    assert.equal(sync.claim(undefined), false);
    assert.equal(sync.claim(1), true);
  });

  it('forget (webview loaded or reloaded) makes the next render carry the HTML', () => {
    const sync = new BaselineSync();
    sync.claim(1);
    sync.forget();
    assert.equal(sync.claim(1), true);
    assert.equal(sync.claim(1), false);
  });

  it('missing: a request for the held baseline makes the next render carry it', () => {
    const sync = new BaselineSync();
    sync.claim(4);
    assert.equal(sync.missing(4), true);
    assert.equal(sync.claim(4), true);
    assert.equal(sync.claim(4), false);
  });

  it('missing: a request for another id, or when nothing is held, is ignored', () => {
    const sync = new BaselineSync();
    assert.equal(sync.missing(1), false);
    sync.claim(2);
    assert.equal(sync.missing(1), false);
    assert.equal(sync.claim(2), false);
    sync.claim(undefined);
    assert.equal(sync.missing(2), false);
  });

  it('keeps one state per instance (one per panel)', () => {
    const a = new BaselineSync();
    const b = new BaselineSync();
    a.claim(1);
    assert.equal(b.claim(1), true);
    assert.equal(a.claim(1), false);
  });
});
