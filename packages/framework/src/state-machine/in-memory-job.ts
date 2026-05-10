// createInMemoryJob — in-memory JobLike for tests and non-durable callers
// FR-003

import type { JobLike, RecordedEvent } from "./types.js";

export interface InMemoryJob<S, C> extends JobLike<S, C> {
  /**
   * Exposed for test assertions. Each entry is a `RecordedEvent` envelope
   * with `recordedAtMs` (wall-clock at append time) and `event` (the raw
   * domain event the runner passed to `appendEvent`).
   */
  readonly events: readonly RecordedEvent<unknown>[];
  readonly progress: number;
}

export interface InMemoryJobOptions {
  /**
   * Wall-clock source. Injected for deterministic tests. Default `Date.now`.
   */
  readonly now?: () => number;
}

/**
 * Constructs an in-memory JobLike backed by a simple array event log and
 * mutable snapshot. Suitable for tests and one-shot (non-durable) runs.
 */
export const createInMemoryJob = <S, C>(
  initial: { state: S; context: C },
  opts: InMemoryJobOptions = {},
): InMemoryJob<S, C> => {
  let snapshot = { ...initial };
  const eventLog: RecordedEvent<unknown>[] = [];
  let currentProgress = 0;
  const now = opts.now ?? Date.now;
  // Track last seen dedupKey so the runner can guarantee at-most-once delivery
  // when a transition is re-derived after a crash.
  let lastDedupKey: string | undefined;

  return {
    get data() {
      return { ...snapshot };
    },

    async updateData(d: { state: S; context: C }): Promise<void> {
      snapshot = { ...d };
    },

    async updateProgress(pct: number): Promise<void> {
      currentProgress = pct;
    },

    async appendEvent(event: unknown, dedupKey?: string): Promise<void> {
      // Skip the append if the same dedupKey was just observed — indicates the
      // runner re-derived the same transition (crash between appendEvent and
      // updateData).
      if (dedupKey !== undefined && dedupKey === lastDedupKey) return;
      eventLog.push({ recordedAtMs: now(), event });
      if (dedupKey !== undefined) lastDedupKey = dedupKey;
    },

    get events(): readonly RecordedEvent<unknown>[] {
      return eventLog;
    },

    get progress(): number {
      return currentProgress;
    },
  };
};
