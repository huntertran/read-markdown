// Coalesces rapid writes of one value into a single trailing write. Used for state that changes
// every scroll frame but only needs to survive a reload. No DOM access, timers are injectable.

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const DEFAULT_TIMERS: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface DebouncedSaver<T> {
  /** Remembers `value`; it is written `delayMs` after the last call. */
  save(value: T): void;
  /** Writes the pending value now, if there is one. */
  flush(): void;
  hasPending(): boolean;
}

export function createDebouncedSaver<T>(write: (value: T) => void, delayMs: number, timers: Timers = DEFAULT_TIMERS): DebouncedSaver<T> {
  let handle: unknown;
  let pending: { value: T } | undefined;

  const flush = (): void => {
    if (handle !== undefined) {
      timers.clear(handle);
      handle = undefined;
    }
    const p = pending;
    pending = undefined;
    if (p) write(p.value);
  };

  return {
    save(value) {
      pending = { value };
      if (handle !== undefined) timers.clear(handle);
      handle = timers.set(flush, delayMs);
    },
    flush,
    hasPending: () => pending !== undefined,
  };
}
