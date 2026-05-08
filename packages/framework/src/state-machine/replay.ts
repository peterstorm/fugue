// replayEvents — pure event-log fold for event-sourced replay
// FR-003 (event log), US6

import type { Machine } from "./types.js";

/**
 * Rebuild state by replaying a sequence of events through the pure
 * transition function starting from an initial checkpoint.
 *
 * This is purely functional — it calls no executor, performs no I/O.
 */
export const replayEvents = <S, E, C>(
  events: readonly E[],
  machine: Machine<S, E, C>,
  initial: { state: S; context: C },
): { state: S; context: C } => {
  let current = initial;

  for (const event of events) {
    current = machine.transition(current.state, event, current.context);
  }

  return current;
};
