/**
 * In-process concurrency guards for the lifecycle manager. Both rely on Bun's
 * single thread: the check and the claim run with no `await` between them, so a
 * claim is atomic with respect to every other caller.
 *
 *   - `singleFlight` COALESCES: a caller arriving while a task for the same key
 *     is in flight gets that task's promise, so the task runs once per burst.
 *   - `skipIfRunning` SKIPS: a caller arriving while the task is in flight is
 *     turned away with a fixed value and never sees the running task's result.
 */

export interface SingleFlight<K, V> {
  /**
   * Run `task` for `key`, or join the one already in flight. The task starts
   * synchronously; the key is cleared when it settles, fulfilled or rejected.
   */
  readonly run: (key: K, task: () => Promise<V>) => Promise<V>;
}

export const singleFlight = <K, V>(): SingleFlight<K, V> => {
  const inFlight = new Map<K, Promise<V>>();
  return {
    run: (key, task) => {
      const pending = inFlight.get(key);
      if (pending !== undefined) return pending;
      const flight = task().finally(() => {
        inFlight.delete(key);
      });
      inFlight.set(key, flight);
      return flight;
    },
  };
};

export interface SkipIfRunning<V> {
  /** Run `task`, or resolve to `whenBusy` without running it if one is in flight. */
  readonly run: (task: () => Promise<V>, whenBusy: V) => Promise<V>;
}

export const skipIfRunning = <V>(): SkipIfRunning<V> => {
  let running = false;
  return {
    run: async (task, whenBusy) => {
      if (running) return whenBusy;
      running = true;
      try {
        return await task();
      } finally {
        running = false;
      }
    },
  };
};
