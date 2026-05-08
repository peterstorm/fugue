// createInMemoryJob — in-memory JobLike for tests and non-durable callers
// FR-003

import type { JobLike } from "./types.js";

export interface InMemoryJob<S, C> extends JobLike<S, C> {
  /** Exposed for test assertions */
  readonly events: readonly unknown[];
  readonly progress: number;
}

/**
 * Constructs an in-memory JobLike backed by a simple array event log and
 * mutable snapshot. Suitable for tests and one-shot (non-durable) runs.
 */
export const createInMemoryJob = <S, C>(initial: { state: S; context: C }): InMemoryJob<S, C> => {
  let snapshot = { ...initial };
  const eventLog: unknown[] = [];
  let currentProgress = 0;

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

    async appendEvent(event: unknown): Promise<void> {
      eventLog.push(event);
    },

    get events(): readonly unknown[] {
      return eventLog;
    },

    get progress(): number {
      return currentProgress;
    },
  };
};
