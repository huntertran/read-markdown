import * as assert from 'node:assert/strict';
import { createDebouncedSaver, type Timers } from '../../webview/debouncedSaver';

/** Manual clock: timers fire only when the test advances time. */
function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const queue = new Map<number, { at: number; fn: () => void }>();
  const timers: Timers = {
    set(fn, ms) {
      const id = nextId++;
      queue.set(id, { at: now + ms, fn });
      return id;
    },
    clear(handle) {
      queue.delete(handle as number);
    },
  };
  return {
    timers,
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...queue]) {
        if (t.at <= now && queue.delete(id)) t.fn();
      }
    },
    pendingTimers: () => queue.size,
  };
}

describe('debouncedSaver', () => {
  it('writes only the last value once the delay has passed', () => {
    const clock = fakeTimers();
    const writes: number[] = [];
    const saver = createDebouncedSaver((v: number) => writes.push(v), 200, clock.timers);
    saver.save(1);
    clock.advance(100);
    saver.save(2);
    clock.advance(150); // 250 ms after the first call, 150 after the second
    assert.deepEqual(writes, []);
    saver.save(3);
    clock.advance(200);
    assert.deepEqual(writes, [3]);
    assert.equal(saver.hasPending(), false);
  });

  it('keeps pushing the write back while calls keep coming', () => {
    const clock = fakeTimers();
    const writes: number[] = [];
    const saver = createDebouncedSaver((v: number) => writes.push(v), 200, clock.timers);
    for (let i = 0; i < 50; i++) {
      saver.save(i);
      clock.advance(16);
    }
    assert.deepEqual(writes, []);
    clock.advance(200);
    assert.deepEqual(writes, [49]);
  });

  it('flush writes the pending value immediately and cancels the timer', () => {
    const clock = fakeTimers();
    const writes: number[] = [];
    const saver = createDebouncedSaver((v: number) => writes.push(v), 200, clock.timers);
    saver.save(5);
    assert.equal(saver.hasPending(), true);
    saver.flush();
    assert.deepEqual(writes, [5]);
    assert.equal(clock.pendingTimers(), 0);
    clock.advance(1000);
    assert.deepEqual(writes, [5]);
  });

  it('flush without a pending value writes nothing', () => {
    const writes: number[] = [];
    const saver = createDebouncedSaver((v: number) => writes.push(v), 200, fakeTimers().timers);
    saver.flush();
    assert.deepEqual(writes, []);
  });

  it('writing 0 is not mistaken for nothing pending', () => {
    const writes: number[] = [];
    const saver = createDebouncedSaver((v: number) => writes.push(v), 200, fakeTimers().timers);
    saver.save(0);
    assert.equal(saver.hasPending(), true);
    saver.flush();
    assert.deepEqual(writes, [0]);
  });

  it('a patch applied at write time keeps newer values of other fields', () => {
    // Mirrors main.ts: write = patchState({ scrollLine }) merging into the current state.
    const clock = fakeTimers();
    let state: { scrollLine?: number; collapsed?: string[] } = {};
    const patch = (p: Partial<typeof state>) => (state = { ...state, ...p });
    const saver = createDebouncedSaver((scrollLine: number) => patch({ scrollLine }), 200, clock.timers);
    saver.save(12);
    patch({ collapsed: ['a'] }); // another module writes while the scroll line is pending
    clock.advance(200);
    assert.deepEqual(state, { scrollLine: 12, collapsed: ['a'] });
  });

  it('works with the real timers by default', async () => {
    const writes: number[] = [];
    const saver = createDebouncedSaver((v: number) => writes.push(v), 5);
    saver.save(1);
    saver.save(2);
    await new Promise((r) => setTimeout(r, 40));
    assert.deepEqual(writes, [2]);
  });
});
