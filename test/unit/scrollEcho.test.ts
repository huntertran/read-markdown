import * as assert from 'node:assert/strict';
import { EchoWindow, EditorScrollGuard, SCROLL_ECHO_MS } from '../../src/sync/scrollEcho';

/** A clock the test moves by hand. */
function clock(start = 1000): { now: () => number; advance(ms: number): void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

describe('EchoWindow', () => {
  it('is not active before it was ever started', () => {
    assert.equal(new EchoWindow(clock().now).active, false);
  });

  it('is active from the start until just before SCROLL_ECHO_MS, and over at exactly that time', () => {
    const c = clock();
    const w = new EchoWindow(c.now);
    w.start();
    assert.equal(w.active, true);
    c.advance(SCROLL_ECHO_MS - 1);
    assert.equal(w.active, true);
    c.advance(1);
    assert.equal(w.active, false);
  });

  it('restarts from the latest start', () => {
    const c = clock();
    const w = new EchoWindow(c.now);
    w.start();
    c.advance(200);
    w.start();
    c.advance(200);
    assert.equal(w.active, true, '400 ms after the first start, 200 ms after the second');
    c.advance(100);
    assert.equal(w.active, false);
  });

  it('takes its length from the constructor', () => {
    const c = clock();
    const w = new EchoWindow(c.now, 50);
    w.start();
    c.advance(49);
    assert.equal(w.active, true);
    c.advance(1);
    assert.equal(w.active, false);
  });

  it('uses the real clock by default', () => {
    const w = new EchoWindow();
    w.start();
    assert.equal(w.active, true);
  });
});

describe('EditorScrollGuard', () => {
  const editor = {};
  const other = {};

  function setup(): { guard: EditorScrollGuard<object>; c: ReturnType<typeof clock> } {
    const c = clock();
    return { guard: new EditorScrollGuard<object>(c.now), c };
  }

  describe('top line', () => {
    it('follows the first event of an editor that was never seen', () => {
      const { guard } = setup();
      assert.equal(guard.scrolled(editor, 0), true);
    });

    it('follows a changed top line and ignores an unchanged one (a multi-line edit fires the event too)', () => {
      const { guard } = setup();
      guard.scrolled(editor, 10);
      assert.equal(guard.scrolled(editor, 10), false);
      assert.equal(guard.scrolled(editor, 11), true);
      assert.equal(guard.scrolled(editor, 11), false);
      assert.equal(guard.scrolled(editor, 10), true);
    });

    it('compares the first event of a seeded editor with the seed', () => {
      const { guard } = setup();
      guard.seed(editor, 7);
      assert.equal(guard.scrolled(editor, 7), false);
      assert.equal(guard.scrolled(editor, 8), true);
    });

    it('seeding does not overwrite the line of an editor that is already known', () => {
      const { guard } = setup();
      guard.scrolled(editor, 20);
      guard.seed(editor, 5);
      assert.equal(guard.scrolled(editor, 20), false, 'still compared with 20');
      guard.seed(editor, 5);
      assert.equal(guard.scrolled(editor, 5), true);
    });

    it('keeps the editors apart', () => {
      const { guard } = setup();
      guard.scrolled(editor, 3);
      assert.equal(guard.scrolled(other, 3), true, 'first event of the other editor');
      assert.equal(guard.scrolled(editor, 3), false);
    });
  });

  describe('echo of a reveal', () => {
    it('ignores the events of an editor for SCROLL_ECHO_MS after a reveal, and follows again after it', () => {
      const { guard, c } = setup();
      guard.seed(editor, 0);
      guard.expectEcho(editor);
      assert.equal(guard.scrolled(editor, 40), false);
      c.advance(SCROLL_ECHO_MS - 1);
      assert.equal(guard.scrolled(editor, 41), false, 'smooth scrolling still reports inside the window');
      c.advance(1);
      assert.equal(guard.scrolled(editor, 42), true);
    });

    it('records the line of an ignored event, so the settled position is not taken for a scroll later', () => {
      const { guard, c } = setup();
      guard.seed(editor, 0);
      guard.expectEcho(editor);
      guard.scrolled(editor, 40);
      c.advance(SCROLL_ECHO_MS);
      assert.equal(guard.scrolled(editor, 40), false, 'same line as the echo left it at');
      assert.equal(guard.scrolled(editor, 41), true);
    });

    it('a second reveal restarts the window', () => {
      const { guard, c } = setup();
      guard.expectEcho(editor);
      c.advance(200);
      guard.expectEcho(editor);
      c.advance(200);
      assert.equal(guard.scrolled(editor, 1), false);
      c.advance(100);
      assert.equal(guard.scrolled(editor, 2), true);
    });

    it('does not ignore another editor of the same document', () => {
      const { guard } = setup();
      guard.expectEcho(editor);
      assert.equal(guard.scrolled(other, 9), true);
      assert.equal(guard.scrolled(editor, 9), false);
    });

    it('an unchanged line is ignored inside and outside the window alike', () => {
      const { guard, c } = setup();
      guard.seed(editor, 4);
      guard.expectEcho(editor);
      assert.equal(guard.scrolled(editor, 4), false);
      c.advance(SCROLL_ECHO_MS);
      assert.equal(guard.scrolled(editor, 4), false);
    });
  });

  // The loop the guards exist for: each side reports a scroll after it was moved by the other.
  describe('round trip with the preview', () => {
    it('editor scroll: the preview is moved once and its report is not sent back', () => {
      const { guard, c } = setup();
      const previewEcho = new EchoWindow(c.now);
      const reveals: number[] = [];
      const previewScrolls: number[] = [];
      const editorEvent = (line: number) => {
        if (!guard.scrolled(editor, line)) return;
        previewEcho.start();
        previewScrolls.push(line);
      };
      const previewReport = (line: number) => {
        if (previewEcho.active) return;
        guard.expectEcho(editor);
        reveals.push(line);
      };

      guard.seed(editor, 0);
      editorEvent(30);
      c.advance(50);
      previewReport(30);
      assert.deepEqual([previewScrolls, reveals], [[30], []]);
    });

    it('preview scroll: the editor is revealed once and its event is not sent back', () => {
      const { guard, c } = setup();
      const previewEcho = new EchoWindow(c.now);
      const reveals: number[] = [];
      const previewScrolls: number[] = [];
      const editorEvent = (line: number) => {
        if (!guard.scrolled(editor, line)) return;
        previewEcho.start();
        previewScrolls.push(line);
      };
      const previewReport = (line: number) => {
        if (previewEcho.active) return;
        guard.expectEcho(editor);
        reveals.push(line);
      };

      guard.seed(editor, 0);
      previewReport(55);
      c.advance(20);
      editorEvent(55);
      assert.deepEqual([previewScrolls, reveals], [[], [55]]);
      // Once both windows are over, the reader's next scroll goes through again, in either direction.
      c.advance(SCROLL_ECHO_MS);
      editorEvent(60);
      c.advance(SCROLL_ECHO_MS);
      previewReport(70);
      assert.deepEqual([previewScrolls, reveals], [[60], [55, 70]]);
    });
  });
});
